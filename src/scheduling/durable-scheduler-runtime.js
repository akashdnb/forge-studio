'use strict';

const { randomUUID } = require('node:crypto');
const { DurableScheduler } = require('./durable-scheduler');

class DurableSchedulerRuntime extends DurableScheduler {
  async triggerOccurrence(id) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(`SELECT o.*,s.tenant_id,s.project_id,s.handler_kind,s.payload,s.retry_policy,s.paused,s.deleted_at FROM forge_schedule_occurrences o JOIN forge_schedules s ON s.id=o.schedule_id WHERE o.id=$1 FOR UPDATE`, [id])).rows[0];
      if (!row) throw Object.assign(new Error('occurrence not found'), { code: 'NOT_FOUND' });
      if (row.status === 'TRIGGERED') { await client.query('COMMIT'); return row; }
      const token = randomUUID();
      const claimed = (await client.query(`UPDATE forge_schedule_occurrences SET status='CLAIMED',lease_owner=$2,lease_token=$3,lease_until=clock_timestamp()+($4::text||' seconds')::interval,claimed_at=clock_timestamp(),attempt=attempt+1,updated_at=clock_timestamp() WHERE id=$1 AND status IN('PENDING','CLAIMED') AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`, [id, this.schedulerId, token, this.leaseSeconds])).rows[0];
      if (!claimed) { await client.query('COMMIT'); return null; }

      const targetJobId = row.payload?.__targetJobId || null;
      let jobId = targetJobId;
      if (targetJobId) {
        const updated = (await client.query(`UPDATE forge_jobs SET available_at=LEAST(available_at,clock_timestamp()),updated_at=clock_timestamp(),last_schedule_reason='durable_scheduler_due' WHERE id=$1 AND status='QUEUED' RETURNING id`, [targetJobId])).rows[0];
        if (!updated) throw Object.assign(new Error('scheduled target job is no longer queued'), { code: 'TARGET_JOB_NOT_QUEUED', retryable: false });
      } else {
        jobId = randomUUID();
        const key = claimed.idempotency_key;
        await client.query(`INSERT INTO forge_jobs(id,project_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_by) VALUES($1,$2,$3,$4::jsonb,100,$5,clock_timestamp(),$6,'durable-scheduler') ON CONFLICT(idempotency_key) DO NOTHING`, [jobId, row.project_id, row.handler_kind, JSON.stringify({ ...(row.payload || {}), __scheduleOccurrenceId: id, __scheduleId: row.schedule_id, __scheduleEpoch: row.execution_epoch }), Number(row.retry_policy?.maxAttempts || 3), key]);
      }
      const done = (await client.query(`UPDATE forge_schedule_occurrences SET status='TRIGGERED',target_job_id=$2,triggered_at=clock_timestamp(),lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND status='CLAIMED' AND lease_owner=$3 AND lease_token=$4 RETURNING *`, [id, jobId, this.schedulerId, token])).rows[0];
      if (!done) throw Object.assign(new Error('scheduler occurrence fenced before trigger commit'), { code: 'STALE_SCHEDULER' });
      await client.query('COMMIT'); return done;
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
  }
}

const INSTALLED = Symbol.for('forge.durable.scheduler.runtime.installed');
function installDurableSchedulerRuntime() {
  if (globalThis[INSTALLED]) return globalThis[INSTALLED];
  const { JobQueue } = require('../persistence/job-queue');
  const schedulerByPool = new WeakMap();
  const getScheduler = (pool) => {
    let scheduler = schedulerByPool.get(pool);
    if (!scheduler) { scheduler = new DurableSchedulerRuntime({ pool, schedulerId: `${process.env.FORGE_SCHEDULER_ID || 'forge-durable-scheduler'}:${process.pid}` }); schedulerByPool.set(pool, scheduler); }
    return scheduler;
  };

  if (!JobQueue.prototype.__forgeDurableDelayInstalled) {
    const originalEnqueue = JobQueue.prototype.enqueue;
    const originalFail = JobQueue.prototype.fail;
    JobQueue.prototype.enqueue = async function durableEnqueue(options = {}) {
      const job = await originalEnqueue.call(this, options);
      const availableAt = job.available_at ? new Date(job.available_at) : null;
      if (availableAt && availableAt.getTime() > Date.now() + 250) {
        const tenant = job.project_id ? (await this.pool.query('SELECT tenant_id FROM projects WHERE id=$1', [job.project_id])).rows[0]?.tenant_id : null;
        if (tenant) {
          const scheduler = getScheduler(this.pool);
          await scheduler.create({ id: `job-delay:${job.id}`, tenantId: tenant, projectId: job.project_id, triggerType: 'DELAY', fireAt: availableAt.toISOString(), timezone: 'UTC', misfirePolicy: 'COALESCE', handlerKind: job.kind, payload: { __targetJobId: job.id }, idempotencyPrefix: `job-delay:${job.id}`, createdBy: options.createdBy || 'system' }).catch(error => { if (error.code !== '23505') throw error; });
        }
      }
      return job;
    };
    JobQueue.prototype.fail = async function durableFail(id, workerId, error, options = {}) {
      const job = await originalFail.call(this, id, workerId, error, options);
      if (job?.status === 'QUEUED' && Number(options.delaySeconds || 0) > 0) {
        const tenant = job.project_id ? (await this.pool.query('SELECT tenant_id FROM projects WHERE id=$1', [job.project_id])).rows[0]?.tenant_id : null;
        if (tenant) {
          const scheduler = getScheduler(this.pool);
          const fireAt = new Date(Date.now() + Math.max(1, Number(options.delaySeconds)) * 1000);
          await scheduler.create({ id: `job-retry:${job.id}:${job.attempts}`, tenantId: tenant, projectId: job.project_id, triggerType: 'DELAY', fireAt: fireAt.toISOString(), timezone: 'UTC', misfirePolicy: 'COALESCE', handlerKind: job.kind, payload: { __targetJobId: job.id }, idempotencyPrefix: `job-retry:${job.id}:${job.attempts}`, createdBy: 'retry-control-plane' }).catch(error => { if (error.code !== '23505') throw error; });
          await this.pool.query(`UPDATE forge_jobs SET available_at=$1,updated_at=clock_timestamp(),last_schedule_reason='durable_scheduler_retry' WHERE id=$2 AND status='QUEUED'`, [fireAt, job.id]);
        }
      }
      return job;
    };
    JobQueue.prototype.__forgeDurableDelayInstalled = true;
  }

  const { WorkflowScheduler } = require('./workflow-scheduler');
  if (!WorkflowScheduler.prototype.__forgeDurableSchedulerInstalled) {
    const originalHeartbeat = WorkflowScheduler.prototype.heartbeat;
    WorkflowScheduler.prototype.heartbeat = async function durableSchedulerHeartbeat(...args) {
      const result = await originalHeartbeat.apply(this, args);
      const scheduler = getScheduler(this.pool);
      try { await scheduler.heartbeat(); this.durableSchedulerLastRun = await scheduler.tick({ limit: Number(process.env.FORGE_DURABLE_SCHEDULER_TICK_LIMIT || 50) }); }
      catch (error) { this.durableSchedulerLastError = { at: new Date().toISOString(), code: error.code || 'SCHEDULER_ERROR', message: error.message }; this.logger?.error?.(JSON.stringify({ event: 'durable_scheduler.tick_failed', code: error.code, message: error.message })); }
      return result;
    };
    WorkflowScheduler.prototype.__forgeDurableSchedulerInstalled = true;
  }

  globalThis[INSTALLED] = { getScheduler };
  return globalThis[INSTALLED];
}

module.exports = installDurableSchedulerRuntime();
