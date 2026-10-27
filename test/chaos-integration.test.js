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
    const job = await queue.enqueue({ kind: 'chaos:test', payload: { seed: 42 }, maxAttempts: 2, idempotencyKey: `chaos:${Date.now()}:lease` });
    const claimed = await queue.claimSpecific(job.id, 'chaos-worker-a'); assert.ok(claimed);
    await pool.query("UPDATE forge_jobs SET leased_until=now()-interval '1 second' WHERE id=$1", [job.id]);
    assert.equal(await queue.recoverExpiredLeases(), 1);
    assert.equal((await queue.get(job.id)).status, 'QUEUED');
    const reclaimed = await queue.claimSpecific(job.id, 'chaos-worker-b'); assert.ok(reclaimed);
    await assert.rejects(() => queue.succeed(job.id, 'chaos-worker-a', { stale: true }, claimed.dispatch_token), /STALE_WORKER/);
    await queue.fail(job.id, 'chaos-worker-b', new Error('forced failure'), { retry: true, dispatchToken: reclaimed.dispatch_token, delaySeconds: 1 });
    await pool.query('UPDATE forge_jobs SET available_at=now() WHERE id=$1', [job.id]);
    const last = await queue.claimSpecific(job.id, 'chaos-worker-c'); assert.ok(last);
    await queue.fail(job.id, 'chaos-worker-c', new Error('terminal failure'), { retry: true, dispatchToken: last.dispatch_token });
    assert.equal((await queue.get(job.id)).status, 'FAILED');
  } finally { await pool.end(); }
});
