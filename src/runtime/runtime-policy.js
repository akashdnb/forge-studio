'use strict';

const crypto = require('node:crypto');

const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|DATABASE_URL)/i;
const RUNTIME_KEYS = {
  PORT: { type: 'integer', min: 1, max: 65535, default: 8080, hotReloadable: false },
  HOST: { type: 'string', default: '0.0.0.0', hotReloadable: false },
  PG_POOL_MAX: { type: 'integer', min: 1, max: 100, default: 10, hotReloadable: true },
  FORGE_RATE_LIMIT_PER_MINUTE: { type: 'integer', min: 1, max: 100000, default: 120, hotReloadable: true },
  FORGE_RECONCILIATION_INTERVAL_MS: { type: 'integer', min: 60000, max: 86400000, default: 300000, hotReloadable: true },
  FORGE_USAGE_RECOVERY_INTERVAL_MS: { type: 'integer', min: 10000, max: 86400000, default: 60000, hotReloadable: true },
  FORGE_GITHUB_ACTIONS_ENABLED: { type: 'boolean', default: false, hotReloadable: true },
  FORGE_RUNNER_CALLBACK_TOKEN: { type: 'secret-ref', hotReloadable: true },
  API_BEARER_TOKEN: { type: 'secret-ref', hotReloadable: true },
  FORGE_AUTH_SIGNING_SECRET: { type: 'secret-ref', hotReloadable: false },
  FORGE_SECRET_ENCRYPTION_KEY: { type: 'secret-ref', hotReloadable: false }
};

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function fingerprint(value) { return sha256(JSON.stringify(stable(value))); }
function redact(value, key = '') {
  if (SECRET_ENV_RE.test(key)) return '[REDACTED]';
  if (typeof value === 'string' && (value.length > 1024 || /^(bearer\s+|AKIA|gh[pousr]_)/i.test(value))) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
function parseValue(name, value, spec) {
  if (value === undefined || value === null || value === '') return spec.default;
  if (spec.type === 'boolean') {
    if (!['true', 'false'].includes(String(value).toLowerCase())) throw new TypeError(`${name} must be true or false`);
    return String(value).toLowerCase() === 'true';
  }
  if (spec.type === 'integer') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) throw new TypeError(`${name} must be an integer between ${spec.min} and ${spec.max}`);
    return n;
  }
  if (spec.type === 'secret-ref') return String(value);
  return String(value);
}
function normalizeMasterKey(input) {
  const raw = String(input || '');
  try { const decoded = Buffer.from(raw, 'base64'); if (decoded.length === 32) return decoded; } catch {}
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length !== 32) throw new TypeError('FORGE_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key or exactly 32 UTF-8 bytes');
  return bytes;
}
function validateRuntimeConfig(env = process.env, { requirePersistence = false } = {}) {
  const config = {};
  const issues = [];
  for (const [name, spec] of Object.entries(RUNTIME_KEYS)) {
    try { config[name] = parseValue(name, env[name], spec); } catch (error) { issues.push({ key: name, code: 'INVALID_VALUE', message: error.message }); }
  }
  if (requirePersistence && !env.DATABASE_URL) issues.push({ key: 'DATABASE_URL', code: 'MISSING', message: 'DATABASE_URL is required for production persistence' });
  if (env.FORGE_AUTH_SIGNING_SECRET && env.FORGE_AUTH_SIGNING_SECRET.length < 32) issues.push({ key: 'FORGE_AUTH_SIGNING_SECRET', code: 'WEAK_SECRET', message: 'signing secret must be at least 32 characters' });
  if (env.FORGE_SECRET_ENCRYPTION_KEY) {
    try { normalizeMasterKey(env.FORGE_SECRET_ENCRYPTION_KEY); } catch (error) { issues.push({ key: 'FORGE_SECRET_ENCRYPTION_KEY', code: 'INVALID_KEY', message: error.message }); }
  }
  return { ok: issues.length === 0, config: redact(config), issues, hotReloadable: Object.fromEntries(Object.entries(RUNTIME_KEYS).map(([k, v]) => [k, v.hotReloadable])) };
}
class SecretCipher {
  constructor(key) { this.key = normalizeMasterKey(key); }
  encrypt(plaintext) {
    const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return { ciphertext, nonce, authTag: cipher.getAuthTag() };
  }
  decrypt(record) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.nonce));
    decipher.setAuthTag(Buffer.from(record.auth_tag || record.authTag));
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext)), decipher.final()]).toString('utf8');
  }
}
function scopeKey({ scopeType = 'SYSTEM', scopeId = 'global', namespace = 'default' } = {}) { return `${scopeType}:${scopeId}:${namespace}`; }
function rolloutBucket(input) { return Number.parseInt(sha256(input).slice(0, 8), 16) % 100; }
function matchesTarget(targets, context) {
  if (!targets || typeof targets !== 'object') return false;
  if (Array.isArray(targets.tenantIds) && targets.tenantIds.includes(context.tenantId)) return true;
  if (Array.isArray(targets.projectIds) && targets.projectIds.includes(context.projectId)) return true;
  if (Array.isArray(targets.actorIds) && targets.actorIds.includes(context.actorId)) return true;
  if (Array.isArray(targets.providers) && targets.providers.includes(context.provider)) return true;
  return false;
}
function evaluateFlag(flag, context = {}) {
  if (!flag || flag.kill_switch || !flag.enabled) return false;
  if (matchesTarget(flag.targets, context)) return true;
  const percent = Math.max(0, Math.min(100, Number(flag.rollout_percent ?? flag.rolloutPercent ?? 0)));
  if (percent === 0) return false;
  if (percent === 100) return true;
  return rolloutBucket(`${flag.key || flag.flag}:${context.tenantId || ''}:${context.projectId || ''}:${context.actorId || ''}`) < percent;
}
class RuntimePolicyStore {
  constructor({ pool, secretCipher = null, logger = console } = {}) { if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required'); this.pool = pool; this.secretCipher = secretCipher; this.logger = logger; }
  async audit({ tenantId = null, projectId = null, actor = 'system', action, targetType, targetId, details = {} }) {
    await this.pool.query('INSERT INTO runtime_config_audit(tenant_id,project_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [tenantId, projectId, actor, action, targetType, targetId, JSON.stringify(redact(details))]);
  }
  async publishPolicy({ tenantId = null, projectId = null, provider = null, namespace = 'default', config = {}, actor = 'system', expectedVersion = null, activate = true } = {}) {
    const scopeType = provider ? 'PROVIDER' : projectId ? 'PROJECT' : tenantId ? 'TENANT' : 'SYSTEM';
    const scopeId = provider || projectId || tenantId || 'global';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scopeKey({ scopeType, scopeId, namespace })]);
      const head = (await client.query('SELECT current_version FROM runtime_policy_heads WHERE scope_type=$1 AND scope_id=$2 AND namespace=$3 FOR UPDATE', [scopeType, scopeId, namespace])).rows[0];
      const current = Number(head?.current_version || 0);
      if (expectedVersion !== null && Number(expectedVersion) !== current) throw Object.assign(new Error(`stale runtime policy version: expected ${expectedVersion}, current ${current}`), { code: 'STALE_POLICY_VERSION', statusCode: 409 });
      const version = current + 1;
      await client.query("INSERT INTO runtime_policy_versions(scope_type,scope_id,namespace,version,state,config,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)", [scopeType, scopeId, namespace, version, activate ? 'ACTIVE' : 'DRAFT', JSON.stringify(config), actor]);
      await client.query("INSERT INTO runtime_policy_heads(scope_type,scope_id,namespace,current_version) VALUES($1,$2,$3,$4) ON CONFLICT(scope_type,scope_id,namespace) DO UPDATE SET current_version=EXCLUDED.current_version,revision=runtime_policy_heads.revision+1,updated_at=now()", [scopeType, scopeId, namespace, version]);
      if (activate && current > 0) await client.query("UPDATE runtime_policy_versions SET state='RETIRED',retired_at=now() WHERE scope_type=$1 AND scope_id=$2 AND namespace=$3 AND version=$4", [scopeType, scopeId, namespace, current]);
      await client.query('COMMIT');
      await this.audit({ tenantId, projectId, actor, action: 'POLICY_PUBLISHED', targetType: 'runtime_policy', targetId: `${scopeType}:${scopeId}:${namespace}:${version}`, details: { scopeType, scopeId, namespace, version } });
      return { scopeType, scopeId, namespace, version, config: redact(config) };
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async rollbackPolicy({ scopeType, scopeId, namespace = 'default', targetVersion, actor = 'system', tenantId = null, projectId = null } = {}) {
    const target = (await this.pool.query('SELECT config FROM runtime_policy_versions WHERE scope_type=$1 AND scope_id=$2 AND namespace=$3 AND version=$4', [scopeType, scopeId, namespace, targetVersion])).rows[0];
    if (!target) throw Object.assign(new Error('runtime policy version not found'), { code: 'NOT_FOUND', statusCode: 404 });
    const head = (await this.pool.query('SELECT current_version FROM runtime_policy_heads WHERE scope_type=$1 AND scope_id=$2 AND namespace=$3', [scopeType, scopeId, namespace])).rows[0];
    return this.publishPolicy({ tenantId, projectId, namespace, config: target.config, actor, expectedVersion: Number(head?.current_version || 0) });
  }
  async getEffective({ tenantId = null, projectId = null, provider = null, namespace = 'default' } = {}) {
    const scopes = [['SYSTEM', 'global'], ...(tenantId ? [['TENANT', tenantId]] : []), ...(projectId ? [['PROJECT', projectId]] : []), ...(provider ? [['PROVIDER', provider]] : [])];
    const effective = {}; const versions = [];
    for (const [scopeType, scopeId] of scopes) {
      const row = (await this.pool.query("SELECT p.* FROM runtime_policy_versions p JOIN runtime_policy_heads h ON h.scope_type=p.scope_type AND h.scope_id=p.scope_id AND h.namespace=p.namespace AND h.current_version=p.version WHERE p.scope_type=$1 AND p.scope_id=$2 AND p.namespace=$3", [scopeType, scopeId, namespace])).rows[0];
      if (row) { Object.assign(effective, row.config); versions.push(`${scopeType}:${scopeId}:${namespace}:${row.version}`); }
    }
    return { config: redact(effective), policyVersions: versions, fingerprint: fingerprint({ config: effective, policyVersions: versions }) };
  }
  async putSecret({ tenantId, projectId = null, provider = null, name, value, actor = 'system' } = {}) {
    if (!this.secretCipher) throw Object.assign(new Error('secret encryption is not configured'), { code: 'SECRET_ENCRYPTION_UNAVAILABLE', statusCode: 503 });
    if (!tenantId || !name || value === undefined) throw new TypeError('tenantId, name and value are required');
    const encrypted = this.secretCipher.encrypt(value);
    const result = await this.pool.query(`INSERT INTO runtime_secrets(tenant_id,project_id,provider,name,version,ciphertext,nonce,auth_tag,key_id,status,created_by,rotated_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'ACTIVE',$9,now()) ON CONFLICT(tenant_id,project_id,provider,name) DO UPDATE SET version=runtime_secrets.version+1,ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,key_id=EXCLUDED.key_id,status='ACTIVE',rotated_at=now(),updated_at=now(),created_by=EXCLUDED.created_by RETURNING id,tenant_id,project_id,provider,name,version,key_id,status,rotated_at`, [tenantId, projectId, provider, name, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, 'env-master-v1', actor]);
    await this.audit({ tenantId, projectId, actor, action: 'SECRET_ROTATED', targetType: 'secret', targetId: name, details: { provider, version: result.rows[0].version } });
    return result.rows[0];
  }
  async resolveSecret({ tenantId, projectId = null, provider = null, name } = {}) {
    if (!this.secretCipher) throw Object.assign(new Error('secret encryption is not configured'), { code: 'SECRET_ENCRYPTION_UNAVAILABLE', statusCode: 503 });
    const row = (await this.pool.query(`SELECT * FROM runtime_secrets WHERE tenant_id=$1 AND name=$2 AND status='ACTIVE' AND (project_id IS NULL OR project_id=$3) AND (provider IS NULL OR provider=$4) ORDER BY (project_id IS NOT NULL) DESC,(provider IS NOT NULL) DESC,version DESC LIMIT 1`, [tenantId, name, projectId, provider])).rows[0];
    if (!row) throw Object.assign(new Error(`secret reference not found: ${name}`), { code: 'SECRET_NOT_FOUND', statusCode: 404 });
    return { value: this.secretCipher.decrypt(row), version: row.version, keyId: row.key_id };
  }
  async evaluateFlags({ tenantId, projectId = null, actorId = null, provider = null, releaseId = null } = {}) {
    const rows = (await this.pool.query('SELECT * FROM runtime_feature_flags')).rows;
    return Object.fromEntries(rows.map(row => [row.key, { enabled: evaluateFlag(row, { tenantId, projectId, actorId, provider, releaseId }), version: row.version, killSwitch: row.kill_switch }]));
  }
  async setFlag({ key, enabled, rolloutPercent = 0, targets = {}, killSwitch = false, actor = 'system', expectedVersion = null } = {}) {
    if (!/^[a-z][a-z0-9_.-]{1,127}$/.test(key)) throw new TypeError('invalid feature flag key');
    if (rolloutPercent < 0 || rolloutPercent > 100) throw new TypeError('rolloutPercent must be 0..100');
    const current = (await this.pool.query('SELECT version FROM runtime_feature_flags WHERE key=$1', [key])).rows[0];
    if (expectedVersion !== null && Number(current?.version || 0) !== Number(expectedVersion)) throw Object.assign(new Error('stale feature flag version'), { code: 'STALE_FLAG_VERSION', statusCode: 409 });
    const result = await this.pool.query(`INSERT INTO runtime_feature_flags(key,enabled,rollout_percent,targets,kill_switch,version,updated_by) VALUES($1,$2,$3,$4::jsonb,$5,1,$6) ON CONFLICT(key) DO UPDATE SET enabled=EXCLUDED.enabled,rollout_percent=EXCLUDED.rollout_percent,targets=EXCLUDED.targets,kill_switch=EXCLUDED.kill_switch,version=runtime_feature_flags.version+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [key, Boolean(enabled), rolloutPercent, JSON.stringify(targets), Boolean(killSwitch), actor]);
    await this.audit({ actor, action: killSwitch ? 'FEATURE_KILL_SWITCH' : 'FEATURE_FLAG_UPDATED', targetType: 'feature_flag', targetId: key, details: { version: result.rows[0].version, enabled, rolloutPercent, targets, killSwitch } });
    return result.rows[0];
  }
  async snapshotForJob({ job, actorId = null } = {}) {
    let tenantId = job.tenant_id || null;
    if (!tenantId && job.project_id) tenantId = (await this.pool.query('SELECT tenant_id FROM projects WHERE id=$1', [job.project_id])).rows[0]?.tenant_id || null;
    const provider = job.payload?.provider || job.payload?.providerName || null;
    const effective = await this.getEffective({ tenantId, projectId: job.project_id, provider });
    const flags = await this.evaluateFlags({ tenantId, projectId: job.project_id, actorId, provider });
    return { capturedAt: new Date().toISOString(), config: effective.config, policyVersions: effective.policyVersions, featureFlags: flags, fingerprint: fingerprint({ config: effective.config, policyVersions: effective.policyVersions, featureFlags: flags }) };
  }
  async readiness({ requireEncryption = false } = {}) {
    const checks = [];
    try { await this.pool.query('SELECT 1'); checks.push({ name: 'postgres', ok: true }); } catch (error) { checks.push({ name: 'postgres', ok: false, error: error.code || error.message }); }
    checks.push({ name: 'secret-encryption', ok: !requireEncryption || Boolean(this.secretCipher) });
    try { await this.pool.query('SELECT 1 FROM runtime_policy_heads LIMIT 1'); checks.push({ name: 'runtime-policy-schema', ok: true }); } catch (error) { checks.push({ name: 'runtime-policy-schema', ok: false, error: error.code || error.message }); }
    return { ok: checks.every(c => c.ok), checks };
  }
  async diagnostics({ tenantId = null } = {}) {
    const drift = await this.pool.query(`SELECT DISTINCT ON (worker_id) worker_id,runtime_fingerprint,policy_versions,feature_flags,observed_at FROM runtime_worker_snapshots WHERE ($1::text IS NULL OR tenant_id=$1) ORDER BY worker_id,observed_at DESC`, [tenantId]);
    const policyCount = (await this.pool.query('SELECT count(*)::int AS count FROM runtime_policy_versions')).rows[0].count;
    const flagCount = (await this.pool.query('SELECT count(*)::int AS count FROM runtime_feature_flags')).rows[0].count;
    return { policy: { count: Number(policyCount) }, featureFlags: { count: Number(flagCount) }, workers: drift.rows.map(redact) };
  }
}

module.exports = { RUNTIME_KEYS, validateRuntimeConfig, normalizeMasterKey, SecretCipher, RuntimePolicyStore, evaluateFlag, rolloutBucket, redact, fingerprint, stable };
