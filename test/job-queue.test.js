const test = require('node:test');
const assert = require('node:assert/strict');
const { JobQueue } = require('../src/persistence/job-queue');
const { Outbox } = require('../src/persistence/outbox');
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

test('outbox claim atomically writes a lease and increments attempts', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('WITH candidates')) return { rows: [{ id: '1', claimed_by: 'worker-a', attempts: 1 }], rowCount: 1 };
    return { rows: [] };
  }, release() { calls.push({ released: true }); } };
  const pool = { query() {}, connect: async () => client };
  const outbox = new Outbox({ pool, leaseSeconds: 60, workerId: 'worker-a' });
  const rows = await outbox.claim({ limit: 5 });
  assert.equal(rows[0].claimed_by, 'worker-a');
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[1].sql, /claimed_until/);
  assert.match(calls[1].sql, /attempts=o\.attempts\+1/);
  assert.equal(calls[2].sql, 'COMMIT');
  assert.equal(calls.at(-1).released, true);
});

test('outbox finalization and failure are scoped to the lease owner', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; }, connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const outbox = new Outbox({ pool, workerId: 'owner' });
  assert.equal(await outbox.markPublished('7', 'other-worker'), null);
  assert.equal(await outbox.markFailed('7', new Error('transient'), 5, 'other-worker'), null);
  assert.match(calls[0].sql, /claimed_by=\$2/);
  assert.match(calls[1].sql, /claimed_by=\$4/);
  assert.equal(calls[1].values[0], 'transient');
  assert.equal(calls[1].values[1], 5);
});
