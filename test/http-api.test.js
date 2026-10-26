const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createApiServer, openApiDocument } = require('../src/http-api');

async function withApi(run) {
  const { server, service } = createApiServer({ logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, service);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function request(base, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('health endpoints and OpenAPI document are served', async () => {
  await withApi(async (base) => {
    assert.equal((await request(base, '/healthz')).body.status, 'ok');
    assert.equal((await request(base, '/readyz')).body.checks.persistence, 'in-memory');
    const api = await request(base, '/openapi.json');
    assert.equal(api.status, 200);
    assert.equal(api.body.openapi, '3.0.3');
    assert.ok(api.body.paths['/v1/episodes']);
  });
});

test('creates, lists and retrieves episodes with request IDs', async () => {
  await withApi(async (base) => {
    const created = await request(base, '/v1/episodes', { method: 'POST', body: { id: 'ep-a', projectId: 'p', title: 'Test episode' } });
    assert.equal(created.status, 201);
    assert.ok(created.headers.get('x-request-id'));
    assert.equal(created.body.item.id, 'ep-a');
    assert.equal((await request(base, '/v1/episodes?projectId=p')).body.items.length, 1);
    assert.equal((await request(base, '/v1/episodes/ep-a')).body.item.episode.state, 'DRAFT');
    assert.equal((await request(base, '/v1/episodes/missing')).status, 404);
  });
});

test('validation, malformed JSON and illegal transitions return structured errors', async () => {
  await withApi(async (base) => {
    const bad = await fetch(base + '/v1/episodes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'BAD_REQUEST');

    const invalid = await request(base, '/v1/episodes', { method: 'POST', body: { id: 'bad' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

    await request(base, '/v1/episodes', { method: 'POST', body: { id: 'ep-a', projectId: 'p', title: 'A' } });
    const transition = await request(base, '/v1/episodes/ep-a/transitions', { method: 'POST', body: { state: 'PUBLISHED' } });
    assert.equal(transition.status, 409);
    assert.equal(transition.body.error.code, 'STATE_CONFLICT');
  });
});

test('oversized request body is rejected with 413', async () => {
  await withApi(async (base) => {
    const oversized = 'x'.repeat(1_048_577);
    const response = await fetch(base + '/v1/episodes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oversized }) });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'BAD_REQUEST');
  });
});

test('domain endpoint registers artifacts and returns cost summary', async () => {
  await withApi(async (base) => {
    await request(base, '/v1/episodes', { method: 'POST', body: { id: 'ep-a', projectId: 'p', title: 'A' } });
    const artifact = await request(base, '/v1/episodes/ep-a/artifacts', {
      method: 'POST', body: { id: 'script-a', kind: 'script', versionId: 'script-v1', content: { text: 'Hello' } },
    });
    assert.equal(artifact.status, 201);
    assert.equal(artifact.body.item.contentHash.length, 64);
    const run = await request(base, '/v1/episodes/ep-a/provider-runs', {
      method: 'POST', body: { id: 'run-a', capability: 'llm', provider: 'fake', idempotencyKey: 'ep-a:script-v1' },
    });
    assert.equal(run.status, 201);
    await request(base, '/v1/episodes/ep-a/costs', {
      method: 'POST', body: { id: 'cost-a', runId: 'run-a', provider: 'fake', operation: 'llm', actualCost: 0.01 },
    });
    const costs = await request(base, '/v1/episodes/ep-a/costs');
    assert.equal(costs.body.item.currencies.USD.actual, 0.01);
  });
});
