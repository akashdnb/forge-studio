const test = require('node:test');
const assert = require('node:assert/strict');
const { DurableWorker } = require('../src/pipeline/durable-worker');

test('worker claims a job, executes it, and marks it complete', async () => {
  const events = [];
  let claimed = false;
  let completed = null;
  const queue = {
    async claim() { if (claimed) return null; claimed = true; return { id: 'job-1', episode_id: 'ep-1', stage: 'SCRIPT', attempts: 1 }; },
    async complete(id, result) { completed = { id, result, status: 'SUCCEEDED' }; return completed; },
    async fail() { throw new Error('should not fail'); },
  };
  const worker = new DurableWorker({ queue, executeJob: async (job) => ({ output: job.id }), onEvent: (event) => events.push(event) });
  const result = await worker.runOnce();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(completed, { id: 'job-1', result: { output: 'job-1' }, status: 'SUCCEEDED' });
  assert.equal(events[0].type, 'workflow-job.started');
  assert.equal(events[1].type, 'workflow-job.succeeded');
});

test('worker records retryable failure and does not swallow queue lease failure', async () => {
  let failedOptions = null;
  const queue = {
    async claim() { return { id: 'job-2', episode_id: 'ep-1', stage: 'RENDER', attempts: 1 }; },
    async complete() { throw new Error('unexpected'); },
    async fail(id, error, options) { failedOptions = { id, message: error.message, options }; return { status: 'QUEUED', id }; },
  };
  const worker = new DurableWorker({
    queue,
    executeJob: async () => { throw Object.assign(new Error('provider timeout'), { retryable: true, retryDelaySeconds: 3 }); },
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'queued');
  assert.deepEqual(failedOptions, { id: 'job-2', message: 'provider timeout', options: { retryable: true, retryDelaySeconds: 3 } });
});

test('worker does not claim new work after stop', async () => {
  let claims = 0;
  const worker = new DurableWorker({
    queue: { async claim() { claims += 1; return null; }, async complete() {}, async fail() {} },
    executeJob: async () => ({}),
  });
  worker.stop();
  assert.deepEqual(await worker.runOnce(), { status: 'stopping' });
  assert.equal(claims, 0);
});
