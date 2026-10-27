const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyProviderError, computeBackoffMs, ProviderReliability, ProviderCircuitStore } = require('../src/reliability/provider-reliability');
const provider = (name, execute) => ({ name, execute });

test('classifies rate limits, timeout and auth failures', () => {
  assert.deepEqual(classifyProviderError(Object.assign(new Error('busy'), { status: 429, retryAfterMs: 1500 })), { retryable: true, reason: 'rate-limit', normalizedCode: 'RATE_LIMITED', retryAfterMs: 1500 });
  assert.equal(classifyProviderError(Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT' })).retryable, true);
  assert.equal(classifyProviderError(Object.assign(new Error('unauthorized'), { status: 401 })).retryable, false);
});

test('backoff is bounded, exponential, jittered and honors Retry-After', () => {
  const policy = { baseBackoffMs: 100, maxBackoffMs: 500, jitterRatio: 0.25 };
  assert.equal(computeBackoffMs(1, policy, 0, () => 0), 100);
  assert.equal(computeBackoffMs(2, policy, 0, () => 1), 250);
  assert.equal(computeBackoffMs(5, policy, 0, () => 0), 500);
  assert.equal(computeBackoffMs(1, policy, 900, () => 0), 900);
});

test('retries transient failures and assigns deterministic attempt identities', async () => {
  let calls = 0; const attempts = []; const reliability = new ProviderReliability({ random: () => 0 });
  const result = await reliability.execute({ provider: provider('primary', async (_request, context) => { calls += 1; attempts.push(context.attemptId); if (calls < 3) throw Object.assign(new Error('temporary'), { status: 503 }); return { ok: true }; }), operation: 'llm', request: { prompt: 'x' }, context: { idempotencyKey: 'job-1' }, policy: { maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 2, timeoutMs: 100 } });
  assert.equal(result.result.ok, true); assert.equal(calls, 3); assert.equal(attempts[0], reliability.attemptIdentity('job-1', 'primary', 'llm', 1)); assert.equal(attempts[1], reliability.attemptIdentity('job-1', 'primary', 'llm', 2));
});

test('terminal auth failures are not retried', async () => {
  let calls = 0; const reliability = new ProviderReliability();
  await assert.rejects(reliability.execute({ provider: provider('auth', async () => { calls += 1; throw Object.assign(new Error('bad key'), { status: 401 }); }), operation: 'tts', request: {}, context: { idempotencyKey: 'auth-1' }, policy: { maxAttempts: 5 } }), /bad key/);
  assert.equal(calls, 1);
});

test('provider timeout is retryable while caller cancellation is terminal', async () => {
  const reliability = new ProviderReliability({ random: () => 0 }); let calls = 0;
  const result = await reliability.execute({ provider: provider('slow', async (_request, context) => { calls += 1; await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 50); context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }); }); return { ok: true }; }), operation: 'video', request: {}, context: { idempotencyKey: 'timeout-1' }, policy: { maxAttempts: 2, timeoutMs: 5, baseBackoffMs: 1, maxBackoffMs: 2 } });
  assert.equal(result.result.ok, true); assert.equal(calls, 2);
  const controller = new AbortController(); const cancelled = reliability.execute({ provider: provider('cancel', async (_request, context) => new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true }))), operation: 'video', request: {}, context: { signal: controller.signal, idempotencyKey: 'cancel-1' }, policy: { maxAttempts: 3, timeoutMs: 1000 } }); controller.abort(); await assert.rejects(cancelled, (error) => error.code === 'CANCELLED');
});

test('circuit transitions open and recovers through half-open', async () => {
  const store = new ProviderCircuitStore({ policy: { failureThreshold: 2, recoveryMs: 10, halfOpenMaxCalls: 1 } }); const circuit = await store.get('provider', 'operation');
  assert.equal(circuit.allow().allowed, true); await circuit.failure(); await circuit.failure(); assert.equal(circuit.allow().allowed, false); await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(circuit.allow().allowed, true); await circuit.success(); assert.equal(circuit.state, 'CLOSED');
});

test('concurrency limit bounds active provider calls', async () => {
  let active = 0; let maxActive = 0; const reliability = new ProviderReliability(); const p = provider('limited', async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 15)); active -= 1; return { ok: true }; });
  await Promise.all(Array.from({ length: 8 }, (_, i) => reliability.execute({ provider: p, operation: 'image', request: { i }, context: { idempotencyKey: `i-${i}` }, policy: { maxConcurrency: 2, timeoutMs: 1000 } }))); assert.ok(maxActive <= 2); assert.equal(active, 0);
});

test('failover requires idempotency and contract compatibility', async () => {
  let fallbackCalls = 0; const reliability = new ProviderReliability(); const result = await reliability.execute({ provider: provider('primary', async () => { throw Object.assign(new Error('outage'), { status: 503 }); }), fallbacks: [provider('fallback', async () => { fallbackCalls += 1; return { source: 'fallback' }; })], operation: 'image', request: {}, context: { idempotencyKey: 'failover-1' }, policy: { maxAttempts: 1 }, contract: { idempotent: true, allowFailover: true, contractCompatible: true } });
  assert.equal(result.result.source, 'fallback'); assert.equal(fallbackCalls, 1);
  await assert.rejects(reliability.execute({ provider: provider('primary2', async () => { throw Object.assign(new Error('outage'), { status: 503 }); }), fallbacks: [provider('fallback2', async () => { fallbackCalls += 1; return {}; })], operation: 'publish', request: {}, context: { idempotencyKey: 'publish-1' }, policy: { maxAttempts: 1 }, contract: { idempotent: false, allowFailover: true, contractCompatible: true } }), /outage/); assert.equal(fallbackCalls, 1);
});
