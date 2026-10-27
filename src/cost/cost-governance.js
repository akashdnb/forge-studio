'use strict';
const crypto = require('node:crypto');

const TERMINAL = new Set(['COMMITTED', 'RELEASED', 'EXPIRED']);
const CATEGORIES = Object.freeze({ PROVIDER: 'provider', RUNNER: 'runner', MEDIA: 'media', STORAGE: 'storage', PUBLISHING: 'publishing', WORKFLOW: 'workflow' });
const SUPPORTED_UNITS = new Set(['request', 'second', 'byte', 'input_unit', 'output_unit', 'cpu_ms', 'custom']);
const SCOPES = new Set(['GLOBAL', 'TENANT', 'PROJECT', 'EPISODE', 'RUN', 'PROVIDER']);

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function finite(value, fallback = 0) { if (value == null || value === '') return fallback; const n = Number(value); if (!Number.isFinite(n) || n < 0) throw new TypeError('cost value must be a non-negative finite number'); return n; }
function text(value, name, max = 256) { if (typeof value !== 'string' || !value || value.length > max) throw new TypeError(`${name} is invalid`); return value; }
function categoryForJob(kind = '', payload = {}) {
  const k = String(kind || '').toLowerCase();
  if (k.startsWith('publish:') || k.includes('publish')) return CATEGORIES.PUBLISHING;
  if (k.includes('runner') || k.includes('github') || k.includes('execution')) return CATEGORIES.RUNNER;
  if (k.includes('render') || k.includes('transcri') || k.includes('narrat') || k.includes('media') || payload.mediaCompute) return CATEGORIES.MEDIA;
  if (k.includes('artifact') || k.includes('storage') || payload.storageOperation) return CATEGORIES.STORAGE;
  if (payload.provider || payload.model || payload.providerRunId) return CATEGORIES.PROVIDER;
  return CATEGORIES.WORKFLOW;
}
function operationForJob(job) { return String(job.payload?.operation || job.kind || 'workflow').slice(0, 128); }
function providerForJob(job) { return String(job.payload?.provider || job.payload?.providerName || job.kind || 'forge').slice(0, 128); }
function runForJob(job) { return job.payload?.runId || job.payload?.run_id || job.payload?.executionRunId || job.payload?.providerRunId || null; }
function unitsFor(unitType, usage = {}) {
  switch (unitType) {
    case 'request': return 1;
    case 'second': return finite(usage.durationMs) / 1000;
    case 'byte': return finite(usage.inputBytes) + finite(usage.outputBytes) + finite(usage.bytes);
    case 'input_unit': return finite(usage.inputUnits);
    case 'output_unit': return finite(usage.outputUnits);
    case 'cpu_ms': return finite(usage.cpuMs);
    case 'custom': return finite(usage.units);
    default: throw Object.assign(new Error(`Unsupported pricing unit ${unitType}`), { code: 'COST_RATE_INVALID' });
  }
}

class CostGovernanceError extends Error { constructor(message, code = 'COST_GOVERNANCE_ERROR', details = {}) { super(message); this.code = code; this.details = details; } }
class CostBudgetRejectedError extends CostGovernanceError { constructor(message, details = {}) { super(message, 'COST_BUDGET_REJECTED', details); this.statusCode = 429; } }

class CostGovernanceService {
  constructor({ pool, clock = () => new Date(), required = process.env.FORGE_COST_ENFORCEMENT_ENABLED === 'true', reservationTtlMs = Number.parseInt(process.env.FORGE_COST_RESERVATION_TTL_MS || process.env.FORGE_USAGE_RESERVATION_TTL_MS || '900000', 10), logger = console } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('A pg-compatible pool is required');
    if (!Number.isFinite(reservationTtlMs) || reservationTtlMs < 1000) throw new TypeError('reservationTtlMs must be >= 1000');
    this.pool = pool; this.clock = clock; this.required = Boolean(required); this.reservationTtlMs = reservationTtlMs; this.logger = logger;
  }
  async tx(fn) { const c = await this.pool.connect(); try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; } finally { c.release(); } }
  async resolveAttribution(c, job) {
    let projectId = job.project_id || null; let episodeId = job.episode_id || null; let tenantId = job.tenant_id || job.payload?.tenantId || null;
    if (episodeId) {
      const r = await c.query('SELECT e.id episode_id,e.project_id,p.tenant_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1', [episodeId]);
      if (!r.rows[0]) throw new CostGovernanceError('episode attribution not found', 'COST_ATTRIBUTION_NOT_FOUND');
      if (projectId && projectId !== r.rows[0].project_id) throw new CostGovernanceError('job project and episode project mismatch', 'COST_ATTRIBUTION_MISMATCH');
      projectId = r.rows[0].project_id; tenantId = tenantId || r.rows[0].tenant_id;
      if (tenantId !== r.rows[0].tenant_id) throw new CostGovernanceError('job tenant and project tenant mismatch', 'TENANT_ISOLATION');
    } else if (projectId) {
      const r = await c.query('SELECT tenant_id FROM projects WHERE id=$1', [projectId]);
      if (!r.rows[0]) throw new CostGovernanceError('project attribution not found', 'COST_ATTRIBUTION_NOT_FOUND');
      tenantId = tenantId || r.rows[0].tenant_id;
      if (tenantId !== r.rows[0].tenant_id) throw new CostGovernanceError('job tenant and project tenant mismatch', 'TENANT_ISOLATION');
    }
    if (this.required && !tenantId) throw new CostGovernanceError('tenant attribution is required for cost enforcement', 'TENANT_SCOPE_REQUIRED');
    return { tenantId, projectId, episodeId, runId: runForJob(job) };
  }
  async rate({ providerType, provider, model = '', operation }) {
    const r = await this.pool.query(`SELECT * FROM cost_rate_versions WHERE active=true AND effective_at<=now() AND provider_type=$1 AND operation=$2 AND (provider=$3 OR provider='') AND (model=$4 OR model='') ORDER BY (provider<>'' ) DESC,(model<>'' ) DESC,effective_at DESC,id DESC LIMIT 1`, [providerType, operation, provider, model]);
    return r.rows[0] || null;
  }
  async estimate({ providerType, provider, model = '', operation, usage = {} }) {
    const rate = await this.rate({ providerType, provider, model, operation });
    if (!rate) {
      if (this.required) throw new CostGovernanceError(`No cost rate configured for ${providerType}/${provider}/${model}/${operation}`, 'COST_RATE_UNAVAILABLE');
      return { rate: null, units: 0, cost: 0, normalizedCost: 0, currency: 'USD', normalizedCurrency: 'USD', fxRate: 1 };
    }
    const units = unitsFor(rate.unit_type, usage); const cost = units * Number(rate.unit_price); const fxRate = Number(rate.fx_rate_to_normalized || 1);
    if (!Number.isFinite(fxRate) || fxRate <= 0) throw new CostGovernanceError('invalid FX rate in cost rate', 'COST_RATE_INVALID');
    return { rate, units, cost, normalizedCost: cost * fxRate, currency: rate.currency, normalizedCurrency: rate.normalized_currency, fxRate };
  }
  async syncConfiguration({ pricing = [], budgets = [] } = {}) {
    const configuredPricing = pricing.length ? pricing : (process.env.FORGE_USAGE_PRICING_JSON ? JSON.parse(process.env.FORGE_USAGE_PRICING_JSON) : []);
    const configuredBudgets = budgets.length ? budgets : (process.env.FORGE_USAGE_BUDGETS_JSON ? JSON.parse(process.env.FORGE_USAGE_BUDGETS_JSON) : []);
    for (const p of configuredPricing) await this.configureRate({ providerType: p.providerType || 'workflow', provider: p.provider || '', model: p.model || '', operation: p.operation, unitType: p.unitType || 'request', unitPrice: p.unitPrice, currency: (p.currency || 'USD').toUpperCase(), normalizedCurrency: (p.normalizedCurrency || p.currency || 'USD').toUpperCase(), fxRateToNormalized: p.fxRateToNormalized ?? 1, version: p.configVersion || p.version || 'env-v1', actor: 'configuration-sync' });
    for (const b of configuredBudgets) await this.configureBudget({ scopeType: b.scopeType, scopeId: b.scopeId, periodKey: b.periodKey || 'lifetime', periodStart: b.periodStart || null, periodEnd: b.periodEnd || null, hardCostLimit: b.hardCostLimit ?? null, softCostLimit: b.softCostLimit ?? null, hardUsageLimit: b.hardUsageLimit ?? null, softUsageLimit: b.softUsageLimit ?? null, softPriorityFloor: b.softPriorityFloor ?? 100, currency: (b.currency || 'USD').toUpperCase(), actor: 'configuration-sync', metadata: b.metadata || {}, configVersion: b.configVersion || 'env-v1' });
    return { pricing: configuredPricing.length, budgets: configuredBudgets.length };
  }
  async configureRate({ providerType, provider = '', model = '', operation, unitType = 'request', unitPrice, currency = 'USD', normalizedCurrency = currency, fxRateToNormalized = 1, version, effectiveAt = null, actor = 'operator' }) {
    text(providerType, 'providerType', 64); text(operation, 'operation', 128); if (!SUPPORTED_UNITS.has(unitType)) throw new TypeError('invalid cost unit'); const price = finite(unitPrice); const fx = Number(fxRateToNormalized); if (!Number.isFinite(fx) || fx <= 0) throw new TypeError('fxRateToNormalized must be positive'); text(version, 'version', 128); text(actor, 'actor', 128);
    const r = await this.pool.query(`INSERT INTO cost_rate_versions(provider_type,provider,model,operation,unit_type,unit_price,currency,normalized_currency,fx_rate_to_normalized,version,active,effective_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,COALESCE($11::timestamptz,now()),$12) ON CONFLICT(provider_type,provider,model,operation,version) DO NOTHING RETURNING *`, [providerType, provider, model, operation, unitType, price, String(currency).toUpperCase(), String(normalizedCurrency).toUpperCase(), fx, version, effectiveAt, actor]);
    if (r.rows[0]) return r.rows[0]; return (await this.pool.query('SELECT * FROM cost_rate_versions WHERE provider_type=$1 AND provider=$2 AND model=$3 AND operation=$4 AND version=$5', [providerType, provider, model, operation, version])).rows[0];
  }
  async configureBudget({ scopeType, scopeId, periodKey = 'lifetime', periodStart = null, periodEnd = null, hardCostLimit = null, softCostLimit = null, hardUsageLimit = null, softUsageLimit = null, softPriorityFloor = 100, currency = 'USD', actor = 'operator', metadata = {}, configVersion = 'operator-v1' }) {
    if (!SCOPES.has(scopeType)) throw new TypeError('invalid budget scope'); text(scopeId, 'scopeId', 256); text(actor, 'actor', 128); if (hardCostLimit != null && finite(hardCostLimit) < 0) throw new TypeError('hardCostLimit invalid');
    return this.tx(async (c) => {
      if (scopeType === 'PROJECT') { const r = await c.query('SELECT tenant_id FROM projects WHERE id=$1', [scopeId]); if (!r.rows[0]) throw new CostGovernanceError('project not found', 'NOT_FOUND'); }
      if (scopeType === 'EPISODE') { const r = await c.query('SELECT e.id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1', [scopeId]); if (!r.rows[0]) throw new CostGovernanceError('episode not found', 'NOT_FOUND'); }
      const next = Number((await c.query('SELECT COALESCE(MAX(epoch),0)+1 epoch FROM cost_budget_epochs WHERE scope_type=$1 AND scope_id=$2 AND period_key=$3 AND currency=$4', [scopeType, scopeId, periodKey, String(currency).toUpperCase()])).rows[0].epoch);
      await c.query('UPDATE cost_budget_epochs SET active=false,retired_at=now() WHERE scope_type=$1 AND scope_id=$2 AND period_key=$3 AND currency=$4 AND active=true', [scopeType, scopeId, periodKey, String(currency).toUpperCase()]);
      return (await c.query(`INSERT INTO cost_budget_epochs(scope_type,scope_id,epoch,period_key,period_start,period_end,hard_cost_limit,soft_cost_limit,hard_usage_limit,soft_usage_limit,soft_priority_floor,currency,config_version,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) RETURNING *`, [scopeType, scopeId, next, periodKey, periodStart, periodEnd, hardCostLimit == null ? null : finite(hardCostLimit), softCostLimit == null ? null : finite(softCostLimit), hardUsageLimit == null ? null : finite(hardUsageLimit), softUsageLimit == null ? null : finite(softUsageLimit), Number(softPriorityFloor), String(currency).toUpperCase(), configVersion, JSON.stringify(metadata || {}), actor])).rows[0];
    });
  }
  async applicableBudgets(c, attribution, provider, normalizedCurrency) {
    const scopes = [['GLOBAL', 'global'], ['TENANT', attribution.tenantId], ['PROJECT', attribution.projectId], ['EPISODE', attribution.episodeId], ['RUN', attribution.runId], ['PROVIDER', provider]].filter(([, id]) => id);
    const rows = (await c.query(`SELECT * FROM cost_budget_epochs WHERE active=true AND currency=$1 AND (period_start IS NULL OR period_start<=now()) AND (period_end IS NULL OR period_end>now()) AND (scope_type,scope_id) IN (${scopes.map((_, i) => `($${i * 2 + 2},$${i * 2 + 3})`).join(',')}) ORDER BY scope_type,scope_id,epoch DESC FOR UPDATE`, [normalizedCurrency, ...scopes.flat()])).rows;
    return scopes.map(([type, id]) => rows.find((r) => r.scope_type === type && r.scope_id === id)).filter(Boolean);
  }
  async totals(c, budget) {
    const params = [budget.id]; const clauses = ['budget_epoch_id=$1'];
    const events = (await c.query(`SELECT COALESCE(SUM(normalized_cost),0)::numeric amount,COALESCE(SUM(usage_units),0)::numeric units FROM cost_events WHERE ${clauses.join(' AND ')} AND outcome NOT IN ('REJECTED','EXPIRED')`, params)).rows[0];
    const held = (await c.query(`SELECT COALESCE(SUM(estimated_normalized_cost),0)::numeric amount,COALESCE(SUM(estimated_units),0)::numeric units FROM cost_reservations WHERE budget_epoch_ids @> jsonb_build_array($1::bigint) AND status='HELD' AND expires_at>now()`, [budget.id])).rows[0];
    const adjustments = (await c.query(`SELECT COALESCE(SUM(normalized_amount),0)::numeric amount FROM cost_adjustments WHERE budget_epoch_id=$1`, [budget.id])).rows[0];
    return { cost: Number(events.amount || 0) + Number(held.amount || 0) + Number(adjustments.amount || 0), units: Number(events.units || 0) + Number(held.units || 0) };
  }
  async activeOverride(c, attribution, jobId, currency, requiredExtra) {
    if (requiredExtra <= 0) return null;
    const rows = (await c.query(`SELECT o.*,COALESCE((SELECT SUM(e.normalized_cost) FROM cost_events e WHERE e.override_id=o.id),0)+COALESCE((SELECT SUM(r.estimated_normalized_cost) FROM cost_reservations r WHERE r.override_id=o.id AND r.status='HELD'),0) consumed FROM cost_budget_overrides o WHERE o.currency=$1 AND o.expires_at>now() AND o.tenant_id=$2 AND (o.target_job_id=$3 OR o.target_job_id IS NULL) ORDER BY CASE WHEN o.target_job_id=$3 THEN 0 ELSE 1 END,o.created_at DESC FOR UPDATE`, [currency, attribution.tenantId, jobId])).rows;
    return rows.find((r) => Number(r.amount) - Number(r.consumed) >= requiredExtra) || null;
  }
  async reserveForJob({ job, providerType = categoryForJob(job.kind, job.payload), provider = providerForJob(job), model = job.payload?.model || '', operation = operationForJob(job), usage = job.payload?.usageEstimate || {}, attempt = Number(job.attempts) || 1, priority = Number(job.priority ?? 100), idempotencyKey = null }) {
    const key = idempotencyKey || `cost:${job.id}:attempt:${attempt}`;
    return this.tx(async (c) => {
      const existing = (await c.query('SELECT * FROM cost_reservations WHERE idempotency_key=$1 FOR UPDATE', [key])).rows[0];
      if (existing) { if (existing.status === 'HELD' && new Date(existing.expires_at) > this.clock()) return { allowed: true, reservation: existing, reused: true }; if (TERMINAL.has(existing.status)) return { allowed: false, reason: `RESERVATION_${existing.status}`, reservation: existing }; }
      const attribution = await this.resolveAttribution(c, job); const estimate = await this.estimate({ providerType, provider, model, operation, usage });
      const budgets = await this.applicableBudgets(c, attribution, provider, estimate.normalizedCurrency);
      if (this.required && !budgets.some((b) => b.scope_type === 'GLOBAL')) throw new CostGovernanceError('No global cost budget is configured; cost admission is fail-closed', 'COST_BUDGET_CONFIGURATION_UNAVAILABLE');
      if (this.required && budgets.length === 0) throw new CostGovernanceError(`No cost budget uses normalized currency ${estimate.normalizedCurrency}`, 'COST_CURRENCY_UNAVAILABLE');
      let softExceeded = false; let override = null;
      for (const budget of budgets) {
        const total = await this.totals(c, budget); const projected = total.cost + estimate.normalizedCost;
        if (budget.hard_cost_limit != null && projected > Number(budget.hard_cost_limit)) {
          const extra = projected - Number(budget.hard_cost_limit); const candidate = await this.activeOverride(c, attribution, job.id, budget.currency, extra);
          if (!candidate) throw new CostBudgetRejectedError(`${budget.scope_type} hard cost budget exhausted`, { scopeType: budget.scope_type, scopeId: budget.scope_id, epoch: budget.epoch, projected, limit: Number(budget.hard_cost_limit), priority });
          override = candidate;
        }
        if (budget.hard_usage_limit != null && total.units + estimate.units > Number(budget.hard_usage_limit)) throw new CostBudgetRejectedError(`${budget.scope_type} hard usage budget exhausted`, { scopeType: budget.scope_type, scopeId: budget.scope_id, epoch: budget.epoch, projected: total.units + estimate.units, limit: Number(budget.hard_usage_limit), priority });
        if (budget.soft_cost_limit != null && projected > Number(budget.soft_cost_limit)) { softExceeded = true; if (priority > Number(budget.soft_priority_floor || 100)) throw new CostBudgetRejectedError(`${budget.scope_type} soft budget requires higher priority`, { scopeType: budget.scope_type, scopeId: budget.scope_id, priority, softPriorityFloor: Number(budget.soft_priority_floor || 100) }); }
        if (budget.soft_usage_limit != null && total.units + estimate.units > Number(budget.soft_usage_limit)) { softExceeded = true; if (priority > Number(budget.soft_priority_floor || 100)) throw new CostBudgetRejectedError(`${budget.scope_type} soft usage budget requires higher priority`, { scopeType: budget.scope_type, scopeId: budget.scope_id, priority, softPriorityFloor: Number(budget.soft_priority_floor || 100) }); }
      }
      const budgetIds = budgets.map((b) => Number(b.id)); const reservationId = `cost-reservation:${digest({key,tenantId:attribution.tenantId,attempt})}`;
      const row = (await c.query(`INSERT INTO cost_reservations(id,idempotency_key,tenant_id,project_id,episode_id,run_id,provider_type,provider,model,operation,category,attempt,retry_count,priority,estimated_units,estimated_cost,price_version,unit_price,price_currency,normalized_currency,fx_rate_to_normalized,estimated_normalized_cost,budget_epoch_ids,release_epoch,status,soft_exceeded,override_id,expires_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,'HELD',$25,$26,$27,$28::jsonb) RETURNING *`, [reservationId, key, attribution.tenantId, attribution.projectId, attribution.episodeId, attribution.runId, providerType, provider, model || null, operation, categoryForJob(job.kind, job.payload), attempt, Math.max(0, attempt - 1), priority, estimate.units, estimate.cost, estimate.rate?.version || 'unpriced', estimate.rate ? Number(estimate.rate.unit_price) : 0, estimate.currency, estimate.normalizedCurrency, estimate.fxRate, estimate.normalizedCost, JSON.stringify(budgetIds), job.payload?.releaseEpoch || process.env.FORGE_RELEASE_EPOCH || null, softExceeded, override?.id || null, new Date(this.clock().getTime() + this.reservationTtlMs), JSON.stringify({ kind: job.kind, payloadFingerprint: digest(job.payload || {}), priority, softExceeded })])).rows[0];
      return { allowed: true, reservation: row, reused: false, estimate, attribution };
    });
  }
  async settleJob({ job, reservation, outcome = 'SUCCEEDED', usage = {}, providerRunId = null, metadata = {} }) {
    if (!reservation) return null;
    const current = (await this.pool.query('SELECT * FROM cost_reservations WHERE id=$1 FOR UPDATE', [reservation.id])).rows[0];
    if (!current) throw new CostGovernanceError(`Unknown cost reservation ${reservation.id}`, 'COST_RESERVATION_NOT_FOUND');
    if (TERMINAL.has(current.status)) return current;
    const estimate = await this.estimate({ providerType: current.provider_type, provider: current.provider, model: current.model || '', operation: current.operation, usage });
    const units = usage.units == null ? (estimate.units || Number(current.estimated_units || 0)) : finite(usage.units);
    const actualCost = usage.actualCost == null ? (estimate.rate ? estimate.cost : Number(current.estimated_cost || 0)) : finite(usage.actualCost);
    const fxRate = estimate.rate ? estimate.fxRate : Number(current.fx_rate_to_normalized || 1); const normalizedCost = actualCost * fxRate;
    const eventKey = `cost-event:${current.id}:${outcome}`;
    const event = await this.tx(async (c) => {
      const existing = (await c.query('SELECT * FROM cost_events WHERE event_key=$1', [eventKey])).rows[0]; if (existing) return existing;
      const status = outcome === 'CANCELLED' ? 'RELEASED' : 'COMMITTED';
      const inserted = (await c.query(`INSERT INTO cost_events(id,event_key,reservation_id,tenant_id,project_id,episode_id,run_id,job_id,provider_run_id,category,provider_type,provider,model,operation,attempt,retry_count,usage_units,unit_type,unit_price,price_version,price_currency,fx_rate_to_normalized,normalized_currency,actual_cost,normalized_cost,currency,outcome,release_epoch,budget_epoch_ids,override_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb,$30,$31::jsonb) RETURNING *`, [`${eventKey}:${digest({current:eventKey,usage,outcome})}`, eventKey, current.id, current.tenant_id, current.project_id, current.episode_id, current.run_id, current.job_id, providerRunId, current.category, current.provider_type, current.provider, current.model, current.operation, current.attempt, current.retry_count, units, current.price_version, estimate.rate ? Number(estimate.rate.unit_price) : Number(current.unit_price), estimate.rate?.version || current.price_version, estimate.rate?.currency || current.price_currency, fxRate, estimate.normalizedCurrency || current.normalized_currency, actualCost, normalizedCost, estimate.currency || current.price_currency, outcome === 'CANCELLED' ? 'CANCELLED' : outcome, current.release_epoch, current.budget_epoch_ids, current.override_id, JSON.stringify({ ...metadata, estimatedNormalizedCost: Number(current.estimated_normalized_cost), overrun: normalizedCost > Number(current.estimated_normalized_cost), settledAt: new Date(this.clock()).toISOString() })])).rows[0];
      await c.query(`UPDATE cost_reservations SET status=$1,committed_cost=$2,committed_normalized_cost=$3,committed_at=CASE WHEN $1='COMMITTED' THEN now() ELSE committed_at END,released_at=CASE WHEN $1='RELEASED' THEN now() ELSE released_at END,metadata=metadata || $4::jsonb WHERE id=$5 AND status='HELD'`, [status, actualCost, normalizedCost, JSON.stringify({ settlementOutcome: outcome, overrun: normalizedCost > Number(current.estimated_normalized_cost) }), current.id]);
      return inserted;
    });
    return { reservation: (await this.pool.query('SELECT * FROM cost_reservations WHERE id=$1', [current.id])).rows[0], event };
  }
  async recordRejection({ job, reason }) {
    return this.tx(async (c) => {
      const attribution = await this.resolveAttribution(c, job).catch(() => ({ tenantId: job.tenant_id || job.payload?.tenantId || null, projectId: job.project_id || null, episodeId: job.episode_id || null, runId: runForJob(job) }));
      const eventKey = `cost-rejection:${job.id}:attempt:${Number(job.attempts) || 1}`;
      const existing = (await c.query('SELECT * FROM cost_events WHERE event_key=$1', [eventKey])).rows[0]; if (existing) return existing;
      return (await c.query(`INSERT INTO cost_events(id,event_key,tenant_id,project_id,episode_id,run_id,job_id,category,provider_type,provider,model,operation,attempt,retry_count,usage_units,unit_type,unit_price,price_version,price_currency,fx_rate_to_normalized,normalized_currency,actual_cost,normalized_cost,currency,outcome,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,'request',0,'admission-rejected','USD',1,'USD',0,0,'REJECTED',$15::jsonb) RETURNING *`, [digest(eventKey), eventKey, attribution.tenantId, attribution.projectId, attribution.episodeId, attribution.runId, job.id, categoryForJob(job.kind, job.payload), categoryForJob(job.kind, job.payload), providerForJob(job), job.payload?.model || null, operationForJob(job), Number(job.attempts) || 1, JSON.stringify({ code: reason?.code || 'COST_REJECTED', reason: reason?.message || String(reason) })])).rows[0];
    });
  }
  async release({ reservationId, reason = 'released' }) {
    return (await this.pool.query(`UPDATE cost_reservations SET status='RELEASED',released_at=now(),metadata=metadata || $1::jsonb WHERE id=$2 AND status='HELD' RETURNING *`, [JSON.stringify({ releaseReason: reason }), reservationId])).rows[0] || null;
  }
  async recoverStaleReservations({ limit = 50 } = {}) {
    const rows = (await this.pool.query(`SELECT * FROM cost_reservations WHERE status='HELD' AND expires_at<now() ORDER BY expires_at LIMIT $1`, [limit])).rows; let recovered = 0;
    for (const row of rows) {
      await this.tx(async (c) => {
        const current = (await c.query('SELECT * FROM cost_reservations WHERE id=$1 FOR UPDATE', [row.id])).rows[0]; if (!current || current.status !== 'HELD') return;
        const eventKey = `cost-expired:${current.id}`; const existing = (await c.query('SELECT 1 FROM cost_events WHERE event_key=$1', [eventKey])).rows[0];
        if (!existing) await c.query(`INSERT INTO cost_events(id,event_key,reservation_id,tenant_id,project_id,episode_id,run_id,job_id,category,provider_type,provider,model,operation,attempt,retry_count,usage_units,unit_type,unit_price,price_version,price_currency,fx_rate_to_normalized,normalized_currency,actual_cost,normalized_cost,currency,outcome,budget_epoch_ids,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,'request',$16,$17,$18,$19,$20,0,0,$21,'EXPIRED',$22::jsonb,$23::jsonb)`, [digest(eventKey), eventKey, current.id, current.tenant_id, current.project_id, current.episode_id, current.run_id, current.job_id, current.category, current.provider_type, current.provider, current.model, current.operation, current.attempt, current.unit_price, current.price_version, current.price_currency, current.fx_rate_to_normalized, current.normalized_currency, current.currency || current.price_currency, current.budget_epoch_ids, JSON.stringify({ reason: 'reservation_ttl_expired', estimatedNormalizedCost: Number(current.estimated_normalized_cost) })]);
        await c.query(`UPDATE cost_reservations SET status='EXPIRED',released_at=now(),metadata=metadata || '{"recovered":true}'::jsonb WHERE id=$1 AND status='HELD'`, [current.id]); recovered += 1;
      });
    }
    return { recovered };
  }
  async reconcileEvent({ eventId, actualCost, currency = null, reason, actor, requestId = null }) {
    text(eventId, 'eventId'); text(reason, 'reason', 1000); text(actor, 'actor', 128);
    return this.tx(async (c) => {
      const event = (await c.query('SELECT * FROM cost_events WHERE id=$1 FOR UPDATE', [eventId])).rows[0]; if (!event) throw new CostGovernanceError('cost event not found', 'NOT_FOUND');
      const next = finite(actualCost); const fx = Number(event.fx_rate_to_normalized || 1); const nextNormalized = next * fx; const delta = nextNormalized - Number(event.normalized_cost || 0); if (delta === 0) return { event, adjustment: null };
      const key = `cost-reconcile:${eventId}:${digest({ next, currency, reason })}`;
      const adjustment = (await c.query(`INSERT INTO cost_adjustments(id,event_key,event_id,budget_epoch_id,tenant_id,project_id,episode_id,run_id,kind,amount,currency,normalized_amount,normalized_currency,reason,actor,request_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'RECONCILIATION',$9,$10,$11,$12,$13,$14,$15,$16::jsonb) ON CONFLICT(event_key) DO NOTHING RETURNING *`, [digest(key), key, event.id, event.budget_epoch_ids->>0, event.tenant_id, event.project_id, event.episode_id, event.run_id, next - Number(event.actual_cost || 0), currency || event.currency, delta, event.normalized_currency, reason, actor, requestId, JSON.stringify({ priorActualCost: Number(event.actual_cost || 0), newActualCost: next })])).rows[0];
      return { event, adjustment };
    });
  }
  async refundEvent({ eventId, amount, reason, actor, requestId = null }) { return this.reconcileEvent({ eventId, actualCost: Math.max(0, Number((await this.pool.query('SELECT actual_cost FROM cost_events WHERE id=$1', [eventId])).rows[0]?.actual_cost || 0) - finite(amount)), reason, actor, requestId }); }
  async health() {
    const [reservations, events, budgets] = await Promise.all([
      this.pool.query('SELECT status,COUNT(*)::int count FROM cost_reservations GROUP BY status ORDER BY status'),
      this.pool.query(`SELECT COUNT(*)::int events,COALESCE(SUM(normalized_cost),0)::numeric normalized_cost,COUNT(*) FILTER (WHERE outcome='REJECTED')::int rejected,COUNT(*) FILTER (WHERE metadata->>'overrun'='true')::int overruns FROM cost_events`),
      this.pool.query(`SELECT scope_type,scope_id,epoch,currency,state FROM (SELECT b.*,CASE WHEN b.hard_cost_limit IS NOT NULL AND COALESCE((SELECT SUM(e.normalized_cost) FROM cost_events e WHERE e.budget_epoch_id=b.id),0)>b.hard_cost_limit THEN 'EXHAUSTED' ELSE 'ACTIVE' END state FROM cost_budget_epochs b WHERE b.active=true) x ORDER BY scope_type,scope_id`),
    ]);
    return { enforcementEnabled: this.required, reservations: reservations.rows, events: events.rows[0], activeBudgets: budgets.rows };
  }
}
module.exports = { CostGovernanceService, CostGovernanceError, CostBudgetRejectedError, categoryForJob, unitsFor, digest, CATEGORIES };
