'use strict';

const crypto = require('node:crypto');

const DEFAULT_POLICY = Object.freeze({
  windowSize: 20,
  failureThreshold: 5,
  failureRateThreshold: 0.5,
  recoveryMs: 30_000,
  probeLeaseMs: 15_000,
  maxCandidates: 8,
  latencyWeight: 1,
  successWeight: 100,
});

function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function normalizePolicy(policy = {}) {
  const p = { ...DEFAULT_POLICY, ...policy };
  for (const k of ['windowSize', 'failureThreshold', 'recoveryMs', 'probeLeaseMs', 'maxCandidates']) if (!Number.isInteger(p[k]) || p[k] < 1) throw new TypeError(`${k} must be a positive integer`);
  if (!(p.failureRateThreshold >= 0 && p.failureRateThreshold <= 1)) throw new TypeError('failureRateThreshold must be 0..1');
  return Object.freeze(p);
}
function candidateScope(candidate, context) {
  if (candidate.disabled) return { ok: false, reason: 'DISABLED' };
  if (candidate.tenantId && candidate.tenantId !== context.tenantId) return { ok: false, reason: 'TENANT_MISMATCH' };
  if (Array.isArray(candidate.tenantIds) && !candidate.tenantIds.includes(context.tenantId)) return { ok: false, reason: 'TENANT_MISMATCH' };
  if (candidate.projectId && candidate.projectId !== context.projectId) return { ok: false, reason: 'PROJECT_MISMATCH' };
  if (Array.isArray(candidate.projectIds) && !candidate.projectIds.includes(context.projectId)) return { ok: false, reason: 'PROJECT_MISMATCH' };
  if (candidate.releaseEpoch && context.releaseEpoch && candidate.releaseEpoch !== context.releaseEpoch) return { ok: false, reason: 'RELEASE_EPOCH_MISMATCH' };
  if (candidate.credentialVersion != null && context.credentialVersion != null && String(candidate.credentialVersion) !== String(context.credentialVersion)) return { ok: false, reason: 'CREDENTIAL_VERSION_MISMATCH' };
  if (candidate.capabilities && context.capability && !candidate.capabilities.includes(context.capability)) return { ok: false, reason: 'CAPABILITY_MISMATCH' };
  if (candidate.models && context.model && !candidate.models.includes(context.model)) return { ok: false, reason: 'MODEL_MISMATCH' };
  if (candidate.operations && context.operation && !candidate.operations.includes(context.operation)) return { ok: false, reason: 'OPERATION_MISMATCH' };
  if (!context.tenantId && !candidate.global) return { ok: false, reason: 'TENANT_REQUIRED' };
  return { ok: true };
}

class ProviderHealthRouter {
  constructor({ pool = null, reliability = null, metrics = null, logger = console, policy = {} } = {}) { this.pool = pool; this.reliability = reliability; this.metrics = metrics || { increment() {}, gauge() {} }; this.logger = logger; this.policy = normalizePolicy(policy); }
  async ensureState(client, context, candidate) { await client.query(`INSERT INTO provider_health_state(tenant_id,project_id,provider,model,operation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [context.tenantId, context.projectId || null, candidate.name, context.model || candidate.model || '', context.operation || 'execute']); }
  async state(context, candidate) {
    if (!this.pool) return { state: 'CLOSED', successRate: 1, failureRate: 0, latencyMs: 0, consecutiveFailures: 0 };
    await this.ensureState(this.pool, context, candidate);
    const row = (await this.pool.query(`SELECT state,success_count,failure_count,latency_ewma_ms,consecutive_failures,opened_at,cooldown_until,probe_owner,probe_until,version FROM provider_health_state WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND model=$4 AND operation=$5`, [context.tenantId, context.projectId || null, candidate.name, context.model || candidate.model || '', context.operation || 'execute'])).rows[0];
    const total = Number(row.success_count) + Number(row.failure_count);
    return { ...row, successRate: total ? Number(row.success_count) / total : 1, failureRate: total ? Number(row.failure_count) / total : 0, latencyMs: Number(row.latency_ewma_ms || 0) };
  }
  async acquire(context, candidate) {
    if (!this.pool) return { allowed: true, state: 'CLOSED', probeToken: null };
    const token = `${candidate.name}:${crypto.randomUUID()}`; await this.ensureState(this.pool, context, candidate);
    const values = [context.tenantId, context.projectId || null, candidate.name, context.model || candidate.model || '', context.operation || 'execute', token, this.policy.probeLeaseMs];
    const promoted = await this.pool.query(`UPDATE provider_health_state SET state='HALF_OPEN',probe_owner=$6,probe_until=now()+($7::int*interval '1 millisecond'),updated_at=now(),version=version+1 WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND model=$4 AND operation=$5 AND state='OPEN' AND cooldown_until <= now() RETURNING version`, values);
    if (promoted.rowCount) return { allowed: true, state: 'HALF_OPEN', probeToken: token };
    const stolen = await this.pool.query(`UPDATE provider_health_state SET probe_owner=$6,probe_until=now()+($7::int*interval '1 millisecond'),updated_at=now(),version=version+1 WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND model=$4 AND operation=$5 AND state='HALF_OPEN' AND (probe_until IS NULL OR probe_until < now()) RETURNING version`, values);
    if (stolen.rowCount) return { allowed: true, state: 'HALF_OPEN', probeToken: token };
    const row = await this.state(context, candidate);
    if (row.state === 'OPEN') return { allowed: false, state: 'OPEN', retryAfterMs: Math.max(0, Date.parse(row.cooldown_until) - Date.now()) };
    if (row.state === 'HALF_OPEN') return { allowed: false, state: 'HALF_OPEN', retryAfterMs: 100 };
    return { allowed: true, state: row.state, probeToken: token };
  }
  async outcome(context, candidate, outcome) {
    const eventId = outcome.eventId || sha256([context.idempotencyKey || '', candidate.name, context.operation || '', outcome.attemptId || '', outcome.outcome, outcome.observedAt || ''].join('|')); if (!this.pool) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`INSERT INTO provider_health_events(event_id,tenant_id,project_id,provider,model,operation,outcome,latency_ms,error_class,attempt_id,idempotency_key,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`, [eventId, context.tenantId, context.projectId || null, candidate.name, context.model || candidate.model || '', context.operation || 'execute', outcome.outcome, Math.max(0, Number(outcome.latencyMs || 0)), outcome.errorClass || null, outcome.attemptId || null, context.idempotencyKey || null, JSON.stringify(outcome.metadata || {})]);
      if (!inserted.rowCount) { await client.query('ROLLBACK'); return; }
      const fresh = (await client.query(`SELECT state,success_count,failure_count,consecutive_failures FROM provider_health_state WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND model=$4 AND operation=$5 FOR UPDATE`, [context.tenantId, context.projectId || null, candidate.name, context.model || candidate.model || '', context.operation || 'execute'])).rows[0]; if (!fresh) throw new Error('provider health state missing');
      const window = (await client.query(`SELECT COUNT(*) FILTER (WHERE outcome='SUCCESS')::int AS success_count,COUNT(*) FILTER (WHERE outcome IN ('TRANSIENT_FAILURE','TIMEOUT','RATE_LIMIT'))::int AS failure_count FROM (SELECT outcome FROM provider_health_events WHERE tenant_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND provider=$3 AND model=$4 AND operation=$5 ORDER BY observed_at DESC,event_id DESC LIMIT $6) recent`, [context.tenantId, context.projectId || null, candidate.name, context.model || candidate.model || '', context.operation || 'execute', this.policy.windowSize])).rows[0];
      const success = outcome.outcome === 'SUCCESS'; const nextSuccess = Number(window.success_count || 0); const nextFailure = Number(window.failure_count || 0); const total = nextSuccess + nextFailure; const failureRate = total ? nextFailure / total : 0; const failureCounts = ['TRANSIENT_FAILURE', 'TIMEOUT', 'RATE_LIMIT'].includes(outcome.outcome); const shouldOpen = failureCounts && (nextFailure >= this.policy.failureThreshold || (total >= this.policy.windowSize && failureRate >= this.policy.failureRateThreshold)); const nextState = success ? 'CLOSED' : (shouldOpen || fresh.state === 'HALF_OPEN' ? 'OPEN' : fresh.state); const cooldown = nextState === 'OPEN' ? `now()+(${this.policy.recoveryMs}*interval '1 millisecond')` : 'NULL';
      await client.query(`UPDATE provider_health_state SET success_count=$6::bigint,failure_count=$7::bigint,consecutive_failures=CASE WHEN $8 THEN 0 ELSE LEAST(consecutive_failures+1,$9) END,state=$10,opened_at=CASE WHEN $10='OPEN' THEN COALESCE(opened_at,now()) ELSE NULL END,cooldown_until=${cooldown},probe_owner=NULL,probe_until=NULL,latency_ewma_ms=CASE WHEN $11>0 THEN CASE WHEN latency_ewma_ms=0 THEN $11 ELSE (latency_ewma_ms*0.8)+($11*0.2) END ELSE latency_ewma_ms END,updated_at=now(),last_event_id=$1,version=version+1 WHERE tenant_id=$2 AND project_id IS NOT DISTINCT FROM $3 AND provider=$4 AND model=$5 AND operation=$12`, [eventId, context.tenantId, context.projectId || null, candidate.name, context.model || candidate.model || '', nextSuccess, nextFailure, success, this.policy.failureThreshold, nextState, Math.max(0, Number(outcome.latencyMs || 0)), context.operation || 'execute']);
      await client.query('COMMIT'); this.metrics.increment('forge_provider_health_events_total', { provider: candidate.name, outcome: outcome.outcome }); this.metrics.gauge('forge_provider_health_latency_ms', { provider: candidate.name, operation: context.operation || 'execute' }, Math.max(0, Number(outcome.latencyMs || 0)));
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  score(state, candidate) { const priority = Number.isFinite(Number(candidate.priority)) ? Number(candidate.priority) : 0; return (priority * 100000) + (state.successRate * this.policy.successWeight) - (state.latencyMs * this.policy.latencyWeight / 1000); }
  async route({ candidates, context = {}, request, policy = {} }) {
    const p = normalizePolicy({ ...this.policy, ...policy }); if (!Array.isArray(candidates) || !candidates.length) throw Object.assign(new Error('No provider candidates supplied'), { code: 'NO_PROVIDER_CANDIDATES' }); const excluded = new Set(context.excludeProviders || []);
    const compatible = candidates.map((candidate) => ({ candidate, scope: candidateScope(candidate, context) })).filter((x) => x.scope.ok && !excluded.has(String(x.candidate.name))).slice(0, p.maxCandidates); if (!compatible.length) throw Object.assign(new Error('No provider satisfies tenant/project/capability/credential/release constraints'), { code: 'NO_COMPATIBLE_PROVIDER' });
    const ranked = []; for (const item of compatible) { const health = await this.state(context, item.candidate); if (health.state === 'OPEN') continue; ranked.push({ ...item, health, score: this.score(health, item.candidate) }); } ranked.sort((a, b) => b.score - a.score || String(a.candidate.name).localeCompare(String(b.candidate.name)));
    for (const item of ranked) { if (context.admitCapacity && !(await context.admitCapacity(item.candidate, context))) continue; if (context.admitBudget && !(await context.admitBudget(item.candidate, context))) continue; if (context.credentialFence && !(await context.credentialFence(item.candidate, context))) continue; const gate = await this.acquire(context, item.candidate); if (!gate.allowed) continue; const decisionId = sha256(JSON.stringify({ idempotencyKey: context.idempotencyKey, provider: item.candidate.name, model: context.model || item.candidate.model || '', operation: context.operation, releaseEpoch: context.releaseEpoch, credentialVersion: context.credentialVersion })).slice(0, 48); const decision = { decisionId, provider: item.candidate.name, model: context.model || item.candidate.model || null, operation: context.operation, score: item.score, state: gate.state, probeToken: gate.probeToken }; await this.recordDecision(context, item.candidate, decision, ranked.filter((r) => r.candidate.name !== item.candidate.name)); return { candidate: item.candidate, decision, health: item.health, ranked }; }
    throw Object.assign(new Error('All compatible providers are unavailable or rejected by admission controls'), { code: 'PROVIDER_CAPACITY_OR_HEALTH_EXHAUSTED' });
  }
  async recordDecision(context, candidate, decision, rejected = []) { if (!this.pool) return; await this.pool.query(`INSERT INTO provider_routing_decisions(decision_id,tenant_id,project_id,provider,model,operation,credential_version,release_epoch,score,state,rejected_candidates,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) ON CONFLICT(decision_id) DO NOTHING`, [decision.decisionId, context.tenantId, context.projectId || null, candidate.name, context.model || candidate.model || '', context.operation || 'execute', context.credentialVersion == null ? null : String(context.credentialVersion), context.releaseEpoch || null, decision.score, decision.state, JSON.stringify(rejected.map((r) => ({ provider: r.candidate?.name, reason: r.scope?.reason || 'RANKED_LOWER' }))), context.idempotencyKey || null]); }
  async execute({ candidates, context = {}, request, policy = {} }) {
    if (context.idempotent === false || context.allowFailover !== true) {
      const route = await this.route({ candidates, context, request, policy }); const startedAt = Date.now();
      try { const execution = this.reliability ? await this.reliability.execute({ provider: route.candidate, operation: context.operation, request, context: { ...context, idempotencyKey: context.idempotencyKey }, policy: policy.reliability || {}, fallbacks: [], contract: { idempotent: context.idempotent !== false, allowFailover: false, contractCompatible: true } }) : await route.candidate.execute(request, context); await this.outcome(context, route.candidate, { outcome: 'SUCCESS', latencyMs: execution?.latencyMs || Date.now() - startedAt, attemptId: execution?.attemptId, eventId: route.decision.decisionId + ':success' }); return { ...execution, routing: route.decision };
      } catch (error) { const errorClass = error.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : error.code === 'RATE_LIMITED' ? 'RATE_LIMIT' : error.retryable ? 'TRANSIENT_FAILURE' : 'TERMINAL'; await this.outcome(context, route.candidate, { outcome: errorClass, latencyMs: error.latencyMs || Date.now() - startedAt, attemptId: error.attemptId, errorClass: error.code || errorClass, eventId: route.decision.decisionId + ':failure' }); throw error; }
    }
    const attempted = new Set(context.excludeProviders || []); let lastError;
    for (let index = 0; index < this.policy.maxCandidates; index += 1) {
      const route = await this.route({ candidates, context: { ...context, excludeProviders: [...attempted] }, request, policy }); const startedAt = Date.now(); attempted.add(String(route.candidate.name));
      try { const execution = this.reliability ? await this.reliability.execute({ provider: route.candidate, operation: context.operation, request, context: { ...context, idempotencyKey: context.idempotencyKey }, policy: policy.reliability || {}, fallbacks: [], contract: { idempotent: true, allowFailover: false, contractCompatible: true } }) : await route.candidate.execute(request, context); await this.outcome(context, route.candidate, { outcome: 'SUCCESS', latencyMs: execution?.latencyMs || Date.now() - startedAt, attemptId: execution?.attemptId, eventId: route.decision.decisionId + ':success' }); return { ...execution, routing: route.decision };
      } catch (error) { lastError = error; const errorClass = error.code === 'PROVIDER_TIMEOUT' ? 'TIMEOUT' : error.code === 'RATE_LIMITED' ? 'RATE_LIMIT' : error.retryable ? 'TRANSIENT_FAILURE' : 'TERMINAL'; await this.outcome(context, route.candidate, { outcome: errorClass, latencyMs: error.latencyMs || Date.now() - startedAt, attemptId: error.attemptId, errorClass: error.code || errorClass, eventId: route.decision.decisionId + ':failure' }); if (!error.retryable) throw error; }
    }
    throw lastError || Object.assign(new Error('Provider failover exhausted'), { code: 'PROVIDER_FAILOVER_EXHAUSTED' });
  }
  async diagnostics({ tenantId = null, projectId = null, provider = null } = {}) { if (!this.pool) return []; const values = []; const where = []; if (tenantId) { values.push(tenantId); where.push(`tenant_id=$${values.length}`); } if (projectId) { values.push(projectId); where.push(`project_id=$${values.length}`); } if (provider) { values.push(provider); where.push(`provider=$${values.length}`); } return (await this.pool.query(`SELECT tenant_id,project_id,provider,model,operation,state,success_count,failure_count,consecutive_failures,latency_ewma_ms,opened_at,cooldown_until,probe_owner,probe_until,updated_at,version FROM provider_health_state ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY tenant_id,project_id,provider,model,operation`, values)).rows; }
}

module.exports = { ProviderHealthRouter, DEFAULT_POLICY, candidateScope, normalizePolicy, sha256 };
