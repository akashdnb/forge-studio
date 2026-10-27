'use strict';

const { createHash } = require('node:crypto');
const { redact } = require('./index');

const TERMINAL = new Set(['FAILED', 'QUARANTINED', 'PUBLISHED', 'SUCCEEDED', 'CANCELLED']);
const CRITICAL_KINDS = new Set(['run.started', 'run.queued', 'run.blocked', 'run.retrying', 'run.failed', 'run.quarantined', 'run.published', 'run.succeeded', 'run.cancelled', 'job.claimed', 'job.lease_expired', 'job.retry_scheduled', 'gate.blocked', 'gate.passed', 'gate.failed']);

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function safePayload(value, maxBytes) {
  const sanitized = redact(value && typeof value === 'object' ? value : { value });
  let json;
  try { json = JSON.stringify(sanitized); } catch { json = '{}'; }
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return sanitized;
  return { truncated: true, sha256: createHash('sha256').update(json).digest('hex'), bytes: Buffer.byteLength(json, 'utf8') };
}

function inferStatus(kind, outcome, reason) {
  const value = String(outcome || '').toUpperCase();
  if (['FAILED', 'QUARANTINED', 'PUBLISHED', 'SUCCEEDED', 'CANCELLED', 'BLOCKED', 'QUEUED', 'RETRYING'].includes(value)) return value;
  if (kind === 'run.failed' || kind === 'job.failed') return 'FAILED';
  if (kind === 'run.quarantined') return 'QUARANTINED';
  if (kind === 'run.published') return 'PUBLISHED';
  if (kind === 'run.succeeded') return 'SUCCEEDED';
  if (kind === 'run.cancelled') return 'CANCELLED';
  if (kind === 'run.blocked' || kind === 'gate.blocked') return 'BLOCKED';
  if (kind === 'run.retrying' || kind === 'job.retry_scheduled') return 'RETRYING';
  if (kind === 'run.queued' || kind === 'job.admission_rejected') return 'QUEUED';
  return reason === 'quarantined' ? 'QUARANTINED' : null;
}

class ExecutionTraceStore {
  constructor({ pool, sampleRate = Number(process.env.FORGE_EXECUTION_TRACE_SAMPLE_RATE ?? process.env.FORGE_TRACE_SAMPLE_RATE ?? '0.1'), maxEvents = clampInt(process.env.FORGE_EXECUTION_TRACE_MAX_EVENTS, 100, 100000, 5000), retentionDays = clampInt(process.env.FORGE_EXECUTION_TRACE_RETENTION_DAYS, 1, 3650, 30), maxPayloadBytes = clampInt(process.env.FORGE_EXECUTION_TRACE_MAX_PAYLOAD_BYTES, 512, 65536, 4096), logger = console } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('ExecutionTraceStore requires a pg-compatible pool');
    this.pool = pool;
    this.sampleRate = Math.min(1, Math.max(0, Number(sampleRate) || 0));
    this.maxEvents = maxEvents;
    this.retentionDays = retentionDays;
    this.maxPayloadBytes = maxPayloadBytes;
    this.logger = logger;
  }

  shouldSample(traceId, force = false) {
    if (force) return true;
    const digest = createHash('sha256').update(String(traceId)).digest().readUInt32BE(0) / 0xffffffff;
    return digest < this.sampleRate;
  }

  async ensureTrace({ traceId, correlationId, projectId = null, episodeId = null, tenantId = null, rootKind = null, sampled = null }) {
    const isSampled = sampled == null ? this.shouldSample(traceId) : Boolean(sampled);
    const result = await this.pool.query(`
      INSERT INTO forge_execution_traces(trace_id, correlation_id, tenant_id, project_id, episode_id, root_kind, sampled)
      VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(trace_id) DO UPDATE SET correlation_id=COALESCE(forge_execution_traces.correlation_id,EXCLUDED.correlation_id), tenant_id=COALESCE(forge_execution_traces.tenant_id,EXCLUDED.tenant_id), project_id=COALESCE(forge_execution_traces.project_id,EXCLUDED.project_id), episode_id=COALESCE(forge_execution_traces.episode_id,EXCLUDED.episode_id), root_kind=COALESCE(forge_execution_traces.root_kind,EXCLUDED.root_kind), updated_at=now()
      RETURNING *`, [traceId, String(correlationId || traceId).slice(0, 128), tenantId, projectId, episodeId, rootKind, isSampled]);
    return result.rows[0];
  }

  async resolveTenant(projectId) {
    if (!projectId) return null;
    try {
      const result = await this.pool.query(`SELECT COALESCE(NULLIF(metadata->>'tenantId',''), NULLIF(metadata->>'tenant_id','')) AS tenant_id FROM projects WHERE id=$1`, [projectId]);
      return result.rows[0]?.tenant_id || null;
    } catch { return null; }
  }

  async append({ traceId, correlationId, projectId = null, episodeId = null, tenantId = null, kind, spanId = null, parentSpanId = null, jobId = null, attempt = null, workerId = null, stage = null, outcome = null, reason = null, durationMs = null, eventTime = null, payload = {}, force = false }) {
    if (!traceId || !kind) return null;
    const trace = await this.ensureTrace({ traceId, correlationId, projectId, episodeId, tenantId, rootKind: stage || kind });
    if (!trace.sampled && !force && !CRITICAL_KINDS.has(kind)) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT trace_id,event_count,sampled,last_event_at FROM forge_execution_traces WHERE trace_id=$1 FOR UPDATE`, [traceId]);
      const current = locked.rows[0];
      if (!current) { await client.query('ROLLBACK'); return null; }
      if (Number(current.event_count) >= this.maxEvents && !force) { await client.query('ROLLBACK'); return null; }
      const sequence = Number(current.event_count) + 1;
      const observedAt = new Date();
      const supplied = eventTime ? new Date(eventTime) : observedAt;
      const clockSkewMs = Number.isFinite(supplied.getTime()) ? Math.max(-2147483648, Math.min(2147483647, supplied.getTime() - observedAt.getTime())) : 0;
      const safe = safePayload(payload, this.maxPayloadBytes);
      await client.query(`INSERT INTO forge_execution_events(trace_id,sequence,observed_at,event_time,clock_skew_ms,kind,span_id,parent_span_id,job_id,attempt,worker_id,stage,outcome,reason,duration_ms,sampled,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`, [traceId, sequence, observedAt, Number.isFinite(supplied.getTime()) ? supplied : observedAt, clockSkewMs, String(kind).slice(0,64), spanId, parentSpanId, jobId, attempt, workerId, stage, outcome ? String(outcome).slice(0,32) : null, reason ? String(reason).slice(0,128) : null, durationMs == null ? null : Math.max(0, Math.min(Number(durationMs), 2147483647)), Boolean(trace.sampled || force), JSON.stringify(safe)]);
      const status = inferStatus(kind, outcome, reason);
      const terminal = status && TERMINAL.has(status);
      const snapshot = { lastEvent: kind, lastOutcome: outcome || null, reason: reason || null, sequence, updatedAt: observedAt.toISOString() };
      await client.query(`UPDATE forge_execution_traces SET event_count=$2,last_event_at=$3,updated_at=$3,status=COALESCE($4,status),finished_at=CASE WHEN $5 THEN COALESCE(finished_at,$3) ELSE finished_at END,diagnostic_snapshot=diagnostic_snapshot || $6::jsonb WHERE trace_id=$1`, [traceId, sequence, observedAt, status, terminal, JSON.stringify(snapshot)]);
      await client.query('COMMIT');
      return { sequence, traceId, status, sampled: trace.sampled };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      this.logger?.warn?.(JSON.stringify({ event: 'execution_trace.append_failed', code: error.code, message: error.message }));
      return null;
    } finally { client.release(); }
  }

  async recordAttempt({ traceId, job, workerId, outcome = 'RUNNING', retryable = null, retryCause = null, admission = {}, leaseExpiresAt = null, finishedAt = null }) {
    if (!traceId || !job?.id) return null;
    const tenantId = await this.resolveTenant(job.project_id);
    await this.ensureTrace({ traceId, correlationId: job.correlation_id, projectId: job.project_id, episodeId: job.episode_id, tenantId, rootKind: job.kind });
    const result = await this.pool.query(`INSERT INTO forge_execution_attempts(trace_id,job_id,attempt,worker_id,dispatch_generation,lease_expires_at,started_at,finished_at,outcome,retryable,retry_cause,admission,metadata) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,now()),$8,$9,$10,$11,$12::jsonb,$13::jsonb) ON CONFLICT(job_id,attempt) DO UPDATE SET worker_id=COALESCE(EXCLUDED.worker_id,forge_execution_attempts.worker_id),dispatch_generation=COALESCE(EXCLUDED.dispatch_generation,forge_execution_attempts.dispatch_generation),lease_expires_at=COALESCE(EXCLUDED.lease_expires_at,forge_execution_attempts.lease_expires_at),finished_at=COALESCE(EXCLUDED.finished_at,forge_execution_attempts.finished_at),outcome=EXCLUDED.outcome,retryable=COALESCE(EXCLUDED.retryable,forge_execution_attempts.retryable),retry_cause=COALESCE(EXCLUDED.retry_cause,forge_execution_attempts.retry_cause),admission=forge_execution_attempts.admission || EXCLUDED.admission,metadata=forge_execution_attempts.metadata || EXCLUDED.metadata RETURNING *`, [traceId, job.id, job.attempts || 1, workerId, job.dispatch_generation || null, leaseExpiresAt || job.leased_until || null, job.started_at || null, finishedAt, outcome, retryable, retryCause, JSON.stringify(safePayload(admission, this.maxPayloadBytes)), JSON.stringify(safePayload({ kind: job.kind }, this.maxPayloadBytes))]);
    return result.rows[0];
  }

  async timeline({ traceId, correlationId = null, projectId = null, limit = 1000 } = {}) {
    const bounded = clampInt(limit, 1, this.maxEvents, 1000);
    const params = [bounded];
    let where = 'e.trace_id=$2';
    params.push(traceId);
    if (!traceId && correlationId) { params[1] = correlationId; where = 't.correlation_id=$2'; }
    if (!traceId && !correlationId) throw new TypeError('traceId or correlationId is required');
    if (projectId) { params.push(projectId); where += ` AND t.project_id=$${params.length}`; }
    const result = await this.pool.query(`SELECT e.* FROM forge_execution_events e JOIN forge_execution_traces t ON t.trace_id=e.trace_id WHERE ${where} ORDER BY e.sequence ASC LIMIT $1`, params);
    return result.rows;
  }

  async diagnosticSnapshot({ traceId, correlationId = null, projectId = null, limit = 1000 } = {}) {
    const params = [];
    let where = traceId ? 't.trace_id=$1' : 't.correlation_id=$1';
    params.push(traceId || correlationId);
    if (projectId) { params.push(projectId); where += ` AND t.project_id=$${params.length}`; }
    const traceResult = await this.pool.query(`SELECT * FROM forge_execution_traces t WHERE ${where} LIMIT 1`, params);
    const trace = traceResult.rows[0];
    if (!trace) return null;
    const events = await this.timeline({ traceId: trace.trace_id, limit });
    const attempts = (await this.pool.query(`SELECT * FROM forge_execution_attempts WHERE trace_id=$1 ORDER BY started_at ASC,id ASC LIMIT $2`, [trace.trace_id, clampInt(limit, 1, this.maxEvents, 1000)])).rows;
    const blockers = events.filter(e => ['BLOCKED', 'FAILED', 'RETRYING'].includes(String(e.outcome || '').toUpperCase()) || ['run.blocked', 'gate.blocked', 'job.retry_scheduled', 'job.lease_expired'].includes(e.kind)).map(e => ({ sequence: e.sequence, kind: e.kind, outcome: e.outcome, reason: e.reason, stage: e.stage, jobId: e.job_id, attempt: e.attempt }));
    const status = trace.status;
    return { trace: { traceId: trace.trace_id, correlationId: trace.correlation_id, tenantId: trace.tenant_id, projectId: trace.project_id, episodeId: trace.episode_id, status, sampled: trace.sampled, startedAt: trace.started_at, finishedAt: trace.finished_at }, eventCount: trace.event_count, timeline: events, attempts, blockers, deterministic: true };
  }

  async prune() {
    const result = await this.pool.query(`DELETE FROM forge_execution_traces WHERE last_event_at < now() - ($1::text || ' days')::interval RETURNING trace_id`, [this.retentionDays]);
    return result.rowCount;
  }
}

module.exports = { ExecutionTraceStore, safePayload, inferStatus };
