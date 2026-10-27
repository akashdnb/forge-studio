const { ImmutableUsageLedger, UsageLedgerError, AdjustmentApprovalError, sha256 } = require('./immutable-usage-ledger');

class ProductionUsageLedger extends ImmutableUsageLedger {
  async verifyTenant(tenantId) {
    const rows = (await this.pool.query('SELECT * FROM usage_ledger_events WHERE tenant_id=$1 ORDER BY sequence', [tenantId])).rows;
    const head = (await this.pool.query('SELECT * FROM usage_ledger_heads WHERE tenant_id=$1', [tenantId])).rows[0] || null;
    let previous = null;
    for (const row of rows) {
      if (row.previous_integrity_hash !== previous) return { valid: false, reason: 'CHAIN_LINK_MISMATCH', sequence: Number(row.sequence), eventId: row.event_id };
      if (row.source !== 'usage_events') {
        const expected = sha256({
          eventId: row.event_id, tenantId: row.tenant_id, projectId: row.project_id, runId: row.run_id, jobId: row.job_id,
          attempt: row.attempt, providerType: row.provider_type, provider: row.provider, model: row.model,
          operation: row.operation, dimension: row.dimension, quantity: Number(row.quantity), unit: row.unit,
          rate: Number(row.rate), currency: row.currency, amount: Number(row.amount), pricingVersion: row.pricing_version,
          idempotencyKey: row.idempotency_key, eventType: row.event_type, source: row.source,
          occurredAt: new Date(row.occurred_at).toISOString(), sequence: Number(row.sequence), previousIntegrityHash: previous,
        });
        if (row.integrity_hash !== expected) return { valid: false, reason: 'HASH_MISMATCH', sequence: Number(row.sequence), eventId: row.event_id, expected, actual: row.integrity_hash };
      }
      if (!/^[0-9a-f]{64}$/.test(row.integrity_hash || '')) return { valid: false, reason: 'INVALID_HASH_FORMAT', sequence: Number(row.sequence), eventId: row.event_id };
      previous = row.integrity_hash;
    }
    if (head && (Number(head.sequence) !== rows.length || (head.last_integrity_hash || null) !== previous)) return { valid: false, reason: 'HEAD_MISMATCH', expectedSequence: rows.length, actualSequence: Number(head.sequence), expectedHash: previous, actualHash: head.last_integrity_hash };
    return { valid: true, eventCount: rows.length, lastIntegrityHash: previous };
  }

  async reserve(input) { return super.reserve({ currency: input.currency || 'USD', ...input }); }

  async decideAdjustment({ adjustmentId, approve, actor, note = '' }) {
    return this.tx(async (c) => {
      const row = (await c.query('SELECT * FROM usage_adjustment_requests WHERE adjustment_id=$1 FOR UPDATE', [adjustmentId])).rows[0];
      if (!row) throw new UsageLedgerError('Adjustment not found', 'ADJUSTMENT_NOT_FOUND');
      if (row.status !== 'PENDING') throw new AdjustmentApprovalError(`Adjustment is ${row.status}`);
      if (!approve) return (await c.query(`UPDATE usage_adjustment_requests SET status='REJECTED',approved_by=$2,approval_note=$3,decided_at=now() WHERE adjustment_id=$1 RETURNING *`, [adjustmentId, actor, note])).rows[0];
      const result = await this._append(c, {
        tenantId: row.tenant_id, projectId: row.project_id, dimension: 'billing-adjustment', quantity: 0,
        unit: 'adjustment', rate: 0, amount: Number(row.amount), currency: row.currency, pricingVersion: 'adjustment',
        providerType: 'billing', provider: 'forge', operation: 'adjustment', eventType: 'ADJUSTMENT', source: 'operator',
        idempotencyKey: `adjustment:${adjustmentId}`, metadata: { adjustmentId, actor, reason: row.reason, targetEventId: row.target_event_id },
      });
      return (await c.query(`UPDATE usage_adjustment_requests SET status='APPLIED',approved_by=$2,approval_note=$3,applied_event_id=$4,decided_at=now() WHERE adjustment_id=$1 RETURNING *`, [adjustmentId, actor, note, result.event.event_id])).rows[0];
    });
  }

  async refreshRollup({ tenantId, periodStart, periodEnd, dimension, currency, recalculationVersion = 1 }) {
    const row = (await this.pool.query(`INSERT INTO usage_billing_rollups(tenant_id,period_start,period_end,dimension,currency,quantity,net_amount,event_count,recalculation_version,updated_at)
      SELECT $1,$2,$3,$4,$5,COALESCE(SUM(quantity) FILTER (WHERE event_type='USAGE'),0),COALESCE(SUM(amount),0),COUNT(*),$6,now()
      FROM usage_ledger_events WHERE tenant_id=$1 AND dimension=$4 AND currency=$5 AND occurred_at >= $2 AND occurred_at < $3
      ON CONFLICT(tenant_id,period_start,period_end,dimension,currency) DO UPDATE SET quantity=EXCLUDED.quantity,net_amount=EXCLUDED.net_amount,event_count=EXCLUDED.event_count,recalculation_version=EXCLUDED.recalculation_version,updated_at=now()
      RETURNING *`, [tenantId, periodStart, periodEnd, dimension, currency, recalculationVersion])).rows[0];
    return row;
  }
}

module.exports = { ProductionUsageLedger };
