const test = require('node:test');
const assert = require('node:assert/strict');

const databaseUrl = process.env.FORGE_CHAOS_DATABASE_URL || process.env.DATABASE_URL;

test('durable queue survives lease expiry, stale worker completion, and retry exhaustion', { skip: !databaseUrl }, async () => {
  const { Pool } = require('pg');
  const { PostgresRepository } = require('../src/persistence/postgres-repository');
  const { JobQueue } = require('../src/persistence/job-queue');
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await new PostgresRepository({ pool }).migrate();
    const queue = new JobQueue({ pool, leaseSeconds: 10 });
    const idempotencyKey = `chaos:${Date.now()}:lease`;
    const job = await queue.enqueue({ kind: 'chaos:test', payload: { seed: 42 }, maxAttempts: 2, idempotencyKey });
    const claimed = await queue.claimSpecific(job.id, 'chaos-worker-a');
    assert.ok(claimed);
    await pool.query("UPDATE forge_jobs SET leased_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    assert.equal(await queue.recoverExpiredLeases(), 1);
    const recovered = await queue.get(job.id);
    assert.equal(recovered.status, 'QUEUED');
    const reclaimed = await queue.claimSpecific(job.id, 'chaos-worker-b');
    assert.ok(reclaimed);
    await assert.rejects(() => queue.succeed(job.id, 'chaos-worker-a', { stale: true }, claimed.dispatch_token), /STALE_WORKER/);
    await queue.fail(job.id, 'chaos-worker-b', new Error('forced failure'), { retry: true, dispatchToken: reclaimed.dispatch_token, delaySeconds: 1 });
    const retry = await queue.get(job.id);
    assert.equal(retry.status, 'QUEUED');
    const last = await queue.claimSpecific(job.id, 'chaos-worker-c');
    await queue.fail(job.id, 'chaos-worker-c', new Error('terminal failure'), { retry: true, dispatchToken: last.dispatch_token });
    assert.equal((await queue.get(job.id)).status, 'FAILED');
  } finally {
    await pool.end();
  }
});
