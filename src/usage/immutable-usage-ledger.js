const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');

function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function decimal(value, field) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${field} must be finite`);
  return n;
}
function requireString(value, field) {
  if (!value || typeof value !== 'string') throw new TypeError(`${field} is required`);
  return value;
}

class UsageLedgerError extends Error {
  constructor(message, code = 'USAGE_LEDGER_ERROR', details = {}) { super(message); this.code = code; this.details = details; }
}
class QuotaExceededError extends UsageLedgerError { constructor(message, details) { super(message, 'QUOTA_EXCEEDED', details); } }
class AdjustmentApprovalError extends UsageLedgerError { constructor(message, details) { super(message, 'ADJUSTMENT_APPROVAL_REQUIRED', details); } }

class ImmutableUsageLedger {
  constructor({ pool, clock = () => new Date(), reservationTtlMs = 15 * 60 * 1000 } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool; this.clock = clock; this.reservationTtlMs = reservationTtlMs;
  }

  async tx(fn) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
  }

  async append(input, client = null) {
    const run = async (c) => this._append(c, input);
    return client ? run(client) : this.tx(run);
  }

  async _append(c, input) {
    requireString(input.tenantId, 'tenantId');
    requireString(input.providerType, 'providerType');
    requireString(input.provider, 'provider');
    requireString(input.operation, 'operation');
    requireString(input.dimension, 'dimension');
    requireString(input.unit, 'unit');
    requireString(input.pricingVersion, 'pricingVersion');
    requireString(input.idempotencyKey, 'idempotencyKey');
    const quantity = decimal(input.quantity, 'quantity');
    const rate = decimal(input.rate, 'rate');
    const amount = input.amount == null ? quantity * rate : decimal(input.amount, 'amount');
    if (quantity < 0 || rate < 0) throw new TypeError('quantity and rate must be non-negative');
    if (!/^[A-Z]{3}$/.test(String(input.currency || ''))) throw new TypeError('currency must be ISO-4217 uppercase');

    const duplicate = await c.query('SELECT * FROM usage_ledger_events WHERE idempotency_key=$1 FOR SHARE', [input.idempotencyKey]);
    if (duplicate.rows[0]) return { event: duplicate.rows[0], duplicate: true };

    const head = (await c.query('SELECT * FROM usage_ledger_heads WHERE tenant_id=$1 FOR UPDATE', [input.tenantId])).rows[0]
      || (await c.query('INSERT INTO usage_ledger_heads(tenant_id) VALUES($1) ON CONFLICT(tenant_id) DO NOTHING RETURNING *', [input.tenantId])).rows[0]
      || (await c.query('SELECT * FROM usage_ledger_heads WHERE tenant_id=$1 FOR UPDATE', [input.tenantId])).rows[0];
    const sequence = Number(head.sequence) + 1;
    const eventId = input.eventId || randomUUID();
    const occurredAt = input.occurredAt || this.clock().toISOString();
    const payload = {
      eventId, tenantId: input.tenantId, projectId: input.projectId || null, runId: input.runId || null,
      jobId: input.jobId || null, attempt: input.attempt == null ? null : Number(input.attempt),
      providerType: input.providerType, provider: input.provider, model: input.model || null,
      operation: input.operation, dimension: input.dimension, quantity, unit: input.unit, rate,
      currency: input.currency, amount, pricingVersion: input.pricingVersion, idempotencyKey: input.idempotencyKey,
      eventType: input.eventType || 'USAGE', source: input.source || 'forge', occurredAt, sequence,
      previousIntegrityHash: head.last_integrity_hash || null,
    };
    const integrityHash = sha256(payload);
    const inserted = await c.query(`INSERT INTO usage_ledger_events
      (event_id,tenant_id,project_id,run_id,job_id,attempt,provider_type,provider,model,operation,dimension,quantity,unit,rate,currency,amount,pricing_version,idempotency_key,event_type,source,occurred_at,sequence,previous_integrity_hash,integrity_hash,canonical_payload,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26::jsonb) RETURNING *`,
      [eventId, input.tenantId, input.projectId || null, input.runId || null, input.jobId || null, input.attempt == null ? null : Number(input.attempt), input.providerType, input.provider, input.model || null, input.operation, input.dimension, quantity, input.unit, rate, input.currency, amount, input.pricingVersion, input.idempotencyKey, input.eventType || 'USAGE', input.source || 'forge', occurredAt, sequence, head.last_integrity_hash || null, integrityHash, JSON.stringify(payload), JSON.stringify(input.metadata || {})]);
    await c.query(`UPDATE usage_ledger_heads SET sequence=$2,last_event_id=$3,last_integrity_hash=$4,updated_at=now() WHERE tenant_id=$1`, [input.tenantId, sequence, eventId, integrityHash]);
    return { event: inserted.rows[0], duplicate: false };
  }

  async verifyTenant(tenantId) {
    const rows = (await this.pool.query('SELECT * FROM usage_ledger_events WHERE tenant_id=$1 ORDER BY sequence', [tenantId])).rows;
    let previous = null;
    for (const row of rows) {
      const expected = sha256({
        eventId: row.event_id, tenantId: row.tenant_id, projectId: row.project_id, runId: row.run_id, jobId: row.job_id,
        attempt: row.attempt, providerType: row.provider_type, provider: row.provider, model: row.model,
        operation: row.operation, dimension: row.dimension, quantity: Number(row.quantity), unit: row.unit,
        rate: Number(row.rate), currency: row.currency, amount: Number(row.amount), pricingVersion: row.pricing_version,
        idempotencyKey: row.idempotency_key, eventType: row.event_type, source: row.source,
        occurredAt: new Date(row.occurred_at).toISOString(), sequence: Number(row.sequence), previousIntegrityHash: previous,
      });
      if (row.previous_integrity_hash !== previous || row.integrity_hash !== expected) {
        return { valid: false, sequence: Number(row.sequence), eventId: row.event_id, expected, actual: row.integrity_hash };
      }
      previous = row.integrity_hash;
    }
    return { valid: true, eventCount: rows.length, lastIntegrityHash: previous };
  }

  async reserve({ tenantId, projectId = null, runId = null, dimension, quantity, currency = null, idempotencyKey, ttlMs = this.reservationTtlMs }) {
    requireString(tenantId, 'tenantId'); requireString(dimension, 'dimension'); requireString(idempotencyKey, 'idempotencyKey');
    const requested = decimal(quantity, 'quantity'); if (requested <= 0) throw new TypeError('reservation quantity must be > 0');
    return this.tx(async (c) => {
      const existing = await c.query('SELECT * FROM usage_quota_reservations WHERE idempotency_key=$1 FOR UPDATE', [idempotencyKey]);
      if (existing.rows[0]) return { reservation: existing.rows[0], reused: true };
      const policies = (await c.query(`SELECT * FROM usage_quota_policies WHERE tenant_id=$1 AND dimension=$2 AND enabled=true FOR UPDATE`, [tenantId, dimension])).rows;
      for (const policy of policies) {
        const periodStart = policy.period === 'hour' ? "date_trunc('hour', now())" : policy.period === 'day' ? "date_trunc('day', now())" : policy.period === 'month' ? "date_trunc('month', now())" : "to_timestamp(0)";
        const consumed = await c.query(`SELECT COALESCE(SUM(quantity),0)::numeric total FROM usage_ledger_events WHERE tenant_id=$1 AND dimension=$2 AND currency IS NOT DISTINCT FROM $3 AND event_type IN ('USAGE','ADJUSTMENT','REPRICE') AND occurred_at >= ${periodStart}`, [tenantId, dimension, currency]);
        const held = await c.query(`SELECT COALESCE(SUM(quantity),0)::numeric total FROM usage_quota_reservations WHERE tenant_id=$1 AND dimension=$2 AND status='HELD' AND expires_at>now()`, [tenantId, dimension]);
        const total = Number(consumed.rows[0].total) + Number(held.rows[0].total);
        const limit = policy.hard_limit == null ? null : Number(policy.hard_limit) + Number(policy.grace_quantity || 0);
        if (limit != null && total + requested > limit) throw new QuotaExceededError(`Hard quota exceeded for ${dimension}`, { dimension, limit, current: total, requested });
      }
      const reservationId = randomUUID();
      const row = (await c.query(`INSERT INTO usage_quota_reservations(reservation_id,tenant_id,project_id,run_id,dimension,quantity,currency,status,idempotency_key,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'HELD',$8,$9) RETURNING *`, [reservationId, tenantId, projectId, runId, dimension, requested, currency, idempotencyKey, new Date(this.clock().getTime() + ttlMs)])).rows[0];
      return { reservation: row, reused: false };
    });
  }

  async consumeReservation({ reservationId, event }) {
    return this.tx(async (c) => {
      const r = (await c.query('SELECT * FROM usage_quota_reservations WHERE reservation_id=$1 FOR UPDATE', [reservationId])).rows[0];
      if (!r) throw new UsageLedgerError('Reservation not found', 'RESERVATION_NOT_FOUND');
      if (r.status === 'CONSUMED') return { reservation: r, duplicate: true };
      if (r.status !== 'HELD') throw new UsageLedgerError(`Reservation is ${r.status}`, 'RESERVATION_NOT_HELD');
      const result = await this._append(c, { ...event, tenantId: r.tenant_id, projectId: r.project_id, runId: r.run_id, quantity: event.quantity == null ? r.quantity : event.quantity, idempotencyKey: event.idempotencyKey || `reservation:${reservationId}` });
      const updated = (await c.query(`UPDATE usage_quota_reservations SET status='CONSUMED',consumed_event_id=$2 WHERE reservation_id=$1 AND status='HELD' RETURNING *`, [reservationId, result.event.event_id])).rows[0];
      return { reservation: updated || r, event: result.event, duplicate: result.duplicate };
    });
  }

  async releaseReservation({ reservationId, reason = 'released' }) {
    return this.tx(async (c) => {
      const r = (await c.query('SELECT * FROM usage_quota_reservations WHERE reservation_id=$1 FOR UPDATE', [reservationId])).rows[0];
      if (!r) throw new UsageLedgerError('Reservation not found', 'RESERVATION_NOT_FOUND');
      if (r.status !== 'HELD') return { reservation: r, duplicate: true };
      const result = await this._append(c, { tenantId: r.tenant_id, projectId: r.project_id, runId: r.run_id, dimension: r.dimension, quantity: 0, unit: r.dimension, rate: 0, amount: 0, currency: r.currency || 'USD', pricingVersion: 'reservation-release', providerType: 'quota', provider: 'forge', operation: 'release', eventType: 'RELEASE', source: 'quota', idempotencyKey: `reservation-release:${reservationId}`, metadata: { reason } });
      const updated = (await c.query(`UPDATE usage_quota_reservations SET status='RELEASED',released_event_id=$2 WHERE reservation_id=$1 AND status='HELD' RETURNING *`, [reservationId, result.event.event_id])).rows[0];
      return { reservation: updated || r, event: result.event };
    });
  }

  async inspect({ tenantId, projectId = null, dimension = null, limit = 100, offset = 0 } = {}) {
    requireString(tenantId, 'tenantId');
    const values = [tenantId]; const where = ['tenant_id=$1'];
    if (projectId) { values.push(projectId); where.push(`project_id=$${values.length}`); }
    if (dimension) { values.push(dimension); where.push(`dimension=$${values.length}`); }
    values.push(Math.min(Math.max(Number(limit) || 100, 1), 500), Math.max(Number(offset) || 0, 0));
    return (await this.pool.query(`SELECT * FROM usage_ledger_events WHERE ${where.join(' AND ')} ORDER BY sequence DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows;
  }

  async totals({ tenantId, projectId = null, currency = null } = {}) {
    const values = [tenantId]; const where = ['tenant_id=$1'];
    if (projectId) { values.push(projectId); where.push(`project_id=$${values.length}`); }
    if (currency) { values.push(currency); where.push(`currency=$${values.length}`); }
    const result = await this.pool.query(`SELECT dimension,currency,COALESCE(SUM(amount),0)::numeric amount,COALESCE(SUM(quantity),0)::numeric quantity,COUNT(*)::bigint event_count FROM usage_ledger_events WHERE ${where.join(' AND ')} GROUP BY dimension,currency ORDER BY dimension,currency`, values);
    return result.rows;
  }

  async requestAdjustment({ tenantId, projectId = null, targetEventId = null, reason, quantity, amount, currency, requestedBy }) {
    if (!reason || !requestedBy) throw new TypeError('reason and requestedBy are required');
    const id = randomUUID();
    const row = (await this.pool.query(`INSERT INTO usage_adjustment_requests(adjustment_id,tenant_id,project_id,reason,quantity,amount,currency,target_event_id,requested_by,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING') RETURNING *`, [id, tenantId, projectId, reason, decimal(quantity, 'quantity'), decimal(amount, 'amount'), currency, targetEventId, requestedBy])).rows[0];
    return row;
  }

  async decideAdjustment({ adjustmentId, approve, actor, note = '' }) {
    return this.tx(async (c) => {
      const row = (await c.query('SELECT * FROM usage_adjustment_requests WHERE adjustment_id=$1 FOR UPDATE', [adjustmentId])).rows[0];
      if (!row) throw new UsageLedgerError('Adjustment not found', 'ADJUSTMENT_NOT_FOUND');
      if (row.status !== 'PENDING') throw new AdjustmentApprovalError(`Adjustment is ${row.status}`);
      if (!approve) return (await c.query(`UPDATE usage_adjustment_requests SET status='REJECTED',approved_by=$2,approval_note=$3,decided_at=now() WHERE adjustment_id=$1 RETURNING *`, [adjustmentId, actor, note])).rows[0];
      const result = await this._append(c, { tenantId: row.tenant_id, projectId: row.project_id, dimension: 'billing-adjustment', quantity: Math.abs(Number(row.quantity)), unit: 'adjustment', rate: 1, amount: Number(row.amount), currency: row.currency, pricingVersion: 'adjustment', providerType: 'billing', provider: 'forge', operation: 'adjustment', eventType: 'ADJUSTMENT', source: 'operator', idempotencyKey: `adjustment:${adjustmentId}`, metadata: { adjustmentId, actor, reason: row.reason, targetEventId: row.target_event_id } });
      return (await c.query(`UPDATE usage_adjustment_requests SET status='APPLIED',approved_by=$2,approval_note=$3,applied_event_id=$4,decided_at=now() WHERE adjustment_id=$1 RETURNING *`, [adjustmentId, actor, note, result.event.event_id])).rows[0];
    });
  }

  async reconcile({ tenantId, source, windowStart, windowEnd, externalEvents }) {
    const reconciliationId = randomUUID();
    return this.tx(async (c) => {
      await c.query(`INSERT INTO usage_reconciliation_runs(reconciliation_id,tenant_id,source,window_start,window_end,status) VALUES($1,$2,$3,$4,$5,'RUNNING')`, [reconciliationId, tenantId, source, windowStart, windowEnd]);
      let matched = 0; let discrepancies = 0;
      for (const external of externalEvents || []) {
        const internal = (await c.query(`SELECT * FROM usage_ledger_events WHERE tenant_id=$1 AND provider=$2 AND operation=$3 AND occurred_at BETWEEN $4 AND $5 AND (metadata->>'externalEventId')=$6 LIMIT 2`, [tenantId, external.provider, external.operation, windowStart, windowEnd, external.externalEventId])).rows;
        let disposition = 'EXTERNAL_ONLY';
        if (internal.length > 1) disposition = 'DUPLICATE';
        else if (internal[0]) {
          const quantityMatches = Number(internal[0].quantity) === Number(external.quantity);
          const amountMatches = external.amount == null || Number(internal[0].amount) === Number(external.amount);
          disposition = quantityMatches && amountMatches ? 'MATCHED' : quantityMatches ? 'AMOUNT_MISMATCH' : 'QUANTITY_MISMATCH';
        }
        if (disposition === 'MATCHED') matched += 1; else discrepancies += 1;
        await c.query(`INSERT INTO usage_reconciliation_items(reconciliation_id,external_event_id,tenant_id,project_id,provider,model,operation,quantity,unit,currency,external_amount,internal_quantity,internal_amount,disposition,resolved_event_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`, [reconciliationId, external.externalEventId, tenantId, external.projectId || null, external.provider, external.model || null, external.operation, external.quantity, external.unit, external.currency || null, external.amount == null ? null : external.amount, internal[0]?.quantity || null, internal[0]?.amount || null, disposition, internal[0]?.event_id || null, JSON.stringify(external.metadata || {})]);
      }
      const status = discrepancies ? 'DISCREPANCY' : 'MATCHED';
      await c.query(`UPDATE usage_reconciliation_runs SET status=$2,completed_at=now(),summary=$3::jsonb WHERE reconciliation_id=$1`, [reconciliationId, status, JSON.stringify({ matched, discrepancies, externalCount: (externalEvents || []).length })]);
      return { reconciliationId, status, matched, discrepancies };
    });
  }

  async recalculate({ tenantId, pricingVersion, dimension = null }) {
    const values = [tenantId, pricingVersion]; const where = ['tenant_id=$1','event_type=\'USAGE\''];
    if (dimension) { values.push(dimension); where.push(`dimension=$${values.length}`); }
    const events = (await this.pool.query(`SELECT * FROM usage_ledger_events WHERE ${where.join(' AND ')} ORDER BY sequence`, values)).rows;
    let total = 0;
    for (const event of events) total += Number(event.quantity) * Number((await this.pool.query('SELECT rate FROM usage_pricing_versions WHERE pricing_version=$1', [pricingVersion])).rows[0]?.rate || event.rate);
    return { tenantId, pricingVersion, dimension, eventCount: events.length, recalculatedAmount: total };
  }
}

module.exports = { ImmutableUsageLedger, UsageLedgerError, QuotaExceededError, AdjustmentApprovalError, canonical, sha256 };
