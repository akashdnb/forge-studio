'use strict';

const crypto = require('node:crypto');

const IMMUTABLE_DOMAINS = new Set(['audit_evidence', 'provenance', 'backups']);
const SENSITIVE_KEYS = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|credential|contentBase64|rawPayload|requestBody|responseBody/i;
const PROTECTED_TABLES = new Set([
  'tenants', 'forge_schema_migrations', 'privacy_policies', 'privacy_policy_snapshots',
  'privacy_holds', 'privacy_retention_runs', 'privacy_retention_items', 'privacy_operator_approvals',
  'privacy_quarantine', 'privacy_decision_evidence', 'deletion_requests', 'deletion_plans',
  'deletion_plan_items', 'deletion_audit_evidence', 'audit_events', 'security_audit_events',
  'runtime_config_audit', 'runtime_boot_snapshots', 'runtime_worker_snapshots', 'lifecycle_reconciliation'
]);
const RESOURCE_HINTS = [
  ['storage_objects', 'artifacts'], ['forge_jobs', 'job_logs'], ['provider_runs', 'provider_payloads'],
  ['publish_runs', 'publish_metadata'], ['inbound_webhook_events', 'webhook_envelopes'],
  ['webhook_events', 'webhook_envelopes'], ['durable_events', 'event_payloads'], ['event_deliveries', 'event_payloads'],
  ['review_comments', 'reviews_comments'], ['comments', 'reviews_comments'], ['backups', 'backups']
];

function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function canonical(value) { return JSON.stringify(sortObject(value)); }
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => { out[key] = sortObject(value[key]); return out; }, {});
}
function fingerprint(value) { return sha(canonical(value)); }
function clampDays(value, fallback) { const n = Number(value); return Number.isInteger(n) && n >= 0 && n <= 36500 ? n : fallback; }

function redactSensitive(value, { replacement = '[REDACTED]' } = {}) {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, { replacement }));
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).reduce((out, key) => {
    out[key] = SENSITIVE_KEYS.test(key) ? replacement : redactSensitive(value[key], { replacement });
    return out;
  }, {});
}

function sanitizeRunnerManifest(manifest, { requiredEvidenceKeys = [] } = {}) {
  const safe = redactSensitive(manifest);
  if (!Array.isArray(requiredEvidenceKeys) || !requiredEvidenceKeys.length) {
    if (safe && typeof safe === 'object') delete safe.providerPayload;
    return safe;
  }
  const original = manifest && typeof manifest === 'object' ? manifest : {};
  for (const key of requiredEvidenceKeys) if (Object.prototype.hasOwnProperty.call(original, key)) safe[key] = original[key];
  return safe;
}

class PrivacyGovernanceError extends Error {
  constructor(code, message, statusCode = 409) { super(message); this.code = code; this.statusCode = statusCode; }
}

class PrivacyGovernance {
  constructor({ pool, storage = null, clock = () => new Date(), batchSize = 100, encryptionKey = process.env.FORGE_PRIVACY_ENCRYPTION_KEY || process.env.FORGE_SECRET_ENCRYPTION_KEY } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pg pool is required');
    this.pool = pool; this.storage = storage; this.clock = clock; this.batchSize = Math.max(1, Math.min(500, batchSize));
    if (!encryptionKey) throw new PrivacyGovernanceError('MISSING_PRIVACY_KEY', 'FORGE_PRIVACY_ENCRYPTION_KEY or FORGE_SECRET_ENCRYPTION_KEY is required', 500);
    const raw = Buffer.from(encryptionKey, /^[0-9a-f]{64}$/i.test(encryptionKey) ? 'hex' : 'base64');
    if (raw.length !== 32) throw new PrivacyGovernanceError('INVALID_PRIVACY_KEY', 'privacy encryption key must decode to 32 bytes', 500);
    this.key = raw;
  }

  encryptPayload(payload) {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8'); const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  decryptPayload(buffer) {
    const value = Buffer.from(buffer); const iv = value.subarray(0, 12); const tag = value.subarray(12, 28); const ciphertext = value.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  }

  defaultPolicy() {
    return {
      defaultDays: 365, graceDays: 7,
      domains: {
        audit_evidence: { retentionDays: 0, immutableEvidence: true, redactExports: true, encryptedAtRest: true, allowPublicRunner: false },
        provenance: { retentionDays: 730, immutableEvidence: true, redactExports: true, encryptedAtRest: true, allowPublicRunner: false },
        artifacts: { retentionDays: 90, encryptedAtRest: true, redactExports: true, allowPublicRunner: false },
        job_logs: { retentionDays: 30, redactExports: true }, event_payloads: { retentionDays: 180, encryptedAtRest: true, redactExports: true },
        provider_payloads: { retentionDays: 30, encryptedAtRest: true, redactExports: true, allowPublicRunner: false },
        webhook_envelopes: { retentionDays: 30, encryptedAtRest: true, redactExports: true },
        publish_metadata: { retentionDays: 365, encryptedAtRest: true, redactExports: true },
        reviews_comments: { retentionDays: 365, encryptedAtRest: true, redactExports: true },
        backups: { retentionDays: 365, immutableEvidence: true, encryptedAtRest: true, redactExports: true, allowPublicRunner: false }
      }
    };
  }

  normalizePolicy(input = {}) {
    const base = this.defaultPolicy(); const domains = { ...base.domains, ...(input.domains || {}) };
    for (const [domain, value] of Object.entries(domains)) domains[domain] = {
      retentionDays: clampDays(value.retentionDays, base.domains[domain]?.retentionDays ?? clampDays(input.defaultDays, 365)),
      graceDays: clampDays(value.graceDays, clampDays(input.graceDays, 7)),
      immutableEvidence: Boolean(value.immutableEvidence || IMMUTABLE_DOMAINS.has(domain)),
      encryptedAtRest: Boolean(value.encryptedAtRest), redactExports: value.redactExports !== false, allowPublicRunner: value.allowPublicRunner === true
    };
    return { defaultDays: clampDays(input.defaultDays, base.defaultDays), graceDays: clampDays(input.graceDays, base.graceDays), domains };
  }

  async setPolicy({ tenantId, actor, policy }) {
    if (!tenantId || !actor) throw new PrivacyGovernanceError('VALIDATION_ERROR', 'tenantId and actor are required', 400);
    const normalized = this.normalizePolicy(policy); const fp = fingerprint(normalized); const c = await this.pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
      const latest = (await c.query('SELECT COALESCE(max(version),0)::bigint version FROM privacy_policies WHERE tenant_id=$1', [tenantId])).rows[0];
      const version = Number(latest.version) + 1;
      await c.query('INSERT INTO privacy_policies(tenant_id,version,policy,fingerprint,updated_by) VALUES($1,$2,$3::jsonb,$4,$5)', [tenantId, version, JSON.stringify(normalized), fp, actor]);
      await c.query('INSERT INTO privacy_decision_evidence(tenant_id,actor,decision,reason,details) VALUES($1,$2,$3,$4,$5::jsonb)', [tenantId, actor, 'POLICY_UPDATED', 'privacy retention policy versioned', JSON.stringify({ version, fingerprint: fp })]);
      await c.query('COMMIT'); return { tenantId, version, fingerprint: fp, policy: normalized };
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async snapshotPolicy({ tenantId, executionKind, executionId }) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const existing = (await c.query('SELECT * FROM privacy_policy_snapshots WHERE tenant_id=$1 AND execution_kind=$2 AND execution_id=$3 FOR UPDATE', [tenantId, executionKind, executionId])).rows[0];
      if (existing) { await c.query('COMMIT'); return existing; }
      let policy = (await c.query('SELECT * FROM privacy_policies WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1', [tenantId])).rows[0];
      if (!policy) { const result = await this.setPolicy({ tenantId, actor: 'system', policy: this.defaultPolicy() }); policy = (await c.query('SELECT * FROM privacy_policies WHERE tenant_id=$1 AND version=$2', [tenantId, result.version])).rows[0]; }
      const id = crypto.randomUUID(); await c.query('INSERT INTO privacy_policy_snapshots(id,tenant_id,policy_version,fingerprint,policy,execution_kind,execution_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)', [id, tenantId, policy.version, policy.fingerprint, JSON.stringify(policy.policy), executionKind, executionId]);
      await c.query('COMMIT'); return (await this.pool.query('SELECT * FROM privacy_policy_snapshots WHERE id=$1', [id])).rows[0];
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async createHold({ tenantId, projectId = null, actor, reason, scope = {} }) {
    if (!tenantId || !actor || !reason?.trim()) throw new PrivacyGovernanceError('VALIDATION_ERROR', 'tenantId, actor and reason are required', 400);
    const id = crypto.randomUUID(); await this.pool.query('INSERT INTO privacy_holds(id,tenant_id,project_id,reason,scope,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [id, tenantId, projectId, reason.trim(), JSON.stringify(scope), actor]);
    await this.pool.query('INSERT INTO privacy_decision_evidence(tenant_id,actor,decision,reason,hold_ids,details) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [tenantId, actor, 'HOLD_CREATED', reason.trim(), JSON.stringify([id]), JSON.stringify({ projectId, scope })]);
    return (await this.pool.query('SELECT * FROM privacy_holds WHERE id=$1', [id])).rows[0];
  }

  async releaseHold({ tenantId, holdId, actor, reason = 'hold released' }) {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const hold = (await c.query('SELECT * FROM privacy_holds WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [holdId, tenantId])).rows[0]; if (!hold) throw new PrivacyGovernanceError('NOT_FOUND', 'hold not found', 404); if (!hold.active) { await c.query('COMMIT'); return hold; } await c.query('UPDATE privacy_holds SET active=false,released_by=$1,released_at=now() WHERE id=$2', [actor, holdId]); await c.query('INSERT INTO privacy_decision_evidence(tenant_id,actor,decision,reason,hold_ids) VALUES($1,$2,$3,$4,$5::jsonb)', [tenantId, actor, 'HOLD_RELEASED', reason, JSON.stringify([holdId])]); await c.query('COMMIT'); return (await this.pool.query('SELECT * FROM privacy_holds WHERE id=$1', [holdId])).rows[0]; }
    catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async activeHolds(tenantId, projectId = null, client = this.pool) {
    return (await client.query('SELECT id,project_id,reason FROM privacy_holds WHERE tenant_id=$1 AND active AND (project_id IS NULL OR project_id=$2) ORDER BY id', [tenantId, projectId])).rows;
  }

  evaluate({ observedAt, domain, snapshot, holds = [], now = this.clock() }) {
    const rule = snapshot?.policy?.domains?.[domain] || { retentionDays: snapshot?.policy?.defaultDays ?? 365, graceDays: snapshot?.policy?.graceDays ?? 7 };
    const observed = new Date(observedAt); if (Number.isNaN(observed.valueOf())) return { eligible: false, reason: 'INVALID_TIMESTAMP' };
    const eligibleAt = new Date(observed.getTime() + Number(rule.retentionDays || 0) * 86400000);
    const quarantineUntil = new Date(eligibleAt.getTime() + Number(rule.graceDays || 0) * 86400000);
    const immutable = Boolean(rule.immutableEvidence || IMMUTABLE_DOMAINS.has(domain));
    if (immutable) return { eligible: false, preserved: true, reason: 'IMMUTABLE_EVIDENCE', eligibleAt, quarantineUntil };
    if (holds.length) return { eligible: false, blocked: true, reason: 'LEGAL_HOLD', holdIds: holds.map((h) => h.id), eligibleAt, quarantineUntil };
    if (now < eligibleAt) return { eligible: false, reason: 'RETENTION_WINDOW', eligibleAt, quarantineUntil };
    return { eligible: true, reason: now < quarantineUntil ? 'GRACE_PERIOD' : 'ELIGIBLE_FOR_APPROVAL', eligibleAt, quarantineUntil };
  }

  async _registry(client) {
    const rows = (await client.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('tenant_id','project_id','created_at','updated_at','id') ORDER BY table_name,column_name")).rows;
    const grouped = new Map(); for (const row of rows) { if (!grouped.has(row.table_name)) grouped.set(row.table_name, new Set()); grouped.get(row.table_name).add(row.column_name); }
    return [...grouped.entries()].filter(([table]) => !PROTECTED_TABLES.has(table)).map(([table, cols]) => {
      const hint = RESOURCE_HINTS.find(([name]) => name === table); return { table, cols, domain: hint?.[1] || 'derived_records' };
    }).filter((x) => x.cols.has('id') && (x.cols.has('tenant_id') || x.cols.has('project_id')) && (x.cols.has('created_at') || x.cols.has('updated_at')));
  }

  async startRun({ tenantId, runId = crypto.randomUUID() }) {
    const snapshot = await this.snapshotPolicy({ tenantId, executionKind: 'retention-run', executionId: runId });
    await this.pool.query('INSERT INTO privacy_retention_runs(id,tenant_id,policy_snapshot_id,status) VALUES($1,$2,$3,\'RUNNING\') ON CONFLICT(id) DO UPDATE SET status=\'RUNNING\',updated_at=now()', [runId, tenantId, snapshot.id]);
    return { runId, snapshot };
  }

  async scan({ tenantId, runId, limit = this.batchSize }) {
    const c = await this.pool.connect(); let scanned = 0, eligible = 0, blocked = 0, checkpoint = null;
    try {
      await c.query('BEGIN'); await c.query('SELECT id FROM privacy_retention_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [runId, tenantId]);
      const run = (await c.query('SELECT * FROM privacy_retention_runs WHERE id=$1', [runId])).rows[0]; const snapshot = (await c.query('SELECT * FROM privacy_policy_snapshots WHERE id=$1', [run.policy_snapshot_id])).rows[0];
      const registry = await this._registry(c);
      for (const entry of registry) {
        if (scanned >= limit) break;
        const timeColumn = entry.cols.has('updated_at') ? 'updated_at' : 'created_at';
        const scope = entry.cols.has('tenant_id') ? `t.tenant_id=$1` : `t.project_id IN (SELECT id FROM projects WHERE tenant_id=$1)`;
        const rows = (await c.query(`SELECT t.id,t.project_id,t.${timeColumn} AS observed_at,t.${timeColumn}::text AS checkpoint FROM ${entry.table} t WHERE ${scope} AND t.${timeColumn} IS NOT NULL AND ($2::text IS NULL OR t.id > $2) ORDER BY t.id LIMIT $3`, [tenantId, checkpoint, Math.min(limit - scanned, 100)])).rows;
        for (const row of rows) {
          scanned++; checkpoint = String(row.id); const holds = await this.activeHolds(tenantId, row.project_id, c); const decision = this.evaluate({ observedAt: row.observed_at, domain: entry.domain, snapshot, holds });
          const id = sha(`${tenantId}:${entry.table}:${row.id}:${snapshot.id}`);
          let state = decision.preserved ? 'PRESERVED' : decision.blocked ? 'BLOCKED' : decision.eligible ? 'ELIGIBLE' : 'PRESERVED';
          if (decision.eligible && decision.reason === 'GRACE_PERIOD') state = 'ELIGIBLE';
          await c.query(`INSERT INTO privacy_retention_items(id,run_id,tenant_id,project_id,resource_type,resource_id,classification,observed_at,eligible_at,policy_snapshot_id,immutable_evidence,state,quarantine_until,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT(tenant_id,resource_type,resource_id,policy_snapshot_id) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,updated_at=now()`, [id, runId, tenantId, row.project_id || null, entry.table, String(row.id), snapshot.policy?.domains?.[entry.domain]?.classification || 'INTERNAL', row.observed_at, decision.eligibleAt || row.observed_at, snapshot.id, Boolean(decision.preserved), state, decision.quarantineUntil || null, decision.reason, JSON.stringify({ domain: entry.domain, holdIds: decision.holdIds || [], fingerprint: snapshot.fingerprint })]);
          await c.query('INSERT INTO privacy_decision_evidence(tenant_id,retention_item_id,actor,decision,reason,policy_snapshot_id,hold_ids,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)', [tenantId, id, 'retention-worker', state, decision.reason, snapshot.id, JSON.stringify(decision.holdIds || []), JSON.stringify({ resourceType: entry.table, resourceId: row.id })]);
          if (decision.eligible && decision.reason === 'ELIGIBLE_FOR_APPROVAL') eligible++; if (decision.blocked) blocked++;
        }
      }
      await c.query('UPDATE privacy_retention_runs SET checkpoint=$1,scanned=scanned+$2,eligible=eligible+$3,blocked=blocked+$4,updated_at=now() WHERE id=$5', [checkpoint, scanned, eligible, blocked, runId]);
      await c.query('COMMIT'); return { runId, scanned, eligible, blocked, checkpoint };
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); await this.pool.query('UPDATE privacy_retention_runs SET status=\'FAILED\',last_error=$1::jsonb,updated_at=now() WHERE id=$2', [JSON.stringify({ code: error.code, message: error.message }), runId]).catch(() => {}); throw error; } finally { c.release(); }
  }

  async approveBatch({ tenantId, actor, itemIds, reason }) {
    if (!itemIds?.length || !actor || !reason?.trim()) throw new PrivacyGovernanceError('VALIDATION_ERROR', 'itemIds, actor and reason are required', 400);
    const targetFingerprint = sha([...itemIds].sort().join('|')); const id = crypto.randomUUID();
    await this.pool.query('INSERT INTO privacy_operator_approvals(id,tenant_id,action,target_fingerprint,approved_by,reason) VALUES($1,$2,\'DESTROY_RETENTION_BATCH\',$3,$4,$5) ON CONFLICT(tenant_id,action,target_fingerprint) DO NOTHING', [id, tenantId, targetFingerprint, actor, reason.trim()]);
    const approval = (await this.pool.query('SELECT * FROM privacy_operator_approvals WHERE tenant_id=$1 AND action=\'DESTROY_RETENTION_BATCH\' AND target_fingerprint=$2', [tenantId, targetFingerprint])).rows[0];
    await this.pool.query('UPDATE privacy_retention_items SET approval_id=$1,state=CASE WHEN state=\'ELIGIBLE\' THEN \'APPROVED\' ELSE state END,updated_at=now() WHERE tenant_id=$2 AND id=ANY($3)', [approval.id, tenantId, itemIds]);
    await this.pool.query('INSERT INTO privacy_decision_evidence(tenant_id,actor,decision,reason,details) VALUES($1,$2,$3,$4,$5::jsonb)', [tenantId, actor, 'DESTRUCTION_APPROVED', reason, JSON.stringify({ approvalId: approval.id, itemIds: [...itemIds].sort() })]);
    return approval;
  }

  async execute({ tenantId, limit = this.batchSize }) {
    const c = await this.pool.connect(); const destroyed = []; const blocked = [];
    try {
      await c.query('BEGIN');
      const items = (await c.query(`SELECT i.*,p.policy FROM privacy_retention_items i JOIN privacy_policy_snapshots p ON p.id=i.policy_snapshot_id WHERE i.tenant_id=$1 AND i.state='APPROVED' AND i.quarantine_until <= now() ORDER BY i.id LIMIT $2 FOR UPDATE SKIP LOCKED`, [tenantId, limit])).rows;
      for (const item of items) {
        const holds = await this.activeHolds(tenantId, item.project_id, c);
        if (holds.length || item.immutable_evidence) { blocked.push(item.id); await c.query("UPDATE privacy_retention_items SET state='BLOCKED',updated_at=now() WHERE id=$1", [item.id]); await c.query('INSERT INTO privacy_decision_evidence(tenant_id,retention_item_id,actor,decision,reason,hold_ids) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [tenantId, item.id, 'retention-worker', 'DESTRUCTION_BLOCKED', holds.length ? 'LEGAL_HOLD' : 'IMMUTABLE_EVIDENCE', JSON.stringify(holds.map((h) => h.id))]); continue; }
        const table = item.resource_type; if (PROTECTED_TABLES.has(table) || !/^[a-z_][a-z0-9_]*$/i.test(table)) { blocked.push(item.id); continue; }
        const exists = await c.query('SELECT 1 FROM information_schema.tables WHERE table_schema=\'public\' AND table_name=$1', [table]); if (!exists.rows[0]) { await c.query("UPDATE privacy_retention_items SET state='DESTROYED',updated_at=now() WHERE id=$1", [item.id]); destroyed.push(item.id); continue; }
        const row = (await c.query(`SELECT to_jsonb(t) AS payload FROM ${table} t WHERE t.id=$1`, [item.resource_id])).rows[0];
        if (!row) { await c.query("UPDATE privacy_retention_items SET state='DESTROYED',updated_at=now() WHERE id=$1", [item.id]); destroyed.push(item.id); continue; }
        const encrypted = this.encryptPayload(redactSensitive(row.payload)); await c.query('INSERT INTO privacy_quarantine(id,retention_item_id,tenant_id,resource_type,resource_id,encrypted_payload,checksum,purge_after,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,\'QUARANTINED\') ON CONFLICT(retention_item_id) DO NOTHING', [crypto.randomUUID(), item.id, tenantId, table, item.resource_id, encrypted, sha(JSON.stringify(row.payload)), new Date(this.clock().getTime() + 7 * 86400000)]);
        try { await c.query(`DELETE FROM ${table} WHERE id=$1`, [item.resource_id]); await c.query("UPDATE privacy_retention_items SET state='DESTROYED',updated_at=now() WHERE id=$1", [item.id]); destroyed.push(item.id); await c.query('INSERT INTO privacy_decision_evidence(tenant_id,retention_item_id,actor,decision,reason,policy_snapshot_id) VALUES($1,$2,$3,$4,$5,$6)', [tenantId, item.id, 'retention-worker', 'DESTROYED', 'approved retention expiry after quarantine', item.policy_snapshot_id]); }
        catch (error) { await c.query("UPDATE privacy_retention_items SET state='BLOCKED',reason=$2,updated_at=now() WHERE id=$1", [item.id, `REFERENTIAL_BLOCK:${error.code || 'DELETE_FAILED'}`]); blocked.push(item.id); }
      }
      await c.query('COMMIT'); return { destroyed, blocked };
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async guardDestructiveAction({ tenantId, projectId = null, action, actor = 'system' }) {
    const holds = await this.activeHolds(tenantId, projectId); if (holds.length) { await this.pool.query('INSERT INTO privacy_decision_evidence(tenant_id,actor,decision,reason,hold_ids,details) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [tenantId, actor, 'DESTRUCTIVE_ACTION_BLOCKED', 'active legal/privacy hold', JSON.stringify(holds.map((h) => h.id)), JSON.stringify({ action, projectId })]); throw new PrivacyGovernanceError('HOLD_BLOCKED', `destructive action blocked by ${holds.length} active hold(s)`); }
    return true;
  }

  async sanitizeExport({ tenantId, payload, domains = [] }) {
    const holds = await this.activeHolds(tenantId); const sanitized = redactSensitive(payload); await this.pool.query('INSERT INTO privacy_decision_evidence(tenant_id,actor,decision,reason,hold_ids,details) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [tenantId, 'export', 'EXPORT_SANITIZED', 'sensitive fields redacted before export', JSON.stringify(holds.map((h) => h.id)), JSON.stringify({ domains, fingerprint: sha(JSON.stringify(sanitized)) })]); return sanitized;
  }
}

module.exports = { PrivacyGovernance, PrivacyGovernanceError, redactSensitive, sanitizeRunnerManifest, fingerprint, canonical };
