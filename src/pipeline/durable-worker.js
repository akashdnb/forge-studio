const { requiredString } = require('../domain/records');

class DurableWorker {
  constructor({ queue, executeJob, pollIntervalMs = 1000, leaseHeartbeatMs = null, onEvent = () => {}, workerId = 'worker' }) {
    if (!queue || typeof queue.claim !== 'function' || typeof queue.complete !== 'function' || typeof queue.fail !== 'function') throw new TypeError('A durable queue is required');
    if (typeof executeJob !== 'function') throw new TypeError('executeJob(job) is required');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 60000) throw new TypeError('pollIntervalMs must be 50..60000');
    if (leaseHeartbeatMs !== null && (!Number.isInteger(leaseHeartbeatMs) || leaseHeartbeatMs < 10 || leaseHeartbeatMs > 60000)) throw new TypeError('leaseHeartbeatMs must be null or 10..60000');
    this.queue = queue;
    this.executeJob = executeJob;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseHeartbeatMs = leaseHeartbeatMs;
    this.onEvent = onEvent;
    this.workerId = requiredString(workerId, 'workerId');
    this.stopping = false;
    this.activeJobs = new Set();
  }

  stop() { this.stopping = true; }

  async runOnce() {
    if (this.stopping) return { status: 'stopping' };
    const job = await this.queue.claim();
    if (!job) return { status: 'idle' };
    this.activeJobs.add(job.id);
    this.onEvent({ type: 'workflow-job.started', jobId: job.id, episodeId: job.episode_id, stage: job.stage, attempt: job.attempts });

    let heartbeatTimer = null;
    let leaseLost = null;
    const heartbeatAbort = new AbortController();
    if (this.leaseHeartbeatMs !== null && typeof this.queue.heartbeat === 'function') {
      heartbeatTimer = setInterval(async () => {
        try {
          await this.queue.heartbeat(job.id);
        } catch (error) {
          leaseLost = error;
          heartbeatAbort.abort(error);
          clearInterval(heartbeatTimer);
        }
      }, this.leaseHeartbeatMs);
      heartbeatTimer.unref?.();
    }

    try {
      const result = await this.executeJob(job, { signal: heartbeatAbort.signal });
      if (leaseLost) throw leaseLost;
      const completed = await this.queue.complete(job.id, result || {});
      this.onEvent({ type: 'workflow-job.succeeded', jobId: job.id, stage: job.stage });
      return { status: 'succeeded', job: completed, result };
    } catch (error) {
      // A worker that lost the lease must not overwrite the state of the new
      // owner. The claim operation will reclaim/requeue or finalize the job.
      if (leaseLost || error?.code === 'LEASE_LOST') {
        this.onEvent({ type: 'workflow-job.lease-lost', jobId: job.id, stage: job.stage });
        return { status: 'lease-lost', job: { id: job.id }, error: { message: (leaseLost || error).message } };
      }
      const retryable = error && error.retryable === true;
      const failed = await this.queue.fail(job.id, error, { retryable, retryDelaySeconds: error?.retryDelaySeconds ?? 10 });
      this.onEvent({ type: failed.status === 'QUEUED' ? 'workflow-job.retry-scheduled' : 'workflow-job.failed', jobId: job.id, stage: job.stage });
      return { status: failed.status.toLowerCase(), job: failed, error: { message: error.message || String(error), retryable } };
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.activeJobs.delete(job.id);
    }
  }

  async run({ signal } = {}) {
    const stop = () => this.stop();
    signal?.addEventListener('abort', stop, { once: true });
    let processed = 0;
    try {
      while (!this.stopping && !signal?.aborted) {
        const result = await this.runOnce();
        if (result.status !== 'idle') processed += 1;
        if (result.status === 'idle') {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, this.pollIntervalMs);
            if (signal) {
              const onAbort = () => { clearTimeout(timer); resolve(); };
              signal.addEventListener('abort', onAbort, { once: true });
            }
          });
        }
      }
      return { stopped: true, processed };
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }
}

module.exports = { DurableWorker };
