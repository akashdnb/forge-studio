const test = require('node:test');
const assert = require('node:assert/strict');
const { retryBounded, retryable, delayMs } = require('../src/recovery/recovery-retry');

test('recovery retry uses bounded exponential jitter', async () => {
  let attempts = 0; const waits = [];
  const result = await retryBounded(async () => { attempts += 1; if (attempts < 3) throw Object.assign(new Error('temporary'), { code: 'ETIMEDOUT' }); return 'ok'; }, { maxAttempts: 3, sleep: async (ms) => waits.push(ms) });
  assert.equal(result, 'ok'); assert.equal(attempts, 3); assert.equal(waits.length, 2); assert.ok(waits[1] >= waits[0]); assert.equal(delayMs(1, 100, 100, () => 0.5), 100);
});

test('recovery retry fails closed on integrity errors and cancellation', async () => {
  assert.equal(retryable(Object.assign(new Error('bad checksum'), { code: 'CHECKSUM_MISMATCH' })), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => retryBounded(async () => 'never', { signal: controller.signal }), { code: 'CANCELLED' });
});
