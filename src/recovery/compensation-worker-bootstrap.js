'use strict';

const { Pool } = require('pg');
const { JobQueue } = require('../persistence/job-queue');
const { CompensationSagaService } = require('./compensation-saga');

if (!JobQueue.prototype.__forgeCompensationSagaPatched) {
  JobQueue.prototype.__forgeCompensationSagaPatched = true;
  const OriginalSucceed = JobQueue.prototype.succeed;
  const OriginalFail = JobQueue.prototype.fail;
  const OriginalCancel = JobQueue.prototype.cancel;

  const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.FORGE_COMPENSATION_POOL_MAX || '2', 10) }) : null;
  const service = pool ? new CompensationSagaService({ pool }) : null;
  let workerId = `compensator:${process.pid}`;
  let timer = null;
  let recovering = false;

  async function loadJob(id) {
    if (!pool) return null;
    return (await pool.query('SELECT * FROM forge_jobs WHERE id=$1', [id])).rows[0] || null;
  }
  async function loadReservation(job) {
    if (!pool || !job) return null;
    return (await pool.query('SELECT * FROM usage_reservations WHERE job_id=$1 AND attempt=$2 ORDER BY id DESC LIMIT 1', [job.id, Number(job.attempts) || 1])).rows[0] || null;
  }
  async function record(job, result) {
    if (!service || !job?.payload?.workflowId) return;
    try { await service.recordForwardSideEffect({ job, result, reservation: await loadReservation(job) }); }
    catch (error) { console.error('Forge compensation side-effect recording failed:', error.message); }
  }
  async function trigger(job, error, trigger = 'FAILURE') {
    if (!service || !job?.payload?.workflowId) return;
    try { await service.triggerForWorkflow({ workflowId: job.payload.workflowId, actor: workerId, trigger, reason: { jobId: job.id, stage: job.payload.stage || job.kind, error: { code: error?.code || 'WORKFLOW_FAILURE', message: error?.message || String(error) } } }); }
    catch (triggerError) { console.error('Forge compensation trigger failed:', triggerError.message); }
  }

  JobQueue.prototype.succeed = async function compensationAwareSucceed(id, currentWorkerId, result = {}, dispatchToken = null) {
    const job = await loadJob(id);
    const updated = await OriginalSucceed.call(this, id, currentWorkerId, result, dispatchToken);
    await record(updated || job, result);
    return updated;
  };
  JobQueue.prototype.fail = async function compensationAwareFail(id, currentWorkerId, error, options = {}) {
    const updated = await OriginalFail.call(this, id, currentWorkerId, error, options);
    if (updated?.status === 'FAILED') await trigger(updated, error, 'FAILURE');
    return updated;
  };
  JobQueue.prototype.cancel = async function compensationAwareCancel(id, currentWorkerId, reason) {
    const updated = await OriginalCancel.call(this, id, currentWorkerId, reason);
    await trigger(updated, Object.assign(new Error(reason || 'Job cancelled'), { code: 'JOB_CANCELLED', retryable: false }), 'CANCELLED');
    return updated;
  };

  async function runCompensationTick() {
    if (!service || recovering) return;
    recovering = true;
    try {
      await service.recoverExpiredLeases();
      await service.recoverStaleWorkflows({ actor: workerId });
      for (let i = 0; i < Number.parseInt(process.env.FORGE_COMPENSATION_CONCURRENCY || '2', 10); i++) {
        const step = await service.claimNext({ workerId });
        if (!step) break;
        await service.executeClaimed(step, { workerId, fencingToken: step.fencingToken });
      }
    } catch (error) {
      console.error('Forge compensation recovery tick failed:', error.message);
    } finally { recovering = false; }
  }
  if (service) {
    timer = setInterval(() => runCompensationTick().catch(() => {}), Number.parseInt(process.env.FORGE_COMPENSATION_INTERVAL_MS || '5000', 10));
    timer.unref?.();
    process.once('SIGTERM', async () => { if (timer) clearInterval(timer); await pool.end().catch(() => {}); });
    process.once('SIGINT', async () => { if (timer) clearInterval(timer); await pool.end().catch(() => {}); });
  }
}

module.exports = {};
