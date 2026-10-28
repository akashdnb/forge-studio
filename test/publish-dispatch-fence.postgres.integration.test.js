'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { RuntimePublishService } = require('../src/publishing/publish-service-runtime');
const { DistributedLock } = require('../src/coordination/distributed-lock');

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
const table = 'forge_test_publish_dispatch_runs';
const releaseTable = 'forge_test_publish_dispatch_release';
let pool;

function service(ownerId) {
  return new RuntimePublishService({
    pool,
    storage: { download: async () => { throw new Error('dispatch-fence test must not materialize an artifact'); } },
    registry: { get: () => ({ validateRequest() {}, publish: async () => ({ id: 'unused' }) }) },
    coordinator: new DistributedLock({ pool, ownerId }),
    logger: { warn() {} }
  });
}

async function setup() {
  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY,status text NOT NULL,delivery_state text NOT NULL,gate_fingerprint text NOT NULL,release_epoch bigint)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${releaseTable} (id boolean PRIMARY KEY,epoch bigint NOT NULL)`);
  await pool.query(`TRUNCATE ${table}, ${releaseTable}`);
  const release = (await pool.query('SELECT epoch FROM forge_release_state WHERE id=true')).rows[0];
  if (!release) throw new Error('forge_release_state singleton is missing after migration');
  const epoch = Number(release.epoch);
  await pool.query(`INSERT INTO ${releaseTable}(id,epoch) VALUES(true,$1)`, [epoch]);
  return epoch;
}

async function cleanup() {
  await pool.query(`DROP TABLE IF EXISTS ${table}, ${releaseTable}`);
  await pool.end();
  pool = null;
}

test('PostgreSQL concurrent publish dispatch fence allows one authoritative dispatch and persists the winner', { skip }, async () => {
  const epoch = await setup();
  const runId = `dispatch-race-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await pool.query(`INSERT INTO ${table}(id,status,delivery_state,gate_fingerprint,release_epoch) VALUES($1,'QUEUED','READY_TO_PUBLISH','fp-unchanged',$2)`, [runId, epoch]);
  const run = { id: runId, gate_fingerprint: 'fp-unchanged', release_epoch: epoch };
  const first = service(`dispatch-fence-a-${runId}`);
  const second = service(`dispatch-fence-b-${runId}`);
  let authoritativeDispatches = 0;

  const dispatch = async (candidate) => candidate.withPublishFence(runId, async () => {
    await candidate.claimDispatchFence(run, { publishRunsTable: table, releaseStateTable: releaseTable });
    authoritativeDispatches += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    await pool.query(`UPDATE ${table} SET status='PUBLISHED',delivery_state='PUBLISHED' WHERE id=$1 AND status IN ('QUEUED','UPLOADING')`, [runId]);
    return 'published';
  });

  const results = await Promise.allSettled([dispatch(first), dispatch(second)]);
  assert.equal(authoritativeDispatches, 1);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.code, /GATE_CHANGED|PUBLISH_COORDINATION_BUSY/);

  const persisted = (await pool.query(`SELECT status,delivery_state,gate_fingerprint,release_epoch FROM ${table} WHERE id=$1`, [runId])).rows[0];
  assert.deepEqual(persisted, { status: 'PUBLISHED', delivery_state: 'PUBLISHED', gate_fingerprint: 'fp-unchanged', release_epoch: String(epoch) });
  await cleanup();
});

test('PostgreSQL dispatch fence rejects a changed gate fingerprint before provider input can be authoritative', { skip }, async () => {
  const epoch = await setup();
  const runId = `dispatch-stale-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await pool.query(`INSERT INTO ${table}(id,status,delivery_state,gate_fingerprint,release_epoch) VALUES($1,'QUEUED','READY_TO_PUBLISH','fp-current',$2)`, [runId, epoch]);
  const candidate = service(`dispatch-fence-stale-${runId}`);
  const run = { id: runId, gate_fingerprint: 'fp-stale', release_epoch: epoch };

  await assert.rejects(
    () => candidate.withPublishFence(runId, () => candidate.claimDispatchFence(run, { publishRunsTable: table, releaseStateTable: releaseTable })),
    (error) => error.code === 'GATE_CHANGED' && error.terminalState === 'RECONCILIATION_REQUIRED'
  );
  assert.equal((await pool.query(`SELECT status,delivery_state FROM ${table} WHERE id=$1`, [runId])).rows[0].status, 'QUEUED');
  assert.equal((await pool.query(`SELECT status,delivery_state FROM ${table} WHERE id=$1`, [runId])).rows[0].delivery_state, 'READY_TO_PUBLISH');
  await cleanup();
});

test('PostgreSQL dispatch fence rejects a release epoch change even when the stored run fingerprint is unchanged', { skip }, async () => {
  const epoch = await setup();
  const runId = `dispatch-release-change-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await pool.query(`INSERT INTO ${table}(id,status,delivery_state,gate_fingerprint,release_epoch) VALUES($1,'QUEUED','READY_TO_PUBLISH','fp-unchanged',$2)`, [runId, epoch]);
  await pool.query(`UPDATE ${releaseTable} SET epoch=$1 WHERE id=true`, [epoch + 1]);
  const candidate = service(`dispatch-fence-release-${runId}`);
  const run = { id: runId, gate_fingerprint: 'fp-unchanged', release_epoch: epoch };

  await assert.rejects(
    () => candidate.withPublishFence(runId, () => candidate.claimDispatchFence(run, { publishRunsTable: table, releaseStateTable: releaseTable })),
    (error) => error.code === 'GATE_CHANGED' && error.terminalState === 'RECONCILIATION_REQUIRED'
  );
  const persisted = (await pool.query(`SELECT status,delivery_state FROM ${table} WHERE id=$1`, [runId])).rows[0];
  assert.deepEqual(persisted, { status: 'QUEUED', delivery_state: 'READY_TO_PUBLISH' });
  await cleanup();
});
