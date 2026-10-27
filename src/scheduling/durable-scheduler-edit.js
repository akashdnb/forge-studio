'use strict';

const { DurableScheduler, nextFire, parseCron, validTimeZone } = require('./durable-scheduler');

if (!DurableScheduler.prototype.updateSchedule) {
  DurableScheduler.prototype.updateSchedule = async function updateSchedule({ id, tenantId, projectId = null, actor = 'operator', requestId = null, expectedVersion, patch = {} }) {
    const current = await this.get(id, tenantId, projectId);
    if (expectedVersion != null && Number(expectedVersion) !== Number(current.version)) throw Object.assign(new Error('schedule version conflict'), { code: 'CONFLICT', statusCode: 409 });
    const next = { triggerType: patch.triggerType || current.trigger_type, cronExpr: patch.cronExpr ?? current.cron_expr, fireAt: patch.fireAt ?? current.fire_at, timezone: patch.timezone || current.timezone, dstGapPolicy: patch.dstGapPolicy || current.dst_gap_policy, dstFoldPolicy: patch.dstFoldPolicy || current.dst_fold_policy };
    if (!validTimeZone(next.timezone)) throw new TypeError(`invalid IANA timezone: ${next.timezone}`);
    if (next.triggerType === 'CRON' || next.triggerType === 'CALENDAR') parseCron(next.cronExpr);
    const first = nextFire(next, new Date(this.clock().getTime() - 1));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query(`SELECT * FROM forge_schedules WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL${projectId ? ' AND project_id=$3' : ''} FOR UPDATE`, projectId ? [id, tenantId, projectId] : [id, tenantId])).rows[0];
      if (!locked) throw Object.assign(new Error('schedule not found'), { code: 'NOT_FOUND', statusCode: 404 });
      if (expectedVersion != null && Number(locked.version) !== Number(expectedVersion)) throw Object.assign(new Error('schedule version conflict'), { code: 'CONFLICT', statusCode: 409 });
      const version = Number(locked.version) + 1;
      const row = (await client.query(`UPDATE forge_schedules SET version=$2,trigger_type=$3,cron_expr=$4,fire_at=$5,timezone=$6,dst_gap_policy=$7,dst_fold_policy=$8,misfire_policy=$9,catch_up_limit=$10,max_misfire_age_seconds=$11,next_fire_at=$12,idempotency_prefix=$13,handler_kind=$14,payload=$15::jsonb,retry_policy=$16::jsonb,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [id, version, next.triggerType, next.cronExpr || null, next.fireAt || null, next.timezone, next.dstGapPolicy, next.dstFoldPolicy, patch.misfirePolicy || locked.misfire_policy, patch.catchUpLimit ?? locked.catch_up_limit, patch.maxMisfireAgeSeconds ?? locked.max_misfire_age_seconds, first?.instant || null, patch.idempotencyPrefix || locked.idempotency_prefix, patch.handlerKind || locked.handler_kind, JSON.stringify(patch.payload ?? locked.payload ?? {}), JSON.stringify(patch.retryPolicy ?? locked.retry_policy ?? {})])).rows[0];
      await this.audit(client, { tenantId, projectId: row.project_id, scheduleId: id, scheduleVersion: version, actor, requestId, action: 'VERSION_CREATED', details: { previousVersion: locked.version, pendingOccurrencesPreserved: true, nextFireAt: first?.instant?.toISOString() || null } });
      await client.query('COMMIT'); return row;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  };
}

module.exports = DurableScheduler;
