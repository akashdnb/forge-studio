const test = require('node:test');
const assert = require('node:assert/strict');
const { createVersioningMiddleware, apiVersionContract } = require('../src/api/api-versioning');
const { createApiServer } = require('../src/http-api');

async function withVersionedApi(run) {
  const base = createApiServer({ logger: { error() {} }, apiToken: 'test-token', allowUnauthenticatedRead: true });
  const handler = base.server.listeners('request')[0];
  base.server.removeAllListeners('request');
  const middleware = createVersioningMiddleware({ logger: { info() {} }, rateLimitPerMinute: 1000 });
  base.server.on('request', (req, res) => middleware(req, res, () => handler(req, res)));
  await new Promise((resolve) => base.server.listen(0, '127.0.0.1', resolve));
  const address = base.server.address();
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise((resolve, reject) => base.server.close((error) => error ? reject(error) : resolve())); }
}

async function request(base, path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: {
      authorization: 'Bearer test-token',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, body: await response.json() };
}

test('v2 live handler is a semantic adapter over the existing v1 durable route', async () => {
  await withVersionedApi(async (base) => {
    const v2 = await request(base, '/v2/episodes', { method: 'POST', body: { id: 'ep-versioned', projectId: 'project-1', title: 'Versioned' } });
    assert.equal(v2.response.status, 201);
    assert.equal(v2.response.headers.get('x-api-version'), 'v2');
    assert.equal(v2.response.headers.get('x-api-compatibility'), 'current');
    assert.equal(v2.body.item.id, 'ep-versioned');

    const v1 = await request(base, '/v1/episodes/ep-versioned');
    assert.equal(v1.response.status, 200);
    assert.equal(v1.response.headers.get('x-api-version'), 'v1');
    assert.equal(v1.response.headers.get('deprecation'), 'true');
    assert.equal(v1.response.headers.get('sunset'), 'Mon, 27 Apr 2027 00:00:00 GMT');
    assert.equal(v1.body.item.episode.id, v2.body.item.id);
  });
});

test('Accept negotiation and version mismatch are enforced', async () => {
  await withVersionedApi(async (base) => {
    const negotiated = await request(base, '/v1/episodes', { headers: { accept: 'application/vnd.forge.v1+json' } });
    assert.equal(negotiated.response.status, 200);
    const mismatch = await request(base, '/v1/episodes', { headers: { accept: 'application/vnd.forge.v2+json' } });
    assert.equal(mismatch.response.status, 406);
    assert.equal(mismatch.body.error.code, 'API_VERSION_MISMATCH');
    const unsupported = await request(base, '/v9/episodes');
    assert.equal(unsupported.response.status, 406);
    assert.equal(unsupported.body.error.code, 'UNSUPPORTED_API_VERSION');
  });
});

test('pagination, IDs, enums and idempotency keys are validated before handlers', async () => {
  await withVersionedApi(async (base) => {
    for (const path of ['/v2/episodes?limit=0', '/v2/episodes?limit=201', '/v2/episodes?offset=-1']) {
      const result = await request(base, path);
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error.code, 'INVALID_PAGINATION');
    }
    const invalidId = await request(base, '/v2/episodes', { method: 'POST', body: { id: '', projectId: 'p', title: 'bad' } });
    assert.equal(invalidId.response.status, 400);
    assert.equal(invalidId.body.error.code, 'INVALID_ID');
    const invalidEnum = await request(base, '/v2/episodes/ep/transitions', { method: 'POST', body: { state: 'NOT_A_REAL_STATE' } });
    assert.equal(invalidEnum.response.status, 400);
    assert.equal(invalidEnum.body.error.code, 'INVALID_ENUM');
    const invalidKey = await request(base, '/v2/episodes', { method: 'POST', headers: { 'idempotency-key': 'x' }, body: { id: 'ep-id', projectId: 'p', title: 'bad' } });
    assert.equal(invalidKey.response.status, 400);
    assert.equal(invalidKey.body.error.code, 'INVALID_IDEMPOTENCY_KEY');
  });
});

test('malformed JSON and unknown additive fields preserve v1 compatibility', async () => {
  await withVersionedApi(async (base) => {
    const malformed = await fetch(base + '/v2/episodes', { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '{"id":' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, 'MALFORMED_JSON');

    const additive = await request(base, '/v2/episodes', { method: 'POST', body: { id: 'ep-additive', projectId: 'p', title: 'ok', futureField: 'ignored-by-current-domain' } });
    assert.equal(additive.response.status, 201);
  });
});

test('contract policy protects current and legacy versions', () => {
  const policy = apiVersionContract();
  assert.deepEqual(policy.supported, ['v1', 'v2']);
  assert.equal(policy.current, 'v2');
  assert.equal(policy.default, 'v1');
  assert.equal(policy.rules.breakingChanges, 'new-major-version-only');
  assert.match(policy.rules.errors, /stable/);
});
