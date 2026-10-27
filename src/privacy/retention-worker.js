'use strict';

const crypto = require('node:crypto');
const { PrivacyGovernance } = require('./privacy-governance');

const CONTROL_TABLES = new Set(['privacy_classifications','privacy_policies','privacy_policy_snapshots','privacy_holds','privacy_retention_runs','privacy_retention_items','privacy_operator_approvals','privacy_quarantine','privacy_decision_evidence']);
function itemId(tenantId, table, id, snapshotId) { return crypto.createHash('sha256').update(`${tenantId}:${table}:${id}:${snapshotId}`).digest('hex'); }

class DurablePrivacyRetentionWorker {
  constructor({ pool, storage = null, clock = () => new Date(), batchSize = 100 } = {}) { this.pool = pool; this.clock = clock; this.batchSize = Math.max(1, Math.min(500, batchSize)); this.governance = new PrivacyGovernance({ pool, storage, clock, batchSize }); }
  async run({ tenantId, runId = crypto.randomUUID(), limit = this.batchSize } = {}) { if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code: 'INVALID_SCOPE' }); const existing = (await this.pool.query('SELECT * FROM privacy_retention_runs WHERE id=$1 AND tenant_id=$2', [runId, tenantId])).rows[0]; if (!existing) await this._start(tenantId, runId); return this.scan({ tenantId, runId, limit }); }
  async _start(tenantId, runId) {
    const current = (await this.pool.query('SELECT 1 FROM privacy_policies WHERE tenant_id=$1 LIMIT 1', [tenantId])).rows[0]; if (!current) await this.governance.setPolicy({ tenantId, actor: 'system', policy: this.governance.defaultPolicy() });
    let snapshot; try { snapshot = await this.governance.snapshotPolicy({ tenantId, executionKind: 'retention-run', executionId: runId }); } catch (error) { if (error.code !== '23505') throw error; snapshot = (await this.pool.query('SELECT * FROM privacy_policy_snapshots WHERE tenant_id=$1 AND execution_kind=$2 AND execution_id=$3', [tenantId, 'retention-run', runId])).rows[0]; if (!snapshot) throw error; }
    await this.pool.query('INSERT INTO privacy_retention_runs(id,tenant_id,policy_snapshot_id,status,checkpoint) VALUES($1,$2,$3,\'RUNNING\',$4::jsonb) ON CONFLICT(id) DO NOTHING', [runId, tenantId, snapshot.id, JSON.stringify({ tableIndex: 0, id: null })]);
  }
  async scan({ tenantId, runId, limit = this.batchSize }) {
    const c = await this.pool.connect(); let scanned = 0; let eligible = 0; let blocked = 0;
    try {
      await c.query('BEGIN'); const run = (await c.query('SELECT * FROM privacy_retention_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [runId, tenantId])).rows[0]; if (!run) throw Object.assign(new Error('retention run not found'), { code: 'NOT_FOUND' }); if (run.status === 'COMPLETED') { await c.query('COMMIT'); return { runId, status: 'COMPLETED', scanned: 0, eligible: 0, blocked: 0 }; }
      const snapshot = (await c.query('SELECT * FROM privacy_policy_snapshots WHERE id=$1', [run.policy_snapshot_id])).rows[0]; const registry = (await this.governance._registry(c)).filter((entry) => !CONTROL_TABLES.has(entry.table));
      let cursor = run.checkpoint || { tableIndex: 0, id: null }; if (typeof cursor === 'string') { try { cursor = JSON.parse(cursor); } catch { cursor = { tableIndex: 0, id: null }; } }
      for (let tableIndex = Number(cursor.tableIndex || 0); tableIndex < registry.length && scanned < limit; tableIndex++) {
        const entry = registry[tableIndex]; const timeColumn = entry.cols.has('updated_at') ? 'updated_at' : 'created_at'; const scope = entry.cols.has('tenant_id') ? 't.tenant_id=$1' : 't.project_id IN (SELECT id FROM projects WHERE tenant_id=$1)'; let lastId = tableIndex === Number(cursor.tableIndex || 0) ? cursor.id : null;
        while (scanned < limit) {
          const batchSize = Math.min(100, limit - scanned); const rows = (await c.query(`SELECT t.id,t.project_id,t.${timeColumn} AS observed_at FROM ${entry.table} t WHERE ${scope} AND t.${timeColumn} IS NOT NULL AND ($2::text IS NULL OR t.id > $2) ORDER BY t.id LIMIT $3`, [tenantId, lastId, batchSize])).rows; if (!rows.length) break;
          for (const row of rows) { scanned++; lastId = String(row.id); const holds = await this.governance.activeHolds(tenantId, row.project_id, c); const decision = this.governance.evaluate({ observedAt: row.observed_at, domain: entry.domain, snapshot, holds, now: this.clock() }); const id = itemId(tenantId, entry.table, row.id, snapshot.id); const domainRule = snapshot.policy?.domains?.[entry.domain] || {}; const state = decision.preserved ? 'PRESERVED' : decision.blocked ? 'BLOCKED' : decision.eligible ? 'ELIGIBLE' : 'PRESERVED'; await c.query(`INSERT INTO privacy_retention_items(id,run_id,tenant_id,project_id,resource_type,resource_id,classification,observed_at,eligible_at,policy_snapshot_id,immutable_evidence,state,quarantine_until,reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT(tenant_id,resource_type,resource_id,policy_snapshot_id) DO UPDATE SET state=EXCLUDED.state,reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,updated_at=now()`, [id, runId, tenantId, row.project_id || null, entry.table, String(row.id), domainRule.classification || 'INTERNAL', row.observed_at, decision.eligibleAt || row.observed_at, snapshot.id, Boolean(decision.preserved), state, decision.quarantineUntil || null, decision.reason, JSON.stringify({ domain: entry.domain, holdIds: decision.holdIds || [], policyFingerprint: snapshot.fingerprint })]); await c.query('INSERT INTO privacy_decision_evidence(tenant_id,retention_item_id,actor,decision,reason,policy_snapshot_id,hold_ids,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)', [tenantId, id, 'retention-worker', state, decision.reason, snapshot.id, JSON.stringify(decision.holdIds || []), JSON.stringify({ resourceType: entry.table, resourceId: String(row.id) })]); if (decision.eligible) eligible++; if (decision.blocked) blocked++; }
          if (rows.length < batchSize) break;
        }
        cursor = { tableIndex: tableIndex + 1, id: null }; if (scanned >= limit) cursor = { tableIndex, id: lastId };
      }
      const complete = Number(cursor.tableIndex) >= registry.length; await c.query('UPDATE privacy_retention_runs SET checkpoint=$1::jsonb,scanned=scanned+$2,eligible=eligible+$3,blocked=blocked+$4,status=$5,completed_at=CASE WHEN $5=\'COMPLETED\' THEN now() ELSE completed_at END,updated_at=now() WHERE id=$6', [JSON.stringify(cursor), scanned, eligible, blocked, complete ? 'COMPLETED' : 'RUNNING', runId]); await c.query('COMMIT'); return { runId, status: complete ? 'COMPLETED' : 'RUNNING', scanned, eligible, blocked, checkpoint: cursor };
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); await this.pool.query('UPDATE privacy_retention_runs SET status=\'FAILED\',last_error=$1::jsonb,updated_at=now() WHERE id=$2', [JSON.stringify({ code: error.code, message: error.message }), runId]).catch(() => {}); throw error; } finally { c.release(); }
  }
}
module.exports = { DurablePrivacyRetentionWorker };
