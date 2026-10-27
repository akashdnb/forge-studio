const test = require('node:test');
const assert = require('node:assert/strict');
const { executeProviderWithRetry, timeoutError } = require('../src/generation/provider-execution-guard');

test('provider timeout aborts the attempt and is fail-closed instead of retried', async () => {
  let calls = 0;
  let aborted = false;
  const provider = { execute: async (_request, context) => { calls += 1; await new Promise((resolve) => context.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); throw Object.assign(new Error('aborted'), { code: 'CANCELLED' }); } };
  await assert.rejects(() => executeProviderWithRetry(provider, {}, { capability: 'video-generation', signal: new AbortController().signal }, { maxAttempts: 3, timeoutMs: 5, retryBaseMs: 1 }), error => error.code === 'PROVIDER_TIMEOUT' && error.retryable === false);
  assert.equal(calls, 1);
  assert.equal(aborted, true);
});

test('429 is retried with bounded backoff and succeeds', async () => {
  let calls = 0;
  const provider = { execute: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 1 }); return { ok: true }; } };
  const result = await executeProviderWithRetry(provider, {}, { capability: 'image-generation', signal: new AbortController().signal }, { maxAttempts: 3, timeoutMs: 100, retryBaseMs: 1 });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('5xx is retried while a non-retryable partial provider failure is not', async () => {
  let calls = 0;
  const provider = { execute: async () => { calls += 1; if (calls === 1) throw Object.assign(new Error('upstream'), { status: 503 }); throw Object.assign(new Error('partial output'), { code: 'INVALID_OUTPUT' }); } };
  await assert.rejects(() => executeProviderWithRetry(provider, {}, { capability: 'video-generation', signal: new AbortController().signal }, { maxAttempts: 3, timeoutMs: 100, retryBaseMs: 1 }), /partial output/);
  assert.equal(calls, 2);
});

test('timeout errors explicitly carry an ambiguous side-effect boundary', () => {
  const error = timeoutError(10);
  assert.equal(error.code, 'PROVIDER_TIMEOUT');
  assert.equal(error.retryable, false);
  assert.equal(error.details.ambiguous, true);
});
