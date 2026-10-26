const { requiredString } = require('../domain/records');

class DurableWorker {
  constructor({ queue, executeJob, pollIntervalMs = 1000, onEvent = () => {}, workerId = 'worker' }) {
    if (!queue || typeof queue.claim !== 'function' || typeof queue.complete !== 'function' || typeof queue.fail !== 'function') throw new TypeError('A durable queue is required');
    if (typeof executeJob !== 'function') throw new TypeError('executeJob(job) is required');
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 60000) throw new TypeError('pollIntervalMs must be 50..60000');
    this.queue = queue;
    this.executeJob = executeJob;
    this.pollIntervalMs = pollIntervalMs;
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
    try {
      const result = await this.executeJob(job);
      const completed = await this.queue.complete(job.id, result || {});
      this.onEvent({ type: 'workflow-job.succeeded', jobId: job.id, stage: job.stage });
      return { status: 'succeeded', job: completed, result };
    } catch (error) {
      const retryable = error && error.retryable === true;
      const failed = await this.queue.fail(job.id, error, { retryable, retryDelaySeconds: error?.retryDelaySeconds ?? 10 });
      this.onEvent({ type: failed.status === 'QUEUED' ? 'workflow-job.retry-scheduled' : 'workflow-job.failed', jobId: job.id, stage: job.stage });
      return { status: failed.status.toLowerCase(), job: failed, error: { message: error.message || String(error), retryable } };
    } finally {
      this.activeJobs.delete(job.id);
    }
  }

  async run({ signal } = {}) {
    const stop = () => this.stop();
    signal?.addEventListener('abort', stop, { once: true });
    const results = [];
    try {
      while (!this.stopping && !signal?.aborted) {
        const result = await this.runOnce();
        results.push(result);
        if (result.status === 'idle') await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
      return { stopped: true, processed: results.filter((r) => r.status !== 'idle').length, results };
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }
}

module.exports = { DurableWorker };
