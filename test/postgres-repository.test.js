const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository, safeIdentifier } = require('../src/persistence/postgres-repository');

function fakePool() {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      calls.push({ scope: 'pool', sql, params });
      if (sql.includes('SELECT * FROM episodes WHERE id = $1')) return { rows: [{ id: params[0], revision: 1 }] };
      if (sql.includes('SELECT * FROM provider_runs WHERE idempotency_key = $1 FOR UPDATE')) return { rows: [] };
      if (sql.includes('SELECT * FROM episodes WHERE id = $1 FOR UPDATE')) return { rows: [{ id: params[0], revision: 1, state: 'DRAFT', project_id: 'p' }] };
      if (sql.includes('UPDATE episodes SET state')) return { rows: [{ id: params[1], state: params[0], revision: 2 }] };
      if (sql.includes('SELECT * FROM provider_runs WHERE idempotency_key = $1 FOR UPDATE')) return { rows: [] };
      if (sql.includes('INSERT INTO provider_runs')) return { rows: [{ id: params[0], episode_id: params[1], idempotency_key: params[6] }] };
      return { rows: [] };
    },
    async connect() {
      const client = {
        async query(sql, params = []) {
          calls.push({ scope: 'client', sql, params });
          if (sql.includes('SELECT * FROM episodes WHERE id = $1 FOR UPDATE')) return { rows: [{ id: params[0], revision: 1, state: 'DRAFT', project_id: 'p' }] };
          if (sql.includes('UPDATE episodes SET state')) return { rows: [{ id: params[1], state: params[0], revision: 2 }] };
          if (sql.includes('SELECT id FROM episodes WHERE id = $1 FOR UPDATE')) return { rows: [{ id: params[0] }] };
          if (sql.includes('SELECT * FROM provider_runs WHERE idempotency_key = $1 FOR UPDATE')) return { rows: [] };
          if (sql.includes('SELECT episode_id FROM provider_runs WHERE id=$1 FOR SHARE') || sql.includes('SELECT episode_id FROM provider_runs WHERE id = $1 FOR SHARE')) return { rows: [{ episode_id: 'ep-1' }] };
          if (sql.includes('SELECT episode_id FROM version_records WHERE id = $1 FOR SHARE')) return { rows: [{ episode_id: 'ep-1' }] };
          if (sql.includes('INSERT INTO cost_records')) return { rows: [{ id: params[0], episode_id: params[2] }] };
          return { rows: [] };
        },
        release() { calls.push({ scope: 'client', sql: 'RELEASE' }); },
      };
      return client;
    },
  };
  return pool;
}

test('safeIdentifier rejects SQL fragments in schema names', () => {
  assert.equal(safeIdentifier('forge_schema', 'schema'), 'forge_schema');
  assert.throws(() => safeIdentifier('public; DROP TABLE episodes', 'schema'), /safe SQL identifier/);
});

test('transaction commits successful operations and always releases client', async () => {
  const pool = fakePool();
  const repo = new PostgresRepository({ pool });
  const value = await repo.withTransaction(async (client) => {
    await client.query('SELECT 1');
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.deepEqual(pool.calls.map((c) => c.sql), ['BEGIN', 'SELECT 1', 'COMMIT', 'RELEASE']);
});

test('transaction rolls back on failure and preserves the thrown error', async () => {
  const pool = fakePool();
  const repo = new PostgresRepository({ pool });
  await assert.rejects(repo.withTransaction(async () => { throw new Error('write failed'); }), /write failed/);
  assert.deepEqual(pool.calls.map((c) => c.sql), ['BEGIN', 'ROLLBACK', 'RELEASE']);
});

test('episode transition uses row lock and revision compare-and-swap in a transaction', async () => {
  const pool = fakePool();
  const repo = new PostgresRepository({ pool });
  const result = await repo.transitionEpisode({ id: 'ep-1', nextState: 'SCRIPT_DRAFT', expectedRevision: 1, actor: 'test' });
  assert.equal(result.revision, 2);
  assert.ok(pool.calls.some((c) => c.sql.includes('FOR UPDATE')));
  assert.ok(pool.calls.some((c) => c.sql.includes('WHERE id = $2 AND revision = $3')));
  assert.ok(pool.calls.some((c) => c.sql.includes('INSERT INTO audit_events')));
});

test('provider run insert uses unique idempotency key with conflict-safe lookup', async () => {
  const pool = fakePool();
  const repo = new PostgresRepository({ pool });
  const result = await repo.createProviderRun({
    id: 'run-1', episodeId: 'ep-1', capability: 'tts', provider: 'fake', idempotencyKey: 'tts:ep-1:v1',
  });
  assert.equal(result.idempotency_key, 'tts:ep-1:v1');
  assert.ok(pool.calls.at(-1).sql.includes('ON CONFLICT (idempotency_key)'));
});

test('cost record ownership is checked before insert inside transaction', async () => {
  const pool = fakePool();
  const repo = new PostgresRepository({ pool });
  await repo.recordCost({
    id: 'cost-1', runId: 'run-1', episodeId: 'ep-1', provider: 'fake', operation: 'tts', actualCost: 0.02,
  });
  const selectIndex = pool.calls.findIndex((c) => c.sql.includes('SELECT episode_id FROM provider_runs'));
  const insertIndex = pool.calls.findIndex((c) => c.sql.includes('INSERT INTO cost_records'));
  assert.ok(selectIndex >= 0 && insertIndex > selectIndex);
});
