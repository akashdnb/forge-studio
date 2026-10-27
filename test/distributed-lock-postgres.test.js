'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

let pg;
try { pg = require('pg'); } catch {}
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const integration = pg && databaseUrl ? test : test.skip;

async function setup() {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const migration = await fs.readFile(path.join(__dirname, '..', 'migrations', '161_distributed_coordination.sql'), 'utf8');
  await pool.query(migration);
  await pool.query("DELETE FROM forge_coordination_audit WHERE scope_key LIKE 'test:coord:%'");
  await pool.query("DELETE FROM forge_coordination_locks WHERE scope_key LIKE 'test:coord:%'");
  return pool;
}

integration('serializes concurrent acquisition storms and returns one fencing token', async () => {
  const { DistributedLock } = require('../src/coordination/distributed-lock');
  const pool = await setup();
  try {
    const workers = Array.from({ length: 12 }, (_, i) => new DistributedLock({ pool, ownerId: `test-worker-${i}` }));
    const results = await Promise.all(workers.map((worker) => worker.acquire({ scopeKey: 'test:coord:storm', purpose: 'storm', leaseMs: 500, waitMs: 0 })));
    assert.equal(results.filter((r) => r.acquired).length, 1);
    const winner = results.find((r) => r.acquired);
    assert.equal(winner.fencingToken, '1');
    await workers.find((w) => w.ownerId === winner.ownerId).release(winner);
  } finally { await pool.end(); }
});

integration('expires dead owners, advances fencing, and rejects stale writers', async () => {
  const { DistributedLock, LockNotHeldError } = require('../src/coordination/distributed-lock');
  const pool = await setup();
  try {
    const a = new DistributedLock({ pool, ownerId: 'test-dead-a' });
    const b = new DistributedLock({ pool, ownerId: 'test-dead-b' });
    const first = await a.acquire({ scopeKey: 'test:coord:fence', tenantId: 'tenant-a', projectId: 'project-a', purpose: 'fence', leaseMs: 150 });
    assert.equal(first.fencingToken, '1');
    await new Promise((resolve) => setTimeout(resolve, 220));
    const second = await b.acquire({ scopeKey: 'test:coord:fence', tenantId: 'tenant-a', projectId: 'project-a', purpose: 'fence', leaseMs: 1000 });
    assert.equal(second.fencingToken, '2');
    await assert.rejects(() => a.assertHeld(first), (error) => error instanceof LockNotHeldError && error.code === 'COORDINATION_FENCE_LOST');
    assert.equal((await a.release(first)).code, 'SUPERSEDED');
    assert.equal((await b.release(second)).released, true);
    assert.equal((await b.release(second)).idempotent, true);
  } finally { await pool.end(); }
});

integration('bounds waits and preserves tenant/project scopes', async () => {
  const { DistributedLock } = require('../src/coordination/distributed-lock');
  const pool = await setup();
  try {
    const a = new DistributedLock({ pool, ownerId: 'test-tenant-a' });
    const b = new DistributedLock({ pool, ownerId: 'test-tenant-b' });
    const held = await a.acquire({ scopeKey: 'test:coord:wait', tenantId: 'tenant-a', projectId: 'project-a', purpose: 'wait', leaseMs: 1000 });
    const started = Date.now();
    const blocked = await b.acquire({ scopeKey: 'test:coord:wait', tenantId: 'tenant-a', projectId: 'project-a', purpose: 'wait', leaseMs: 1000, waitMs: 120, pollMs: 25 });
    assert.equal(blocked.acquired, false);
    assert.ok(Date.now() - started >= 100);
    const isolated = await b.acquire({ scopeKey: 'test:coord:wait:tenant-b', tenantId: 'tenant-b', projectId: 'project-b', purpose: 'wait', leaseMs: 1000 });
    assert.equal(isolated.acquired, true);
    await b.release(isolated); await a.release(held);
  } finally { await pool.end(); }
});

integration('migration is replay-safe and audit evidence records ownership transitions', async () => {
  const pool = await setup();
  try {
    const migration = await fs.readFile(path.join(__dirname, '..', 'migrations', '161_distributed_coordination.sql'), 'utf8');
    await pool.query(migration);
    const result = await pool.query("SELECT event_type FROM forge_coordination_audit WHERE scope_key='test:coord:audit' ORDER BY created_at");
    assert.deepEqual(result.rows, []);
    const { DistributedLock } = require('../src/coordination/distributed-lock');
    const worker = new DistributedLock({ pool, ownerId: 'test-audit' });
    const lease = await worker.acquire({ scopeKey: 'test:coord:audit', purpose: 'audit', leaseMs: 1000 });
    await worker.renew(lease, { leaseMs: 1000 }); await worker.release(lease);
    const events = await pool.query("SELECT event_type FROM forge_coordination_audit WHERE scope_key='test:coord:audit' ORDER BY created_at");
    assert.deepEqual(events.rows.map((r) => r.event_type), ['ACQUIRED', 'RELEASED']);
  } finally { await pool.end(); }
});
