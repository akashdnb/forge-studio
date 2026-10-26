const test = require('node:test');
const assert = require('node:assert/strict');
const { DurableJobQueue } = require('../src/persistence/durable-job-queue');

function fakeQueuePool() {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      calls.push({ scope: 'pool', sql, params });
      if (sql.includes('INSERT INTO workflow_jobs')) return { rows: [{ id: params[0], episode_id: params[1], idempotency_key: params[4], status: 'QUEUED', stage: params[2] }] };
      if (sql.includes('UPDATE workflow_jobs SET heartbeat_at')) return { rows: [{ id: params[1], status: 'RUNNING' }] };
      if (sql.includes('SELECT * FROM workflow_jobs WHERE id=$1')) return { rows: [{ id: params[0], status: 'QUEUED' }] };
      if (sql.includes('SELECT * FROM workflow_jobs')) return { rows: [] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ scope: 'client', sql, params });
          if (sql.includes('UPDATE workflow_jobs SET status=\'FAILED\'')) return { rows: [] };
          if (sql.includes('UPDATE workflow_jobs job SET status=\'RUNNING\'')) return { rows: [{ id: 'job-1', episode_id: 'ep-1', stage: 'SCRIPT', status: 'RUNNING', attempts: 1, locked_by: params[0] }] };
          if (sql.includes('SELECT * FROM workflow_jobs WHERE id=$1 AND status=\'RUNNING\'')) return { rows: [{ id: params[0], status: 'RUNNING', locked_by: params[1], attempts: 1, max_attempts: 3 }] };
          if (sql.includes('UPDATE workflow_jobs SET status=$1,result=')) return { rows: [{ id: params[2], status: params[0] }] };
          if (sql.includes('UPDATE workflow_jobs SET status=$1,available_at=')) return { rows: [{ id: params[3], status: params[0] }] };
          if (sql.includes('INSERT INTO workflow_job_events')) return { rows: [] };
          if (sql.includes('UPDATE workflow_jobs SET status=\'CANCELLED\'')) return { rows: [{ id: params[0], status: 'CANCELLED' }] };
          return { rows: [] };
        },
        release() { calls.push({ scope: 'client', sql: 'RELEASE' }); },
      };
    },
  };
  return pool;
}

test('queue validates jobs and inserts idempotently through a stable key', async () => {
  const pool = fakeQueuePool();
  const queue = new DurableJobQueue({ pool, workerId: 'worker-a' });
  const job = await queue.enqueue({ id: 'job-1', episodeId: 'ep-1', stage: 'SCRIPT', capability: 'llm', idempotencyKey: 'ep-1:script:v1' });
  assert.equal(job.id, 'job-1');
  assert.ok(pool.calls.some((call) => call.sql.includes('ON CONFLICT (idempotency_key)')));
  await assert.rejects(queue.enqueue({ episodeId: 'ep-1', stage: 'NOT_A_STAGE', capability: 'x', idempotencyKey: 'bad' }), /Unknown workflow stage/);
});

test('queue claim uses skip-locked leasing and records claim event', async () => {
  const pool = fakeQueuePool();
  const queue = new DurableJobQueue({ pool, workerId: 'worker-a', leaseSeconds: 60 });
  const job = await queue.claim();
  assert.equal(job.id, 'job-1');
  const claim = pool.calls.find((call) => call.sql.includes('UPDATE workflow_jobs job SET status=\'RUNNING\''));
  assert.ok(claim.sql.includes('SKIP LOCKED'));
  assert.ok(pool.calls.some((call) => call.sql.includes('JOB_CLAIMED')));
});

test('heartbeat renews only a lease still owned by this worker', async () => {
  const pool = fakeQueuePool();
  const queue = new DurableJobQueue({ pool, workerId: 'worker-a' });
  await queue.heartbeat('job-1');
  const call = pool.calls.find((entry) => entry.sql.includes('UPDATE workflow_jobs SET heartbeat_at'));
  assert.ok(call.sql.includes('lease_expires_at > now()'));
  assert.equal(call.params[2], 'worker-a');
});

test('complete requires current lease ownership and releases lease fields', async () => {
  const pool = fakeQueuePool();
  const queue = new DurableJobQueue({ pool, workerId: 'worker-a' });
  const result = await queue.complete('job-1', { artifactIds: ['a1'] });
  assert.equal(result.status, 'SUCCEEDED');
  assert.ok(pool.calls.some((call) => call.sql.includes("locked_by=$4 AND lease_expires_at > now()")));
});

test('fail schedules retry only when retryable and attempts remain', async () => {
  const pool = fakeQueuePool();
  const queue = new DurableJobQueue({ pool, workerId: 'worker-a' });
  const result = await queue.fail('job-1', new Error('temporary'), { retryable: true, retryDelaySeconds: 7 });
  assert.equal(result.status, 'QUEUED');
  assert.ok(pool.calls.some((call) => call.scope === 'client' && call.sql.includes('INSERT INTO workflow_job_events')));
});
