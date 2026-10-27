'use strict';

const crypto = require('node:crypto');

const ACTION_RE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)+$/;
const TYPES = new Set(['user','service','worker','operator','tenant','project','episode','artifact','workflow','release','provider','credential','job','export','import','system']);
const EFFECTS = new Set(['ALLOW','DENY']);
const CONDITION_OPS = new Set(['eq','neq','in','not_in','exists','starts_with']);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function hash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function sign(value, secret) { return crypto.createHmac('sha256', secret).update(canonical(value)).digest('hex'); }
function stableBucket(value) { return Number.parseInt(hash(value).slice(0, 8), 16) % 100; }
function pathValue(object, path) { return String(path).split('.').reduce((current, key) => current == null ? undefined : current[key], object); }

const SUBJECT_FIELDS = new Set(['type','id','roles','attributes','tenantId']);
const RESOURCE_FIELDS = new Set(['type','id','tenantId','projectId','attributes']);
const RULE_FIELDS = new Set(['id','effect','priority','subject','resource','actions','conditions','reason']);
const CONDITION_FIELDS = new Set(['field','op','value']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(`${name} must be an object`), { code: 'POLICY_SCHEMA_INVALID' });
}
function assertKnownFields(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw Object.assign(new Error(`${name} contains unknown field: ${key}`), { code: 'POLICY_UNKNOWN_FIELD' });
}
function validateMatcher(value, allowed, name) {
  assertObject(value, name); assertKnownFields(value, allowed, name);
  if (value.type != null && !TYPES.has(String(value.type))) throw Object.assign(new Error(`${name}.type is invalid`), { code: 'POLICY_SCHEMA_INVALID' });
  if (value.roles != null && (!Array.isArray(value.roles) || value.roles.some((x) => typeof x !== 'string'))) throw Object.assign(new Error(`${name}.roles must be string[]`), { code: 'POLICY_SCHEMA_INVALID' });
}
function validatePolicyDocument(document) {
  assertObject(document, 'policy');
  assertKnownFields(document, new Set(['schemaVersion','name','protectedActions','defaults','rules','metadata']), 'policy');
  if (Number(document.schemaVersion) !== 1) throw Object.assign(new Error('schemaVersion must be 1'), { code: 'POLICY_SCHEMA_VERSION_UNSUPPORTED' });
  if (typeof document.name !== 'string' || !document.name.trim()) throw Object.assign(new Error('name is required'), { code: 'POLICY_SCHEMA_INVALID' });
  if (!Array.isArray(document.protectedActions)) throw Object.assign(new Error('protectedActions must be an array'), { code: 'POLICY_SCHEMA_INVALID' });
  for (const action of document.protectedActions) if (!ACTION_RE.test(String(action))) throw Object.assign(new Error(`invalid action: ${action}`), { code: 'POLICY_SCHEMA_INVALID' });
  if (document.defaults != null) { assertObject(document.defaults, 'defaults'); assertKnownFields(document.defaults, new Set(['protected','unprotected']), 'defaults'); for (const key of ['protected','unprotected']) if (document.defaults[key] != null && !EFFECTS.has(document.defaults[key])) throw Object.assign(new Error(`defaults.${key} must be ALLOW or DENY`), { code: 'POLICY_SCHEMA_INVALID' }); }
  if (!Array.isArray(document.rules)) throw Object.assign(new Error('rules must be an array'), { code: 'POLICY_SCHEMA_INVALID' });
  const ids = new Set();
  for (const rule of document.rules) {
    assertObject(rule, 'rule'); assertKnownFields(rule, RULE_FIELDS, 'rule');
    if (!rule.id || ids.has(rule.id)) throw Object.assign(new Error(`rule id must be unique: ${rule.id}`), { code: 'POLICY_SCHEMA_INVALID' }); ids.add(rule.id);
    if (!EFFECTS.has(rule.effect)) throw Object.assign(new Error(`rule ${rule.id} has invalid effect`), { code: 'POLICY_SCHEMA_INVALID' });
    if (!Number.isSafeInteger(Number(rule.priority))) throw Object.assign(new Error(`rule ${rule.id} priority must be an integer`), { code: 'POLICY_SCHEMA_INVALID' });
    if (!Array.isArray(rule.actions) || !rule.actions.length || rule.actions.some((a) => !ACTION_RE.test(String(a)))) throw Object.assign(new Error(`rule ${rule.id} actions are invalid`), { code: 'POLICY_SCHEMA_INVALID' });
    if (rule.subject) validateMatcher(rule.subject, SUBJECT_FIELDS, `rule ${rule.id}.subject`);
    if (rule.resource) validateMatcher(rule.resource, RESOURCE_FIELDS, `rule ${rule.id}.resource`);
    if (rule.conditions != null) {
      if (!Array.isArray(rule.conditions)) throw Object.assign(new Error(`rule ${rule.id}.conditions must be an array`), { code: 'POLICY_SCHEMA_INVALID' });
      for (const condition of rule.conditions) { assertObject(condition, 'condition'); assertKnownFields(condition, CONDITION_FIELDS, 'condition'); if (!CONDITION_OPS.has(condition.op)) throw Object.assign(new Error(`rule ${rule.id} condition op is invalid`), { code: 'POLICY_SCHEMA_INVALID' }); if (typeof condition.field !== 'string' || !condition.field) throw Object.assign(new Error(`rule ${rule.id} condition field is required`), { code: 'POLICY_SCHEMA_INVALID' }); }
    }
  }
  return JSON.parse(JSON.stringify(document));
}

function matcherMatches(matcher, value) {
  if (!matcher) return true;
  for (const key of Object.keys(matcher)) {
    if (key === 'attributes') { if (!matcher.attributes || typeof matcher.attributes !== 'object') return false; for (const [attribute, expected] of Object.entries(matcher.attributes)) if (canonical(pathValue(value.attributes || {}, attribute)) !== canonical(expected)) return false; continue; }
    if (key === 'roles') { const actual = new Set(Array.isArray(value.roles) ? value.roles.map(String) : []); if (!matcher.roles.every((role) => actual.has(String(role)))) return false; continue; }
    const actual = value[key]; const expected = matcher[key];
    if (expected === '*') continue;
    if (Array.isArray(expected)) { if (!expected.some((item) => canonical(item) === canonical(actual))) return false; }
    else if (canonical(actual) !== canonical(expected)) return false;
  }
  return true;
}
function conditionsMatch(conditions, input) {
  for (const condition of conditions || []) {
    const actual = pathValue(input, condition.field); const expected = condition.value;
    if (condition.op === 'exists' && (actual == null) !== !Boolean(expected)) return false;
    if (condition.op === 'eq' && canonical(actual) !== canonical(expected)) return false;
    if (condition.op === 'neq' && canonical(actual) === canonical(expected)) return false;
    if (condition.op === 'in' && (!Array.isArray(expected) || !expected.some((x) => canonical(x) === canonical(actual)))) return false;
    if (condition.op === 'not_in' && Array.isArray(expected) && expected.some((x) => canonical(x) === canonical(actual))) return false;
    if (condition.op === 'starts_with' && (typeof actual !== 'string' || !actual.startsWith(String(expected)))) return false;
  }
  return true;
}

class PolicyEngine {
  constructor({ pool, logger = console, signingSecret = process.env.FORGE_POLICY_DECISION_SIGNING_SECRET, cacheTtlMs = 30000 } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pool is required');
    this.pool = pool; this.logger = logger; this.signingSecret = signingSecret || null; this.cacheTtlMs = Math.max(1000, Number(cacheTtlMs)); this.cache = new Map();
  }

  async validate(document) { try { const normalized = validatePolicyDocument(document); return { valid: true, normalized, canonicalHash: hash(normalized), ruleCount: normalized.rules.length }; } catch (error) { return { valid: false, code: error.code || 'POLICY_SCHEMA_INVALID', error: error.message }; } }

  async createPolicy({ tenantId, name, document, actor }) {
    const validation = await this.validate(document); if (!validation.valid) throw Object.assign(new Error(validation.error), { code: validation.code });
    const client = await this.pool.connect(); const id = `policy:${crypto.randomUUID()}`;
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`policy:${tenantId}:${name}`]);
      await client.query(`INSERT INTO forge_policy_documents(id,tenant_id,name,current_version,state,created_by) VALUES($1,$2,$3,1,'ACTIVE',$4)`, [id, tenantId, name, actor]);
      await client.query(`INSERT INTO forge_policy_versions(id,policy_id,version,schema_version,document,canonical_hash,created_by) VALUES($1,$2,1,1,$3::jsonb,$4,$5)`, [`${id}:v1`, id, JSON.stringify(validation.normalized), validation.canonicalHash, actor]);
      await client.query(`INSERT INTO forge_policy_operator_audit(id,tenant_id,actor,action,policy_id,version,details) VALUES($1,$2,$3,'POLICY_CREATED',$4,1,$5::jsonb)`, [crypto.randomUUID(), tenantId, actor, id, JSON.stringify({ canonicalHash: validation.canonicalHash })]);
      await client.query('COMMIT'); this.invalidate(tenantId); return { id, version: 1, canonicalHash: validation.canonicalHash };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async createVersion({ tenantId, policyId, expectedVersion, document, actor }) {
    const validation = await this.validate(document); if (!validation.valid) throw Object.assign(new Error(validation.error), { code: validation.code });
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const row = (await client.query('SELECT * FROM forge_policy_documents WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [policyId, tenantId])).rows[0]; if (!row) throw Object.assign(new Error('Policy not found'), { code: 'NOT_FOUND', statusCode: 404 }); if (Number(row.current_version) !== Number(expectedVersion)) throw Object.assign(new Error('Policy changed concurrently'), { code: 'POLICY_VERSION_CONFLICT', statusCode: 409 }); const next = Number(row.current_version) + 1; await client.query(`INSERT INTO forge_policy_versions(id,policy_id,version,schema_version,document,canonical_hash,created_by) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)`, [`${policyId}:v${next}`, policyId, next, JSON.stringify(validation.normalized), validation.canonicalHash, actor]); await client.query('UPDATE forge_policy_documents SET current_version=$2,updated_at=now() WHERE id=$1', [policyId, next]); await client.query(`INSERT INTO forge_policy_operator_audit(id,tenant_id,actor,action,policy_id,version,details) VALUES($1,$2,$3,'POLICY_VERSION_CREATED',$4,$5,$6::jsonb)`, [crypto.randomUUID(), tenantId, actor, policyId, next, JSON.stringify({ previousVersion: expectedVersion, canonicalHash: validation.canonicalHash })]); await client.query('COMMIT'); this.invalidate(tenantId); return { id: policyId, version: next, canonicalHash: validation.canonicalHash }; } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async activateBundle({ tenantId, bundleId, expectedEpoch, versions, actor, rolloutPercent = 100, rollbackToEpoch = null }) {
    if (!Array.isArray(versions) || !versions.length) throw Object.assign(new Error('versions must be non-empty'), { code: 'POLICY_BUNDLE_INVALID' });
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const bundle=(await client.query('SELECT * FROM forge_policy_bundles WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[bundleId,tenantId])).rows[0]; if(!bundle)throw Object.assign(new Error('Policy bundle not found'),{code:'NOT_FOUND',statusCode:404}); const current=Number(bundle.current_epoch); if(expectedEpoch!=null&&current!==Number(expectedEpoch))throw Object.assign(new Error('Policy activation epoch changed concurrently'),{code:'POLICY_EPOCH_CONFLICT',statusCode:409}); const epoch=current+1; const snapshot={epoch,versions,rolloutPercent:Number(rolloutPercent),rollbackToEpoch}; await client.query(`INSERT INTO forge_policy_activation_epochs(bundle_id,tenant_id,epoch,versions,rollout_percent,created_by,previous_epoch) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)`,[bundleId,tenantId,epoch,JSON.stringify(versions),Number(rolloutPercent),actor,current||null]); await client.query(`UPDATE forge_policy_bundles SET current_epoch=$2,active_versions=$3::jsonb,rollout_percent=$4,updated_at=now() WHERE id=$1`,[bundleId,epoch,JSON.stringify(versions),Number(rolloutPercent)]); await client.query(`INSERT INTO forge_policy_operator_audit(id,tenant_id,actor,action,bundle_id,version,details) VALUES($1,$2,$3,$4,$5,NULL,$6::jsonb)`,[crypto.randomUUID(),tenantId,actor,rollbackToEpoch?'POLICY_ROLLBACK':'POLICY_ACTIVATED',bundleId,JSON.stringify(snapshot)]); await client.query('COMMIT'); this.invalidate(tenantId); return snapshot; } catch(error){try{await client.query('ROLLBACK')}catch{}throw error}finally{client.release()}
  }

  invalidate(tenantId) { for (const key of this.cache.keys()) if (key.startsWith(`${tenantId}:`)) this.cache.delete(key); }

  async _loadActive(tenantId) {
    const epochRow=(await this.pool.query(`SELECT COALESCE(max(current_epoch),0) epoch,COALESCE(max(rollout_percent),100) rollout_percent FROM forge_policy_bundles WHERE tenant_id=$1 AND state='ACTIVE'`,[tenantId])).rows[0]; const epoch=Number(epochRow?.epoch||0); const bundles=(await this.pool.query(`SELECT id,active_versions,rollout_percent,current_epoch FROM forge_policy_bundles WHERE tenant_id=$1 AND state='ACTIVE' ORDER BY priority DESC,id`,[tenantId])).rows; const versions=[]; for(const bundle of bundles){for(const ref of (bundle.active_versions||[])){const row=(await this.pool.query(`SELECT v.*,d.name FROM forge_policy_versions v JOIN forge_policy_documents d ON d.id=v.policy_id WHERE v.id=$1 AND d.tenant_id=$2`,[ref.id||ref,tenantId])).rows[0]; if(row)versions.push({bundle,row,rolloutPercent:Number(bundle.rollout_percent||100)});}} return {epoch,bundles,versions};
  }

  async _activeFor(tenantId, subjectId) {
    const key=`${tenantId}:${subjectId}`; const active=await this._loadActive(tenantId); const cached=this.cache.get(key); if(cached&&cached.epoch===active.epoch&&cached.expiresAt>Date.now()) return cached.versions;
    const filtered=active.versions.filter((item)=>stableBucket(`${tenantId}:${subjectId}:${item.bundle.id}:${item.bundle.current_epoch}`)<item.rolloutPercent); this.cache.set(key,{epoch:active.epoch,expiresAt:Date.now()+this.cacheTtlMs,versions:filtered}); return filtered;
  }

  async evaluate({ tenantId, subject, resource, action, attributes = {}, explain = false }) {
    if (!tenantId || !subject?.id || !subject?.type || !resource?.type || !ACTION_RE.test(String(action))) throw Object.assign(new Error('Malformed policy evaluation request'), { code: 'POLICY_EVALUATION_INVALID' });
    if (String(subject.tenantId || tenantId) !== String(tenantId) || String(resource.tenantId || tenantId) !== String(tenantId)) throw Object.assign(new Error('Cross-tenant policy evaluation rejected'), { code: 'TENANT_ISOLATION', statusCode: 403 });
    const versions=await this._activeFor(tenantId,String(subject.id)); const candidates=[];
    for(const item of versions){const doc=item.row.document; const protectedAction=doc.protectedActions.includes(action); for(const rule of doc.rules){if(!rule.actions.includes(action)&&!rule.actions.includes('*'))continue; if(!matcherMatches(rule.subject,subject)||!matcherMatches(rule.resource,resource)||!conditionsMatch(rule.conditions,{subject,resource,action,...attributes}))continue; const specificity=(rule.subject?Object.keys(rule.subject).length:0)+(rule.resource?Object.keys(rule.resource).length:0)+(rule.conditions?.length||0); candidates.push({effect:rule.effect,priority:Number(rule.priority),specificity,id:rule.id,policyId:item.row.policy_id,version:Number(item.row.version),reason:rule.reason||null,protectedAction});}}
    candidates.sort((a,b)=>b.priority-a.priority||b.specificity-a.specificity||((a.effect==='DENY'?0:1)-(b.effect==='DENY'?0:1))||a.id.localeCompare(b.id)||a.policyId.localeCompare(b.policyId));
    const protectedByDocument=versions.some(({row})=>row.document.protectedActions.includes(action)); const protectedOperation=protectedByDocument || ['release.','provider.','credential.','artifact.','workflow.','runner.','export.','import.'].some((prefix)=>String(action).startsWith(prefix));
    let decision=protectedOperation?'DENY':'ALLOW'; let reason='DEFAULT'; if(candidates[0]){decision=candidates[0].effect;reason=candidates[0].reason||`RULE:${candidates[0].id}`;}
    const emergency=(await this.pool.query(`SELECT reason,expires_at FROM forge_policy_emergency_denies WHERE tenant_id=$1 AND revoked_at IS NULL AND expires_at>now() AND (action='*' OR action=$2) AND (resource_type='*' OR resource_type=$3) ORDER BY created_at DESC LIMIT 1`,[tenantId,action,resource.type])).rows[0]; if(emergency){decision='DENY';reason=`EMERGENCY:${emergency.reason}`;}
    const evidence={tenantId,subject:{type:subject.type,id:subject.id},resource:{type:resource.type,id:resource.id||null,projectId:resource.projectId||null},action,decision,reason,protectedOperation,epoch:Math.max(0,...versions.map(({bundle})=>Number(bundle.current_epoch||0))),candidates:candidates.map(({effect,priority,specificity,id,policyId,version})=>({effect,priority,specificity,id,policyId,version})),evaluatedAt:new Date().toISOString()};
    if(!this.signingSecret) throw Object.assign(new Error('Policy decision signing secret is not configured'),{code:'POLICY_SIGNING_NOT_CONFIGURED',statusCode:503});
    const signature=sign(evidence,this.signingSecret); const decisionId=crypto.randomUUID(); await this.pool.query(`INSERT INTO forge_policy_decisions(id,tenant_id,epoch,subject,resource,action,decision,reason,evidence,signature) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,$10)`,[decisionId,tenantId,evidence.epoch,JSON.stringify(evidence.subject),JSON.stringify(evidence.resource),action,decision,reason,JSON.stringify(evidence),signature]); return {decision,reason,decisionId,signature,evidence,candidates:explain?candidates:undefined};
  }

  async emergencyDeny({tenantId,action='*',resourceType='*',reason,expiresAt,actor}) { if(!reason||!expiresAt)throw Object.assign(new Error('reason and expiresAt are required'),{code:'POLICY_EMERGENCY_INVALID'}); const id=crypto.randomUUID(); await this.pool.query(`INSERT INTO forge_policy_emergency_denies(id,tenant_id,action,resource_type,reason,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,tenantId,action,resourceType,reason,expiresAt,actor]); this.invalidate(tenantId); return{id}; }

  async listDecisions({tenantId,limit=50}) { return (await this.pool.query(`SELECT id,epoch,subject,resource,action,decision,reason,evidence,signature,created_at FROM forge_policy_decisions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`,[tenantId,Math.min(200,Math.max(1,Number(limit)))] )).rows; }
}

module.exports={PolicyEngine,validatePolicyDocument,canonical,hash,sign};
