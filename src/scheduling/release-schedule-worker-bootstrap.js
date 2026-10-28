'use strict';

const { WorkflowScheduler } = require('./workflow-scheduler');
const { JobQueue } = require('../persistence/job-queue');
const { PublishService } = require('../publishing/publish-service');
const { createReleaseScheduleService } = require('./release-scheduler');
const { reconcileScheduledExecutions } = require('./release-schedule-reconciliation');

const INSTALLED = Symbol.for('forge.release.schedule.worker.installed');
if (!WorkflowScheduler.prototype[INSTALLED]) {
  const originalHeartbeat = WorkflowScheduler.prototype.heartbeat;
  const schedulerServices = new WeakMap();
  WorkflowScheduler.prototype.heartbeat = async function releaseScheduleHeartbeat(...args) {
    const result = await originalHeartbeat.apply(this, args);
    let service = schedulerServices.get(this);
    if (!service) { service = createReleaseScheduleService({ pool: this.pool, queue: this.queue, workerId: `${this.schedulerId}:release-calendar` }); schedulerServices.set(this, service); }
    try {
      const tick = await service.tick({ limit: Number.parseInt(process.env.FORGE_RELEASE_SCHEDULER_TICK_LIMIT || '25', 10) });
      const reconciliation = await reconcileScheduledExecutions({
        pool: this.pool,
        queue: this.queue,
        workerId: `${this.schedulerId}:release-calendar`,
        limit: Number.parseInt(process.env.FORGE_RELEASE_SCHEDULER_RECONCILE_LIMIT || '100', 10),
        gate: service.gate,
      });
      this.releaseCalendarLastRun = { at: new Date().toISOString(), tick, reconciliation };
    } catch (error) {
      this.releaseCalendarLastError = { at: new Date().toISOString(), code: error.code || 'RELEASE_SCHEDULER_ERROR', message: error.message };
      this.logger?.error?.(JSON.stringify({ event: 'release_calendar.tick_failed', code: error.code, message: error.message }));
    }
    return result;
  };

  const originalClaimNext = WorkflowScheduler.prototype.claimNext;
  WorkflowScheduler.prototype.claimNext = async function releaseScheduleClaimNext(options = {}) {
    const job = await originalClaimNext.call(this, options);
    if (job?.kind === 'publish:scheduled') job.kind = 'publish:destination';
    if (job?.payload?.releaseExecutionId) job.payload.__releaseScheduleBypass = false;
    return job;
  };

  const originalPublish = PublishService.prototype.publish;
  const publishServices = new WeakMap();
  PublishService.prototype.publish = async function scheduledPublishIntercept(args = {}) {
    const job = args.job || {};
    if (job?.payload?.releaseExecutionId && !job?.payload?.__releaseScheduleBypass) {
      let service = publishServices.get(this.pool);
      if (!service) { service = createReleaseScheduleService({ pool: this.pool, queue: new JobQueue({ pool: this.pool }), workerId: `release-publisher:${process.pid}` }); publishServices.set(this.pool, service); }
      const bypassJob = { ...job, payload: { ...(job.payload || {}), __releaseScheduleBypass: true } };
      return service.executeScheduled(job.payload, bypassJob);
    }
    return originalPublish.call(this, args);
  };

  WorkflowScheduler.prototype[INSTALLED] = true;
}

module.exports = true;
