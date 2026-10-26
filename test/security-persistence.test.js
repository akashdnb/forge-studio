const test = require('node:test');
const assert = require('node:assert/strict');
const { authorize, tokenMatches } = require('../src/http-api');
const { PersistentProductionRepository } = require('../src/persistence/production-repository');

test('bearer token comparison rejects mismatched and empty tokens', () => {
  assert.equal(tokenMatches('secret', 'secret'), true);
  assert.equal(tokenMatches('secret', 'secrets'), false);
  assert.equal(tokenMatches('', ''), false);
});

test('HTTP API requires a valid bearer token for mutations when configured', () => {
  const options = { apiToken: 'private-token', allowUnauthenticatedRead: true };
  assert.equal(authorize({ method: 'POST', url: '/v1/episodes', headers: {} }, options).ok, false);
  assert.equal(authorize({ method: 'POST', url: '/v1/episodes', headers: { authorization: 'Bearer wrong' } }, options).ok, false);
  assert.deepEqual(authorize({ method: 'POST', url: '/v1/episodes', headers: { authorization: 'Bearer private-token' } }, options), { ok: true, actor: 'api' });
  assert.equal(authorize({ method: 'GET', url: '/healthz', headers: {} }, options).ok, true);
});

test('persistent repository rejects an invalid episode transition before updating rows', async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (sql.includes('SELECT * FROM episodes WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'ep-1', revision: 1, state: 'DRAFT', project_id: 'p-1' }] };
          return { rows: [] };
        },
        release() { calls.push({ sql: 'RELEASE' }); },
      };
    },
  };
  const repository = new PersistentProductionRepository({ pool });
  await assert.rejects(repository.transitionEpisode({ id: 'ep-1', nextState: 'PUBLISHED', expectedRevision: 1 }), /Illegal episode transition/);
  assert.equal(calls.some((c) => c.sql.includes('UPDATE episodes SET state')), false);
  assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
});
