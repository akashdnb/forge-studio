const test = require('node:test');
const assert = require('node:assert/strict');
const { fingerprint, routePattern, createGovernance } = require('../src/api/contract-governance');

test('route identity is version-independent and parameter-stable', () => {
  assert.equal(routePattern('/v1/episodes/123456789/workflow'), '/episodes/:param2/workflow');
  assert.equal(routePattern('/v2/episodes/123456789/workflow'), '/episodes/:param2/workflow');
});

test('schema fingerprint is deterministic and order-independent', () => {
  assert.equal(fingerprint({ b: 2, a: 'x' }), fingerprint({ a: 'x', b: 2 }));
  assert.notEqual(fingerprint({ a: 'x' }), fingerprint({ a: 'y' }));
});

test('governance rejects unavailable durable storage when required', async () => {
  const governance = createGovernance({ pool: { query: async () => { throw new Error('db down'); } }, required: true });
  const request = { url: '/v2/episodes', method: 'GET', headers: {} };
  const response = { headersSent: false, writeHead() { this.headersSent = true; }, end() {} };
  await governance.wrap(() => { throw new Error('handler must not run'); })(request, response);
  assert.equal(response.headersSent, true);
});

test('governance can auto-register a live contract before handler execution', async () => {
  const queries = [];
  const pool = { query: async (text, values) => {
    queries.push([text, values]);
    if (text.includes('to_regclass')) return { rows: [{ table_name: 'forge_api_contracts' }] };
    if (text.includes('SELECT * FROM forge_api_contracts')) return { rows: [] };
    if (text.includes('INSERT INTO forge_api_contracts')) return { rows: [{ id: 1, status: 'supported', sunset_at: null }] };
    if (text.includes('INSERT INTO forge_api_contract_history')) return { rows: [] };
    if (text.includes('INSERT INTO forge_api_consumers')) return { rows: [] };
    if (text.includes('INSERT INTO forge_api_usage')) return { rows: [] };
    return { rows: [] };
  } };
  const governance = createGovernance({ pool, required: true });
  let called = false;
  const request = { url: '/v2/episodes', method: 'GET', headers: {}, socket: {} };
  const response = { headersSent: false, statusCode: 200, writeHead() { this.headersSent = true; }, end() { this.headersSent = true; } };
  await governance.wrap((req, res) => { called = true; res.end('{}'); })(request, response);
  assert.equal(called, true);
  assert.ok(queries.some(([text]) => text.includes('INSERT INTO forge_api_contracts')));
});
