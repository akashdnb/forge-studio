const crypto = require('node:crypto');
const { canonicalize, sha256 } = require('./recovery-verifier');

const SIGNING_ALGORITHM = 'HMAC-SHA256';

function keyring() {
  const keys = {};
  if (process.env.FORGE_RECOVERY_SIGNING_KEYS_JSON) {
    const parsed = JSON.parse(process.env.FORGE_RECOVERY_SIGNING_KEYS_JSON);
    for (const [id, value] of Object.entries(parsed || {})) keys[id] = Buffer.from(String(value), 'base64');
  }
  if (process.env.FORGE_RECOVERY_SIGNING_KEY) {
    keys[process.env.FORGE_RECOVERY_SIGNING_KEY_ID || 'default'] = Buffer.from(process.env.FORGE_RECOVERY_SIGNING_KEY, 'base64');
  }
  for (const [id, key] of Object.entries(keys)) if (key.length < 32) throw Object.assign(new Error(`recovery signing key ${id} must decode to at least 32 bytes`), { code: 'RECOVERY_SIGNING_KEY_INVALID' });
  return keys;
}

function sign(payload, keyId) {
  const keys = keyring();
  const id = keyId || process.env.FORGE_RECOVERY_SIGNING_KEY_ID || Object.keys(keys)[0];
  const key = keys[id];
  if (!key) throw Object.assign(new Error('FORGE_RECOVERY_SIGNING_KEY is required'), { code: 'RECOVERY_SIGNING_KEY_MISSING' });
  const canonical = canonicalize(payload);
  const digest = crypto.createHmac('sha256', key).update(canonical).digest('base64url');
  return { algorithm: SIGNING_ALGORITHM, keyId: id, payloadSha256: sha256(canonical), signature: digest };
}

function verify(payload, record) {
  const keys = keyring();
  const key = keys[record.key_id || record.keyId];
  if (!key) return { ok: false, code: 'RECOVERY_SIGNING_KEY_UNAVAILABLE' };
  const canonical = canonicalize(payload);
  const expectedHash = sha256(canonical);
  if (expectedHash !== record.payload_sha256) return { ok: false, code: 'RECOVERY_EVIDENCE_PAYLOAD_DRIFT' };
  const expected = crypto.createHmac('sha256', key).update(canonical).digest('base64url');
  const actual = String(record.signature);
  if (expected.length !== actual.length) return { ok: false, code: 'RECOVERY_EVIDENCE_SIGNATURE_INVALID' };
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  return { ok, code: ok ? undefined : 'RECOVERY_EVIDENCE_SIGNATURE_INVALID' };
}

function targetHash(targetDatabaseUrl) { return sha256(String(targetDatabaseUrl)); }

async function allocateGeneration(pool, tenantId) {
  const result = await pool.query(`INSERT INTO forge_recovery_generation_state(tenant_id,next_generation) VALUES($1,2) ON CONFLICT(tenant_id) DO UPDATE SET next_generation=forge_recovery_generation_state.next_generation+1,updated_at=now() RETURNING next_generation-1 AS generation`, [tenantId]);
  return Number(result.rows[0].generation);
}

async function recordIntegrity(pool, { tenantId, backupId, generation, evidenceType, payload }) {
  const signed = sign(payload);
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO forge_recovery_integrity_records(id,tenant_id,backup_id,generation,evidence_type,canonical_payload,payload_sha256,algorithm,key_id,signature) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`, [id, tenantId, backupId, generation, evidenceType, JSON.stringify(payload), signed.payloadSha256, signed.algorithm, signed.keyId, signed.signature]);
  return { id, ...signed };
}

async function coverage(pool) {
  const required = ['tenants','projects','episodes','version_records','artifacts','storage_objects','forge_jobs','forge_job_dependencies','publish_runs','security_audit_events','configuration_snapshots','runtime_policy_snapshots','provider_credentials','forge_execution_runs'];
  const missing = [];
  for (const table of required) {
    const result = await pool.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
    if (!result.rows[0]?.name) missing.push(table);
  }
  return { status: missing.length ? 'INCOMPLETE' : 'COMPLETE', required, missing, dependencyComplete: missing.length === 0 };
}

async function rpo(pool, snapshotAt) {
  const result = await pool.query('SELECT GREATEST(0, EXTRACT(EPOCH FROM (now() - $1::timestamptz)))::bigint AS age', [snapshotAt]);
  return Number(result.rows[0]?.age || 0);
}

module.exports = { SIGNING_ALGORITHM, sign, verify, targetHash, allocateGeneration, recordIntegrity, coverage, rpo };
