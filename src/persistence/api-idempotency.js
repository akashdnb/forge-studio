const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');

const idempotencyContext = new AsyncLocalStorage();
const DEFAULT_RETENTION_SECONDS = 24 * 60 * 60;
const MAX_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const SENSITIVE_KEY = /(authorization|cookie|secret|password|token|api[_-]?key|private[_-]?key|refresh[_-]?token|access[_-]?token|credential)/i;

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce((out, key) => {
    out[key] = canonicalize(value[key]);
    return out;
  }, {});
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function redact(value, depth = 0) {
  if (depth > 8) return '[REDACTED_DEPTH]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.keys(value).reduce((out, key) => {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(value[key], depth + 1);
    return out;
  }, {});
}

function validateContext(context = {}) {
  const key = context.idempotencyKey == null ? null : String(context.idempotencyKey);
  if (!key) return null;
  if (key.length < 8 || key.length > 255) throw Object.assign(new Error('Idempotency-Key must be between 8 and 255 characters'), { code: 'INVALID_IDEMPOTENCY_KEY', statusCode: 400 });
  const operation = String(context.operation || '').trim();
  if (!operation || operation.length > 128) throw Object.assign(new Error('Idempotency operation is required'), { code: 'INVALID_IDEMPOTENCY_OPERATION', statusCode: 400 });
  const tenantId = context.tenantId ? String(context.tenantId) : null;
  const projectId = context.projectId ? String(context.projectId) : null;
  if (!tenantId && !projectId) throw Object.assign(new Error('Idempotent requests require tenant or project scope'), { code: 'IDEMPOTENCY_SCOPE_REQUIRED', statusCode: 400 });
  const retentionSeconds = Math.min(MAX_RETENTION_SECONDS, Math.max(60, Number(context.retentionSeconds || DEFAULT_RETENTION_SECONDS)));
  return {
    ...context,
    idempotencyKey: key,
    operation,
    tenantId,
    projectId,
    requestHash: context.requestHash || sha256(context.request || {}),
    retentionSeconds,
    actor: String(context.actor || 'system'),
    requestId: String(context.requestId || 'unknown'),
  };
}

function runIdempotencyContext(context, fn) {
  const normalized = validateContext(context);
  return idempotencyContext.run(normalized, fn);
}

function getIdempotencyContext() {
  return idempotencyContext.getStore() || null;
}

function idempotencyConflict(message, details = {}) {
  return Object.assign(new Error(message), { code: 'IDEMPOTENCY_KEY_REUSE', statusCode: 409, details });
}

async function claim(client, context) {
  const ctx = validateContext(context);
  if (!ctx) return { enabled: false, replay: false, context: null };
  const inserted = await client.query(`
    INSERT INTO forge_api_idempotency_keys
      (tenant_id,project_id,operation,idempotency_key,request_hash,actor,request_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::text||' seconds')::interval)
    ON CONFLICT DO NOTHING
    RETURNING *`,
  [ctx.tenantId, ctx.projectId, ctx.operation, ctx.idempotencyKey, ctx.requestHash, ctx.actor, ctx.requestId, ctx.retentionSeconds]);

  if (inserted.rows[0]) {
    await client.query(`INSERT INTO forge_api_idempotency_events
      (tenant_id,project_id,operation,idempotency_key,request_hash,event_type,actor,request_id,details)
      VALUES($1,$2,$3,$4,$5,'CLAIMED',$6,$7,$8::jsonb)`,
    [ctx.tenantId, ctx.projectId, ctx.operation, ctx.idempotencyKey, ctx.requestHash, ctx.actor, ctx.requestId,
      JSON.stringify({ resourceType: ctx.resourceType || null, resourceId: ctx.resourceId || null })]);
    return { enabled: true, replay: false, context: ctx, row: inserted.rows[0] };
  }

  const existing = await client.query(`SELECT * FROM forge_api_idempotency_keys
    WHERE tenant_id IS NOT DISTINCT FROM $1
      AND project_id IS NOT DISTINCT FROM $2
      AND operation=$3 AND idempotency_key=$4
    FOR UPDATE`, [ctx.tenantId, ctx.projectId, ctx.operation, ctx.idempotencyKey]);
  const row = existing.rows[0];
  if (!row) throw new Error('Idempotency registry race: key disappeared');
  if (row.request_hash !== ctx.requestHash) {
    await client.query(`INSERT INTO forge_api_idempotency_events
      (tenant_id,project_id,operation,idempotency_key,request_hash,event_type,actor,request_id,details)
      VALUES($1,$2,$3,$4,$5,'CONFLICT',$6,$7,$8::jsonb)`,
    [ctx.tenantId, ctx.projectId, ctx.operation, ctx.idempotencyKey, ctx.requestHash, ctx.actor, ctx.requestId,
      JSON.stringify({ existingRequestHash: row.request_hash })]);
    throw idempotencyConflict('Idempotency-Key was already used with a different request fingerprint', {
      operation: ctx.operation,
      idempotencyKey: ctx.idempotencyKey,
    });
  }
  if (row.status === 'COMMITTED') {
    await client.query(`INSERT INTO forge_api_idempotency_events
      (tenant_id,project_id,operation,idempotency_key,request_hash,event_type,actor,request_id,outcome_hash,details)
      VALUES($1,$2,$3,$4,$5,'REPLAYED',$6,$7,$8,$9::jsonb)`,
    [ctx.tenantId, ctx.projectId, ctx.operation, ctx.idempotencyKey, ctx.requestHash, ctx.actor, ctx.requestId, row.outcome_hash,
      JSON.stringify({ originalRequestId: row.request_id, completedAt: row.completed_at })]);
    return { enabled: true, replay: true, context: ctx, row };
  }
  if (row.status === 'IN_PROGRESS' && new Date(row.expires_at).getTime() > Date.now()) {
    throw Object.assign(new Error('An identical idempotent operation is currently committing'), { code: 'IDEMPOTENCY_IN_PROGRESS', statusCode: 409 });
  }
  await client.query(`UPDATE forge_api_idempotency_keys SET status='EXPIRED',updated_at=now() WHERE id=$1`, [row.id]);
  await client.query(`INSERT INTO forge_api_idempotency_events
    (tenant_id,project_id,operation,idempotency_key,request_hash,event_type,actor,request_id,details)
    VALUES($1,$2,$3,$4,$5,'EXPIRED',$6,$7,$8::jsonb)`,
  [ctx.tenantId, ctx.projectId, ctx.operation, ctx.idempotencyKey, ctx.requestHash, ctx.actor, ctx.requestId,
    JSON.stringify({ previousStatus: row.status, expiresAt: row.expires_at })]);
  throw Object.assign(new Error('Expired idempotency state requires a new key'), { code: 'IDEMPOTENCY_EXPIRED', statusCode: 409 });
}

async function complete(client, claimResult, outcome, responseStatus = 200) {
  if (!claimResult?.enabled || claimResult.replay) return outcome;
  const ctx = claimResult.context;
  const safeOutcome = redact(outcome);
  const outcomeHash = sha256(safeOutcome);
  await client.query(`UPDATE forge_api_idempotency_keys
    SET status='COMMITTED',response_status=$1,response_body=$2::jsonb,outcome_hash=$3,
        resource_type=$4,resource_id=$5,release_epoch=$6,completed_at=now(),updated_at=now()
    WHERE id=$7 AND status='IN_PROGRESS'`,
  [responseStatus, JSON.stringify(safeOutcome), outcomeHash, ctx.resourceType || null, ctx.resourceId || null, ctx.releaseEpoch || null, claimResult.row.id]);
  await client.query(`INSERT INTO forge_api_idempotency_events
    (tenant_id,project_id,operation,idempotency_key,request_hash,event_type,actor,request_id,outcome_hash,details)
    VALUES($1,$2,$3,$4,$5,'COMMITTED',$6,$7,$8,$9::jsonb)`,
  [ctx.tenantId, ctx.projectId, ctx.operation, ctx.idempotencyKey, ctx.requestHash, ctx.actor, ctx.requestId, outcomeHash,
    JSON.stringify({ responseStatus, resourceType: ctx.resourceType || null, resourceId: ctx.resourceId || null })]);
  return outcome;
}

async function withIdempotencyTransaction(pool, context, operation, { responseStatus = 200 } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimResult = await claim(client, context);
    if (claimResult.replay) {
      await client.query('COMMIT');
      return claimResult.row.response_body;
    }
    const outcome = await operation(client, claimResult.context);
    await complete(client, claimResult, outcome, responseStatus);
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
  }
}

async function acquireResourceFence(client, { tenantId = null, projectId = null, resourceType, resourceId, expectedVersion = null, expectedEpoch = null } = {}) {
  if ((!tenantId && !projectId) || !resourceType || !resourceId) throw new TypeError('resource fence scope, type and id are required');
  const upsert = await client.query(`INSERT INTO forge_resource_fences(tenant_id,project_id,resource_type,resource_id)
    VALUES($1,$2,$3,$4)
    ON CONFLICT DO NOTHING
    RETURNING *`, [tenantId, projectId, resourceType, resourceId]);
  const result = upsert.rows[0]
    ? upsert
    : await client.query(`SELECT * FROM forge_resource_fences
      WHERE tenant_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
        AND resource_type=$3 AND resource_id=$4 FOR UPDATE`, [tenantId, projectId, resourceType, resourceId]);
  const row = result.rows[0];
  if (!row) throw new Error('Resource fence disappeared');
  if (expectedEpoch != null && Number(row.epoch) !== Number(expectedEpoch)) {
    throw Object.assign(new Error('Resource release epoch conflict'), { code: 'RELEASE_EPOCH_CONFLICT', statusCode: 409, details: { expectedEpoch, actualEpoch: Number(row.epoch) } });
  }
  if (expectedVersion != null && Number(row.version) !== Number(expectedVersion)) {
    throw Object.assign(new Error('Resource version conflict'), { code: 'RESOURCE_VERSION_CONFLICT', statusCode: 409, details: { expectedVersion, actualVersion: Number(row.version) } });
  }
  const updated = await client.query(`UPDATE forge_resource_fences
    SET version=version+1,updated_at=now()
    WHERE id=$1 RETURNING *`, [row.id]);
  return updated.rows[0];
}

async function recordCallbackReceipt(client, { tenantId = null, projectId = null, source, externalEventId, payload, attemptId = null, observedEpoch = null } = {}) {
  if ((!tenantId && !projectId) || !source || !externalEventId) throw new TypeError('callback receipt scope, source and externalEventId are required');
  const payloadHash = sha256(payload || {});
  const inserted = await client.query(`INSERT INTO forge_callback_receipts
    (tenant_id,project_id,source,external_event_id,payload_hash,attempt_id,observed_epoch)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING RETURNING *`, [tenantId, projectId, source, externalEventId, payloadHash, attemptId, observedEpoch]);
  if (inserted.rows[0]) return { duplicate: false, row: inserted.rows[0] };
  const existing = await client.query(`SELECT * FROM forge_callback_receipts
    WHERE tenant_id IS NOT DISTINCT FROM $1 AND project_id IS NOT DISTINCT FROM $2
      AND source=$3 AND external_event_id=$4 FOR UPDATE`, [tenantId, projectId, source, externalEventId]);
  if (!existing.rows[0]) throw new Error('Callback receipt disappeared');
  if (existing.rows[0].payload_hash !== payloadHash) {
    await client.query(`UPDATE forge_callback_receipts SET status='CONFLICT',details=$1::jsonb WHERE id=$2`, [JSON.stringify({ conflict: 'payload_hash_mismatch' }), existing.rows[0].id]);
    throw Object.assign(new Error('Callback event id was reused with a different payload'), { code: 'CALLBACK_REPLAY_CONFLICT', statusCode: 409 });
  }
  return { duplicate: true, row: existing.rows[0] };
}

async function markCallbackApplied(client, receiptId, status = 'APPLIED', details = {}) {
  const result = await client.query(`UPDATE forge_callback_receipts
    SET status=$1,applied_at=CASE WHEN $1='APPLIED' THEN COALESCE(applied_at,now()) ELSE applied_at END,
        details=details || $2::jsonb
    WHERE id=$3 RETURNING *`, [status, JSON.stringify(redact(details)), receiptId]);
  return result.rows[0] || null;
}

async function prune(pool, limit = 1000) {
  const result = await pool.query('SELECT forge_prune_api_idempotency($1)::int AS removed', [limit]);
  return Number(result.rows[0]?.removed || 0);
}

module.exports = {
  DEFAULT_RETENTION_SECONDS,
  MAX_RETENTION_SECONDS,
  canonicalize,
  canonicalJson,
  sha256,
  redact,
  validateContext,
  runIdempotencyContext,
  getIdempotencyContext,
  idempotencyConflict,
  claim,
  complete,
  withIdempotencyTransaction,
  acquireResourceFence,
  recordCallbackReceipt,
  markCallbackApplied,
  prune,
};
