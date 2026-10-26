const test = require('node:test');
const assert = require('node:assert/strict');
const { JobQueue } = require('../src/persistence/job-queue');
const { createWorker } = require('../src/worker');

test('JobQueue validates production-safe configuration', () => {
  assert.throws(() => new JobQueue({ pool: {} }), /pg-compatible pool/);
  assert.throws(() => new JobQueue({ pool: { query() {}, connect() {} }, leaseSeconds: 5 }), /leaseSeconds/);
});

test('worker exposes durable queue and stable worker identity', () => {
  const pool = { query() {}, connect() {} };
  const worker = createWorker({ pool, workerId: 'test-worker' });
  assert.equal(worker.workerId, 'test-worker');
  assert.ok(worker.queue instanceof JobQueue);
  assert.equal(typeof worker.run, 'function');
  assert.equal(typeof worker.stop, 'function');
});
