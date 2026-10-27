const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpJsonProvider } = require('../src/pipeline/http-provider');
const { Observability, createTraceContext } = require('../src/observability');

test('provider propagates traceparent and correlation id', async () => {
  let seen;
  const obs = new Observability({ sampleRate: 1, logger: { info() {}, error() {}, warn() {} } });
  const context = createTraceContext({ correlationId: 'corr-provider', traceId: '0123456789abcdef0123456789abcdef' });
  await obs.run(context, () => new HttpJsonProvider({ name: 'test-provider', endpoint: 'https://provider.invalid', fetchImpl: async (_url, options) => { seen = options.headers; return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); } }).execute({ prompt: 'secret content' }));
  assert.match(seen.traceparent, /^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/);
  assert.equal(seen['x-correlation-id'], 'corr-provider');
});

test('provider failure does not retain provider response content', async () => {
  const obs = new Observability({ sampleRate: 1, logger: { info() {}, error() {}, warn() {} } });
  await assert.rejects(() => new HttpJsonProvider({ name: 'test-provider', endpoint: 'https://provider.invalid', fetchImpl: async () => new Response(JSON.stringify({ token: 'super-secret' }), { status: 500 }), maxAttempts: 1 }).execute({ prompt: 'private' }));
  const snapshot = obs.metrics.snapshot();
  assert.ok(snapshot.some((entry) => entry.name === 'forge_provider_requests_total' && entry.labels.provider === 'test-provider'));
});
