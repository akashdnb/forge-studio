'use strict';

const { ExecutionTraceStore } = require('./execution-trace');
const { Observability, getCurrentTraceContext } = require('./index');
const { JobQueue } = require('../persistence/job-queue');

let storeByPool = new WeakMap();

function getStore(pool, logger) {
  if (!pool) return null;
  let store = storeByPool.get(pool);
  if (!store) {
    store = new ExecutionTraceStore({ pool, logger });
    storeByPool.set(pool, store);
  }
  return store;
}

function install() {
  if (Observability.prototype.__executionTraceInstalled) return;
  Observability.prototype.__executionTraceInstalled = true;

  const originalWithSpan = Observability.prototype.withSpan;
  Observability.prototype.withSpan = async function durableWithSpan(name, attrs, fn) {
    const span = this.startSpan(name, attrs);
    const context = span.context || this.context();
    const store = getStore(this.pool, this.logger);
    const started = Date.now();
    const a = attrs || {};
    if (store && context) {
      await store.append({
        traceId: context.traceId,
        correlationId: context.correlationId,
        projectId: a.projectId || null,
        episodeId: a.episodeId || null,
        kind: 'span.started',
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        jobId: a.jobId || null,
        stage: name,
        payload: { service: this.service }
      });
    }
    try {
      return await span.run(fn);
    } catch (error) {
      if (store && context) await store.append({ traceId: context.traceId, correlationId: context.correlationId, projectId: a.projectId || null, episodeId: a.episodeId || null, kind: 'span.failed', spanId: context.spanId, parentSpanId: context.parentSpanId, jobId: a.jobId || null, stage: name, outcome: 'FAILED', reason: error.code || 'WORKER_ERROR', durationMs: Date.now() - started, payload: { error: { code: error.code || 'WORKER_ERROR', retryable: error.retryable !== false } }, force: true });
      throw error;
    } finally {
      span.finish();
      if (store && context) await store.append({ traceId: context.traceId, correlationId: context.correlationId, projectId: a.projectId || null, episodeId: a.episodeId || null, kind: 'span.finished', spanId: context.spanId, parentSpanId: context.parentSpanId, jobId: a.jobId || null, stage: name, durationMs: Date.now() - started, payload: {} });
    }
  };

  const originalRecordJob = Observability.prototype.recordJob;
  Observability.prototype.recordJob = function durableRecordJob(job, outcome, duration) {
    originalRecordJob.call(this, job, outcome, duration);
    const context = this.context() || (job && this.jobContext ? this.jobContext(job) : null);
    const store = getStore(this.pool, this.logger);
    if (!store || !job || !context) return;
    const normalized = String(outcome || 'unknown').toLowerCase();
    const terminal = normalized === 'succeeded' || normalized === 'failed';
    const eventKind = normalized === 'dispatched' ? 'job.claimed' : normalized === 'failed' ? 'job.failed' : normalized === 'succeeded' ? 'job.succeeded' : `job.${normalized}`;
    const reason = job.error?.code || job.error?.message || null;
    void store.append({
      traceId: context.traceId,
      correlationId: context.correlationId,
      projectId: job.project_id,
      episodeId: job.episode_id,
      kind: eventKind,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      jobId: job.id,
      attempt: job.attempts,
      workerId: job.worker_id,
      stage: job.kind,
      outcome: normalized === 'failed' ? 'FAILED' : normalized === 'succeeded' ? 'SUCCEEDED' : normalized.toUpperCase(),
      reason,
      durationMs: duration == null ? null : Math.round(duration * 1000),
      payload: { attempt: job.attempts, dispatchGeneration: job.dispatch_generation, terminal }
    }).catch(() => {});
  };

  const originalJobContext = Observability.prototype.jobContext;
  Observability.prototype.jobContext = function durableJobContext(job, parent) {
    const context = originalJobContext.call(this, job, parent);
    const store = getStore(this.pool, this.logger);
    if (store && job) {
      void store.append({ traceId: context.traceId, correlationId: context.correlationId, projectId: job.project_id, episodeId: job.episode_id, kind: 'run.observed', jobId: job.id, attempt: job.attempts, workerId: job.worker_id, stage: job.kind, payload: { status: job.status, availableAt: job.available_at, leasedUntil: job.leased_until } }).catch(() => {});
    }
    return context;
  };

  const originalClaim = JobQueue.prototype.claim;
  JobQueue.prototype.claim = async function durableClaim(options) {
    const job = await originalClaim.call(this, options);
    const store = getStore(this.pool);
    if (!store) return job;
    if (job) {
      const context = this.observability?.jobContext(job);
      await store.recordAttempt({ traceId: context?.traceId || job.trace_id, job, workerId: options?.workerId, outcome: 'RUNNING', leaseExpiresAt: job.leased_until, admission: { decision: 'CLAIMED', reason: 'dependency_ready' } }).catch(() => {});
      await store.append({ traceId: context?.traceId || job.trace_id, correlationId: context?.correlationId || job.correlation_id, projectId: job.project_id, episodeId: job.episode_id, kind: 'job.claimed', jobId: job.id, attempt: job.attempts, workerId: options?.workerId, stage: job.kind, outcome: 'RUNNING', payload: { priority: job.priority, dispatchGeneration: job.dispatch_generation }, force: true }).catch(() => {});
    }
    return job;
  };

  const originalClaimSpecific = JobQueue.prototype.claimSpecific;
  JobQueue.prototype.claimSpecific = async function durableClaimSpecific(id, workerId, now) {
    const job = await originalClaimSpecific.call(this, id, workerId, now);
    const store = getStore(this.pool);
    if (store && job) {
      const context = this.observability?.jobContext(job) || { traceId: job.trace_id, correlationId: job.correlation_id };
      await store.recordAttempt({ traceId: context.traceId, job, workerId, outcome: 'RUNNING', leaseExpiresAt: job.leased_until, admission: { decision: 'CLAIMED', reason: 'specific_dispatch' } }).catch(() => {});
    }
    return job;
  };

  const originalHeartbeat = JobQueue.prototype.heartbeat;
  JobQueue.prototype.heartbeat = async function durableHeartbeat(id, workerId, dispatchToken) {
    const job = await originalHeartbeat.call(this, id, workerId, dispatchToken);
    const store = getStore(this.pool);
    if (store && job) {
      const context = this.observability?.jobContext(job);
      await store.append({ traceId: context?.traceId || job.trace_id, correlationId: context?.correlationId || job.correlation_id, projectId: job.project_id, episodeId: job.episode_id, kind: 'job.heartbeat', jobId: job.id, attempt: job.attempts, workerId, stage: job.kind, payload: { leasedUntil: job.leased_until } }).catch(() => {});
    }
    return job;
  };

  const originalFail = JobQueue.prototype.fail;
  JobQueue.prototype.fail = async function durableFail(id, workerId, error, options) {
    const current = await this.get(id).catch(() => null);
    const result = await originalFail.call(this, id, workerId, error, options);
    const store = getStore(this.pool);
    if (store && current) {
      const context = this.observability?.jobContext(current);
      const retrying = result?.status === 'QUEUED';
      await store.recordAttempt({ traceId: context?.traceId || current.trace_id, job: current, workerId, outcome: retrying ? 'RETRYING' : 'FAILED', retryable: retrying, retryCause: error?.code || 'WORKER_ERROR', finishedAt: retrying ? null : new Date() }).catch(() => {});
      await store.append({ traceId: context?.traceId || current.trace_id, correlationId: context?.correlationId || current.correlation_id, projectId: current.project_id, episodeId: current.episode_id, kind: retrying ? 'job.retry_scheduled' : 'job.failed', jobId: id, attempt: current.attempts, workerId, stage: current.kind, outcome: retrying ? 'RETRYING' : 'FAILED', reason: error?.code || 'WORKER_ERROR', payload: { retryable: retrying, delaySeconds: options?.delaySeconds || null }, force: true }).catch(() => {});
    }
    return result;
  };

  const originalSucceed = JobQueue.prototype.succeed;
  JobQueue.prototype.succeed = async function durableSucceed(id, workerId, result, dispatchToken) {
    const current = await this.get(id).catch(() => null);
    const updated = await originalSucceed.call(this, id, workerId, result, dispatchToken);
    const store = getStore(this.pool);
    if (store && current) {
      const context = this.observability?.jobContext(current);
      await store.recordAttempt({ traceId: context?.traceId || current.trace_id, job: current, workerId, outcome: 'SUCCEEDED', finishedAt: new Date() }).catch(() => {});
      await store.append({ traceId: context?.traceId || current.trace_id, correlationId: context?.correlationId || current.correlation_id, projectId: current.project_id, episodeId: current.episode_id, kind: 'job.succeeded', jobId: id, attempt: current.attempts, workerId, stage: current.kind, outcome: 'SUCCEEDED', payload: { resultKeys: Object.keys(result || {}).slice(0, 32) }, force: true }).catch(() => {});
    }
    return updated;
  };
}

install();

module.exports = { getStore };
