const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderRegistry } = require('../src/pipeline/provider-pipeline');
const { CAPABILITIES, GenerationWorker, classifyError, createGenerationProviderRegistry, validateOutput } = require('../src/generation/generation-worker');

const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('generation registry registers all production capabilities', () => {
  const registry = createGenerationProviderRegistry({ providers: Object.fromEntries(CAPABILITIES.map((capability) => [capability, { name: `test-${capability}`, execute: async () => ({ content: Buffer.from('x'), contentType: 'text/plain' }) }])) });
  assert.deepEqual(registry.list().map((x) => x.capability), CAPABILITIES);
});

test('retry classification distinguishes rate limits, timeouts and terminal errors', () => {
  assert.equal(classifyError({ status: 429 }).retryable, true);
  assert.equal(classifyError({ code: 'PROVIDER_TIMEOUT' }).retryable, true);
  assert.equal(classifyError({ code: 'INVALID_OUTPUT' }).retryable, false);
  assert.equal(classifyError({ code: 'CANCELLED' }).retryable, false);
});

test('provider output validation rejects malformed and unsupported outputs', () => {
  assert.throws(() => validateOutput({ content: Buffer.alloc(0), contentType: 'image/png', capability: 'image-generation' }, { maxOutputBytes: 1000, maxTextChars: 1000, maxWidth: 100, maxHeight: 100, maxDurationSeconds: 10 }), /empty/i);
  assert.throws(() => validateOutput({ content: Buffer.from('secret'), contentType: 'application/octet-stream', capability: 'image-generation' }, { maxOutputBytes: 1000, maxTextChars: 1000, maxWidth: 100, maxHeight: 100, maxDurationSeconds: 10 }), /Unsupported/);
  const result = validateOutput({ content: validPng, contentType: 'image/png', capability: 'image-generation' }, { maxOutputBytes: 1000, maxTextChars: 1000, maxWidth: 100, maxHeight: 100, maxDurationSeconds: 10 });
  assert.equal(result.sha256.length, 64);
});

test('worker rejects unsupported capability before touching providers', async () => {
  const worker = new GenerationWorker({ pool: {}, providerRegistry: new ProviderRegistry() });
  await assert.rejects(() => worker.execute({ episodeId: 'ep', inputVersionIds: ['v'], capability: 'audio-generation' }), (error) => error.code === 'UNSUPPORTED_CAPABILITY');
});

test('provider registry rejects duplicate capability registration', () => {
  const registry = new ProviderRegistry();
  registry.register('image-generation', { name: 'a', execute: async () => ({}) });
  assert.throws(() => registry.register('image-generation', { name: 'b', execute: async () => ({}) }), /already registered/);
});
