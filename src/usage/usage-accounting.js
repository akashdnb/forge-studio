const crypto = require('node:crypto');

const TERMINAL_RESERVATION_STATES = new Set(['SETTLED', 'RELEASED', 'EXPIRED']);

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function deterministicEventIdentity(input) {
  return hash({
    jobId: input.jobId || null,
    providerRunId: input.providerRunId || null,
    episodeId: input.episodeId || null,
    stage: input.stage || null,
    providerType: input.providerType,
    provider: input.provider,
    model: input.model || '',
    operation: input.operation,
    executionAttempt: input.executionAttempt || 1,
    eventNamespace: input.eventNamespace || 'execution',
  });
}

function parseJsonEnv(name, fallback = null) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (error) { throw new Error(`${name} must contain valid JSON: ${error.message}`); }
}

function asNonNegativeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError('usage value must be a non-negative finite number');
  return parsed;
}

class UsageAccountingError extends Error {
  constructor(message, code = 'USAGE_ACCOUNTING_ERROR') { super(message); this.name = 'UsageAccountingError'; this.code = code; }
}

class BudgetRejectedError extends UsageAccountingError {
  constructor(message, details = {}) { super(message, 'BUDGET_REJECTED'); this.details = details; }
}

class UsageAccountingService {
  constructor({ pool, clock = () => new Date(), reservationTtlMs = Number.parseInt(process.env.FORGE_USAGE_RESERVATION_TTL_MS || '900000', 10), required = process.env.FORGE_COST_ENFORCEMENT_ENABLED === 'true', logger = console } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    if (!Number.isFinite(reservationTtlMs) || reservationTtlMs < 1000) throw new TypeError('reservationTtlMs must be >= 1000');
    this.pool = pool;
    this.clock = clock;
    this.reservationTtlMs = reservationTtlMs;
    this.required = Boolean(required);
    this.logger = logger;
  }

  async syncConfiguration({ pricing = parseJsonEnv('FORGE_USAGE_PRICING_JSON', []), budgets = parseJsonEnv('FORGE_USAGE_BUDGETS_JSON', []) } = {}) {
    for (const item of pricing || []) {
      await this.pool.query(`INSERT INTO usage_pricing (provider_type,provider,model,operation,unit_type,unit_price,currency,config_version,active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (provider_type,provider,model,operation,config_version)
        DO UPDATE SET unit_type=EXCLUDED.unit_type,unit_price=EXCLUDED.unit_price,currency=EXCLUDED.currency,active=EXCLUDED.active`, [
        item.providerType || 'worker', item.provider || '', item.model || '', item.operation, item.unitType || 'request',
        asNonNegativeNumber(item.unitPrice), (item.currency || 'USD').toUpperCase(), item.configVersion || 'env-v1', item.active !== false,
      ]);
    }
    for (const item of budgets || []) {
      await this.pool.query(`INSERT INTO usage_budgets
        (scope_type,scope_id,period_key,hard_cost_limit,hard_usage_limit,soft_cost_limit,soft_usage_limit,currency,state,config_version,metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE',$9,$10::jsonb)
        ON CONFLICT (scope_type,scope_id,period_key,currency)
        DO UPDATE SET hard_cost_limit=EXCLUDED.hard_cost_limit,hard_usage_limit=EXCLUDED.hard_usage_limit,
          soft_cost_limit=EXCLUDED.soft_cost_limit,soft_usage_limit=EXCLUDED.soft_usage_limit,
          state=CASE WHEN usage_budgets.state='DISABLED' THEN usage_budgets.state ELSE 'ACTIVE' END,
          config_version=EXCLUDED.config_version,metadata=EXCLUDED.metadata,updated_at=now()`, [
        item.scopeType, item.scopeId, item.periodKey || 'lifetime', item.hardCostLimit ?? null, item.hardUsageLimit ?? null,
        item.softCostLimit ?? null, item.softUsageLimit ?? null, (item.currency || 'USD').toUpperCase(), item.configVersion || 'env-v1', JSON.stringify(item.metadata || {}),
      ]);
    }
    return { pricing: pricing?.length || 0, budgets: budgets?.length || 0 };
  }

  async findPricing({ providerType, provider, model = '', operation }) {
    const result = await this.pool.query(`SELECT * FROM usage_pricing
      WHERE provider_type=$1 AND active=true AND (provider=$2 OR provider='') AND (model=$3 OR model='') AND operation=$4
      ORDER BY (provider <> '') DESC, (model <> '') DESC, effective_at DESC LIMIT 1`, [providerType, provider, model, operation]);
    return result.rows[0] || null;
  }

  async estimate({ providerType, provider, model = '', operation, usage = {} }) {
    const pricing = await this.findPricing({ providerType, provider, model, operation });
    if (!pricing) {
      if (this.required) throw new UsageAccountingError(`Missing pricing configuration for ${providerType}/${provider}/${model}/${operation}`, 'PRICING_UNAVAILABLE');
      return { pricing: null, units: 0, estimatedCost: 0, currency: 'USD' };
    }
    let units;
    switch (pricing.unit_type) {
      case 'request': units = 1; break;
      case 'second': units = asNonNegativeNumber(usage.durationMs, 0) / 1000; break;
      case 'byte': units = asNonNegativeNumber(usage.inputBytes, 0) + asNonNegativeNumber(usage.outputBytes, 0); break;
      case 'input_unit': units = asNonNegativeNumber(usage.inputUnits, 0); break;
      case 'output_unit': units = asNonNegativeNumber(usage.outputUnits, 0); break;
      case 'custom': units = asNonNegativeNumber(usage.units, 0); break;
      default: throw new UsageAccountingError(`Unsupported pricing unit type ${pricing.unit_type}`, 'PRICING_INVALID');
    }
    return { pricing, units, estimatedCost: units * Number(pricing.unit_price), currency: pricing.currency };
  }

  async _lockBudgetRows(client, { projectId, episodeId, provider, currency }) {
    const candidates = [
      ['GLOBAL', 'global'],
      ['PROJECT', projectId],
      ['EPISODE', episodeId],
      ['PROVIDER', provider],
    ].filter(([, id]) => id);
    const rows = [];
    for (const [scopeType, scopeId] of candidates) {
      const result = await client.query(`SELECT * FROM usage_budgets WHERE scope_type=$1 AND scope_id=$2 AND currency=$3 AND state <> 'DISABLED' ORDER BY id FOR UPDATE`, [scopeType, scopeId, currency]);
      rows.push(...result.rows);
    }
    return rows;
  }

  async _usageTotals(client, budget, excludeReservationId = null) {
    const values = [budget.currency];
    const predicates = ['currency=$1'];
    if (budget.scope_type === 'GLOBAL') predicates.push('true');
    if (budget.scope_type === 'PROJECT') { values.push(budget.scope_id); predicates.push(`project_id=$${values.length}`); }
    if (budget.scope_type === 'EPISODE') { values.push(budget.scope_id); predicates.push(`episode_id=$${values.length}`); }
    if (budget.scope_type === 'PROVIDER') { values.push(budget.scope_id); predicates.push(`provider=$${values.length}`); }
    const event = await client.query(`SELECT COALESCE(SUM(normalized_cost_units),0)::numeric AS cost, COALESCE(SUM(usage_units),0)::numeric AS units FROM usage_events WHERE ${predicates.join(' AND ')}`, values);
    const reservationValues = [...values];
    const reservationPredicates = ['status=\'HELD\'', 'currency=$1'];
    if (budget.scope_type === 'GLOBAL') reservationPredicates.push('true');
    if (budget.scope_type === 'PROJECT') { reservationValues.push(budget.scope_id); reservationPredicates.push(`project_id=$${reservationValues.length}`); }
    if (budget.scope_type === 'EPISODE') { reservationValues.push(budget.scope_id); reservationPredicates.push(`episode_id=$${reservationValues.length}`); }
    if (budget.scope_type === 'PROVIDER') { reservationValues.push(budget.scope_id); reservationPredicates.push(`provider=$${reservationValues.length}`); }
    if (excludeReservationId) { reservationValues.push(excludeReservationId); reservationPredicates.push(`id<>$${reservationValues.length}`); }
    const held = await client.query(`SELECT COALESCE(SUM(estimated_cost),0)::numeric AS cost, COALESCE(SUM(estimated_units),0)::numeric AS units FROM usage_reservations WHERE ${reservationPredicates.join(' AND ')}`, reservationValues);
    return { cost: Number(event.rows[0].cost) + Number(held.rows[0].cost), units: Number(event.rows[0].units) + Number(held.rows[0].units) };
  }

  async reserveForJob({ job, providerType = 'worker', provider = job.payload?.provider || job.kind, model = job.payload?.model || '', operation = job.payload?.operation || job.kind, usage = job.payload?.usageEstimate || {}, attempt = Number(job.attempts) || 1 }) {
    const estimate = await this.estimate({ providerType, provider, model, operation, usage });
    const reservationId = `usage-reservation:${job.id}`;
    return this._reserve({ reservationId, job, providerType, provider, model, operation, attempt, estimate });
  }

  async _reserve({ reservationId, job, providerType, provider, model, operation, attempt, estimate }) {
    return this._withTransaction(async (client) => {
      const existing = await client.query('SELECT * FROM usage_reservations WHERE job_id=$1 FOR UPDATE', [job.id]);
      if (existing.rows[0]) {
        if (existing.rows[0].status === 'HELD') return { allowed: true, reservation: existing.rows[0], estimate, reused: true };
        if (existing.rows[0].status === 'SETTLED') return { allowed: false, reason: 'ALREADY_SETTLED', reservation: existing.rows[0] };
        if (existing.rows[0].status === 'RELEASED' || existing.rows[0].status === 'EXPIRED') throw new BudgetRejectedError('Job reservation is terminal; a new execution identity is required', { reservationId });
      }
      const currency = estimate.currency;
      const budgets = await this._lockBudgetRows(client, { projectId: job.project_id, episodeId: job.episode_id, provider, currency });
      if (this.required && !budgets.some((row) => row.scope_type === 'GLOBAL' && row.scope_id === 'global')) {
        throw new UsageAccountingError('No global budget is configured; admission is fail-closed', 'BUDGET_CONFIGURATION_UNAVAILABLE');
      }
      for (const budget of budgets) {
        const totals = await this._usageTotals(client, budget);
        if (budget.hard_cost_limit != null && totals.cost + estimate.estimatedCost > Number(budget.hard_cost_limit)) {
          await client.query("UPDATE usage_budgets SET state='EXHAUSTED',updated_at=now() WHERE id=$1", [budget.id]);
          throw new BudgetRejectedError(`${budget.scope_type} cost budget exhausted`, { scopeType: budget.scope_type, scopeId: budget.scope_id, limit: Number(budget.hard_cost_limit), current: totals.cost, requested: estimate.estimatedCost });
        }
        if (budget.hard_usage_limit != null && totals.units + estimate.units > Number(budget.hard_usage_limit)) {
          await client.query("UPDATE usage_budgets SET state='EXHAUSTED',updated_at=now() WHERE id=$1", [budget.id]);
          throw new BudgetRejectedError(`${budget.scope_type} usage quota exhausted`, { scopeType: budget.scope_type, scopeId: budget.scope_id, limit: Number(budget.hard_usage_limit), current: totals.units, requested: estimate.units });
        }
      }
      const result = await client.query(`INSERT INTO usage_reservations
        (id,job_id,project_id,episode_id,provider_type,provider,model,operation,attempt,estimated_units,estimated_cost,currency,status,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'HELD',$13) RETURNING *`, [
        reservationId, job.id, job.project_id, job.episode_id, providerType, provider, model || null, operation, attempt,
        estimate.units, estimate.estimatedCost, currency, new Date(this.clock().getTime() + this.reservationTtlMs),
      ]);
      return { allowed: true, reservation: result.rows[0], estimate, reused: false };
    });
  }

  async recordExecution({ job, reservation = null, providerRunId = null, providerType = 'worker', provider = job.payload?.provider || job.kind, model = job.payload?.model || '', operation = job.payload?.operation || job.kind, stage = job.payload?.stage || job.kind, executionAttempt = Number(job.attempts) || 1, retryCount = Math.max(0, (Number(job.attempts) || 1) - 1), usage = {}, outcome = 'SUCCEEDED', metadata = {} }) {
    const estimate = await this.estimate({ providerType, provider, model, operation, usage });
    const actualCost = usage.actualCost == null ? (estimate.pricing ? estimate.estimatedCost : Number(reservation?.estimated_cost || 0)) : asNonNegativeNumber(usage.actualCost);
    const units = usage.units == null ? (estimate.units || Number(reservation?.estimated_units || 0)) : asNonNegativeNumber(usage.units);
    const eventId = deterministicEventIdentity({ jobId: job.id, providerRunId, episodeId: job.episode_id, stage, providerType, provider, model, operation, executionAttempt });
    return this._withTransaction(async (client) => {
      const existing = await client.query('SELECT * FROM usage_events WHERE id=$1 OR event_key=$2', [eventId, eventId]);
      if (existing.rows[0]) return { event: existing.rows[0], duplicate: true };
      const event = await client.query(`INSERT INTO usage_events
        (id,event_key,job_id,provider_run_id,project_id,episode_id,stage,provider_type,provider,model,operation,execution_attempt,retry_count,
         input_artifact_refs,output_artifact_refs,duration_ms,input_bytes,output_bytes,usage_units,normalized_cost_units,estimated_cost,actual_cost,currency,outcome,metadata)
        VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb)
        RETURNING *`, [
        eventId, job.id, providerRunId, job.project_id, job.episode_id, stage, providerType, provider, model || null, operation, executionAttempt, retryCount,
        JSON.stringify(usage.inputArtifactRefs || []), JSON.stringify(usage.outputArtifactRefs || []), usage.durationMs == null ? null : asNonNegativeNumber(usage.durationMs),
        usage.inputBytes == null ? null : asNonNegativeNumber(usage.inputBytes), usage.outputBytes == null ? null : asNonNegativeNumber(usage.outputBytes), units,
        actualCost, estimate.estimatedCost, actualCost, estimate.currency, outcome, JSON.stringify(metadata || {}),
      ]);
      return { event: event.rows[0], duplicate: false };
    });
  }

  async settleJob({ job, reservation, outcome = 'SUCCEEDED', usage = {}, providerRunId = null, metadata = {} }) {
    if (!reservation) return null;
    return this._withTransaction(async (client) => {
      const currentResult = await client.query('SELECT * FROM usage_reservations WHERE id=$1 FOR UPDATE', [reservation.id]);
      const current = currentResult.rows[0];
      if (!current) throw new UsageAccountingError(`Unknown usage reservation ${reservation.id}`, 'RESERVATION_NOT_FOUND');
      if (TERMINAL_RESERVATION_STATES.has(current.status)) return current;
      const eventResult = await this.recordExecution({ job, reservation: current, providerRunId, providerType: current.provider_type, provider: current.provider, model: current.model || '', operation: current.operation, executionAttempt: current.attempt, usage, outcome, metadata });
      const status = outcome === 'CANCELLED' ? 'RELEASED' : 'SETTLED';
      const updated = await client.query(`UPDATE usage_reservations SET status=$1,terminal_reason=$2,settled_at=now() WHERE id=$3 RETURNING *`, [status, outcome, current.id]);
      return { reservation: updated.rows[0], event: eventResult.event };
    });
  }

  async recoverStaleReservations({ limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be between 1 and 500');
    const rows = (await this.pool.query(`SELECT * FROM usage_reservations WHERE status='HELD' AND expires_at < now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    let recovered = 0;
    for (const reservation of rows) {
      await this._withTransaction(async (client) => {
        const locked = await client.query('SELECT * FROM usage_reservations WHERE id=$1 FOR UPDATE', [reservation.id]);
        if (!locked.rows[0] || locked.rows[0].status !== 'HELD') return;
        const jobResult = await client.query('SELECT * FROM forge_jobs WHERE id=$1', [reservation.job_id]);
        if (jobResult.rows[0]) {
          const eventId = deterministicEventIdentity({ jobId: reservation.job_id, episodeId: reservation.episode_id, stage: 'usage-recovery', providerType: reservation.provider_type, provider: reservation.provider, model: reservation.model || '', operation: reservation.operation, executionAttempt: reservation.attempt, eventNamespace: 'reservation-recovery' });
          await client.query(`INSERT INTO usage_events
            (id,event_key,job_id,project_id,episode_id,stage,provider_type,provider,model,operation,execution_attempt,retry_count,usage_units,normalized_cost_units,estimated_cost,actual_cost,currency,outcome,metadata)
            VALUES ($1,$1,$2,$3,$4,'usage-recovery',$5,$6,$7,$8,$9,GREATEST($9-1,0),$10,$11,$11,$11,$12,'FAILED',$13::jsonb)
            ON CONFLICT (id) DO NOTHING`, [eventId,reservation.job_id,reservation.project_id,reservation.episode_id,reservation.provider_type,reservation.provider,reservation.model,reservation.operation,reservation.attempt,reservation.estimated_units,reservation.estimated_cost,reservation.currency,JSON.stringify({recovered:true,reason:'STALE_RESERVATION'})]);
        }
        await client.query("UPDATE usage_reservations SET status='EXPIRED',terminal_reason='STALE_RECOVERY',settled_at=now() WHERE id=$1", [reservation.id]);
        recovered += 1;
      });
    }
    return { recovered };
  }

  async summary({ episodeId = null, projectId = null, provider = null } = {}) {
    const predicates = [];
    const values = [];
    for (const [column, value] of [['episode_id', episodeId], ['project_id', projectId], ['provider', provider]]) {
      if (value) { values.push(value); predicates.push(`${column}=$${values.length}`); }
    }
    const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    const totals = await this.pool.query(`SELECT currency,COUNT(*)::int AS event_count,COALESCE(SUM(usage_units),0)::text AS usage_units,COALESCE(SUM(estimated_cost),0)::text AS estimated_cost,COALESCE(SUM(actual_cost),0)::text AS actual_cost,COALESCE(SUM(normalized_cost_units),0)::text AS normalized_cost_units FROM usage_events ${where} GROUP BY currency ORDER BY currency`, values);
    const activeReservations = await this.pool.query(`SELECT currency,COUNT(*)::int AS count,COALESCE(SUM(estimated_cost),0)::text AS reserved_cost,COALESCE(SUM(estimated_units),0)::text AS reserved_units FROM usage_reservations WHERE status='HELD' ${predicates.length ? `AND ${predicates.join(' AND ')}` : ''} GROUP BY currency ORDER BY currency`, values);
    return { totals: totals.rows, activeReservations: activeReservations.rows };
  }

  async _withTransaction(operation) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await operation(client); await client.query('COMMIT'); return value; }
    catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }
}

module.exports = { UsageAccountingService, UsageAccountingError, BudgetRejectedError, deterministicEventIdentity, stable, hash };
