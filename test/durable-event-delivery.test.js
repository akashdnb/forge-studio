const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DurableEventDelivery, EVENT_SCHEMAS, deterministicDeliveryId, computeBackoff, classifyResponse, encryptSecret, decryptSecret, validateDestination, verifyWebhookSignature } = require('../src/events/durable-delivery');

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) { calls.push({ sql, params });
      if (sql.includes('INSERT INTO forge_event_subscriptions')) return { rows: [{ id: params[0], tenant_id: params[1], project_id: params[2], endpoint_url: params[3], active: true }] };
      if (sql.includes('INSERT INTO forge_events')) return { rows: [{ id: params[0], event_id: params[0], tenant_id: params[1], project_id: params[2], type: params[4], version: params[5], payload: JSON.parse(params[7]), created_at: new Date().toISOString(), sequence_no: 1 }] };
      if (sql.includes('UPDATE forge_event_deliveries') && sql.includes("status='RETRY'")) return { rows: [{ id: 'd1' }] };
      return { rows: [] };
    },
    async connect() { const client = this; return { query: client.query.bind(client), release() {} }; },
  };
}

test('event registry uses explicit immutable versions', () => {
  assert.equal(EVENT_SCHEMAS['episode.state.changed'].version, 1);
  assert.ok(EVENT_SCHEMAS['approval.created'].required.includes('decision'));
});

test('delivery identity is deterministic and duplicate-safe', () => {
  assert.equal(deterministicDeliveryId('evt-1', 'sub-1'), deterministicDeliveryId('evt-1', 'sub-1'));
  assert.notEqual(deterministicDeliveryId('evt-1', 'sub-1'), deterministicDeliveryId('evt-2', 'sub-1'));
  assert.equal(deterministicDeliveryId('evt-1', 'sub-1').length, 40);
});

test('retry classification distinguishes retryable and terminal 4xx', () => {
  assert.equal(classifyResponse(429).retry, true);
  assert.equal(classifyResponse(503).retry, true);
  assert.equal(classifyResponse(400).retry, false);
  assert.equal(classifyResponse(204).outcome, 'SUCCEEDED');
  assert.equal(classifyResponse(429, '3').retryAfterMs, 3000);
});

test('backoff is bounded and jittered', () => {
  for (let attempt = 1; attempt <= 10; attempt += 1) { const delay = computeBackoff(attempt, { baseDelayMs: 10, maxDelayMs: 100 }); assert.ok(delay >= 1 && delay <= 100); }
});

test('webhook secrets are encrypted at rest and recoverable only with the key', () => {
  const encrypted = encryptSecret('super-secret-webhook-value', 'unit-test-key');
  assert.notEqual(encrypted, 'super-secret-webhook-value');
  assert.equal(decryptSecret(encrypted, 'unit-test-key'), 'super-secret-webhook-value');
  assert.throws(() => decryptSecret(encrypted, 'wrong-key'));
});

test('webhook URL validation blocks obvious SSRF targets', () => {
  assert.equal(validateDestination('https://example.com/hooks').startsWith('https://example.com'), true);
  assert.throws(() => validateDestination('http://127.0.0.1:8080/hook'));
  assert.throws(() => validateDestination('http://localhost/hook'));
  assert.throws(() => validateDestination('file:///tmp/x'));
});

test('signature verification is constant-time compatible and replay bounded', () => {
  const secret = 'receiver-secret'; const body = JSON.stringify({ id: 'evt-1' }); const timestamp = Math.floor(Date.now() / 1000);
  const signature = `v1=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  assert.deepEqual(verifyWebhookSignature({ secret, timestamp, body, signature }), { valid: true });
  assert.equal(verifyWebhookSignature({ secret, timestamp: timestamp - 1000, body, signature }).reason, 'REPLAY_WINDOW_EXCEEDED');
  assert.equal(verifyWebhookSignature({ secret, timestamp, body: `${body}x`, signature }).valid, false);
});

test('publish validates schema and appends an outbox record in the same client', async () => {
  const pool = fakePool(); const service = new DurableEventDelivery({ pool });
  const event = await service.publish({ tenantId: 'tenant-1', projectId: 'project-1', episodeId: 'episode-1', type: 'episode.state.changed', payload: { episodeId: 'episode-1', projectId: 'project-1', state: 'APPROVED', revision: 3 } });
  assert.equal(event.type, 'episode.state.changed');
  assert.equal(pool.calls.filter((c) => c.sql.includes('INSERT INTO')).length, 2);
  assert.match(pool.calls[1].params[3], /eventId/);
});

test('subscription creation rejects unknown event types and invalid limits', async () => {
  process.env.FORGE_EVENT_SECRET_KEY = 'test-key'; const service = new DurableEventDelivery({ pool: fakePool() });
  await assert.rejects(() => service.createSubscription({ tenantId: 't', endpointUrl: 'https://example.com', secret: '0123456789012345', eventTypes: ['unknown'], createdBy: 'u' }), /Unknown event type/);
  await assert.rejects(() => service.createSubscription({ tenantId: 't', endpointUrl: 'https://example.com', secret: '0123456789012345', rateLimitPerSecond: 0, createdBy: 'u' }), /rateLimitPerSecond/);
});

test('delivery attempt is signed and 5xx is persisted as retry', async () => {
  const pool = fakePool(); const secret = encryptSecret('0123456789012345', 'test-key');
  const captured = { request: null }; const service = new DurableEventDelivery({ pool, now: () => 1_700_000_000_000, fetchImpl: async (url, request) => { captured.request = { url, ...request }; return { status: 503, headers: { get: () => null } }; }, config: { baseDelayMs: 1, maxDelayMs: 2 } });
  const result = await service.deliver({ id: 'delivery-1', event_id: 'evt-1', subscription_id: 'sub-1', tenant_id: 'tenant-1', project_id: 'project-1', type: 'episode.state.changed', version: 1, created_at: new Date(1_700_000_000_000).toISOString(), payload: { episodeId: 'e', projectId: 'p', state: 'READY', revision: 2 }, endpoint_url: 'https://example.com/hooks', secret_ciphertext: secret, attempts: 1, lease_token: 'lease-1' });
  assert.equal(result.status, 'RETRYING'); assert.equal(captured.request.headers['x-forge-delivery-id'], 'delivery-1'); assert.match(captured.request.headers['x-forge-signature'], /^v1=/);
});

test('delivery attempt dead-letters after the bounded retry count', async () => {
  const pool = fakePool(); const service = new DurableEventDelivery({ pool, now: () => 1_700_000_000_000, config: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 } });
  const result = await service.finishDelivery({ id: 'd1', subscription_id: 's1', attempts: 2, lease_token: 'lease-1' }, { outcome: 'RETRYING', error: new Error('timeout'), latencyMs: 12 });
  assert.equal(result.status, 'DEAD_LETTER'); assert.ok(pool.calls.some((c) => c.sql.includes('forge_event_dlq')));
});

test('claim SQL fences leases and enforces ordering, concurrency, and rate limits', async () => {
  const pool = fakePool(); const service = new DurableEventDelivery({ pool }); await service.claim({ workerId: 'w1', limit: 3 });
  const claimSql = pool.calls.find((c) => c.sql.includes('FOR UPDATE OF d SKIP LOCKED'))?.sql || '';
  for (const token of ['s.ordered','status=\'IN_FLIGHT\'','max_concurrency','rate_limit_per_second','lease_until']) assert.match(claimSql, new RegExp(token.replace(/'/g, "'")));
});

test('lease recovery returns in-flight work to retryable state', async () => {
  const pool = fakePool(); const service = new DurableEventDelivery({ pool }); await service.recoverExpiredLeases();
  assert.match(pool.calls[0].sql, /lease_until < now\(\)/); assert.match(pool.calls[0].sql, /status='RETRY'/);
});

test('delivery worker exposes explicit tick/run/stop lifecycle for crash recovery', () => {
  const { createEventDeliveryWorker } = require('../src/events/delivery-worker'); const worker = createEventDeliveryWorker({ pool: fakePool(), pollMs: 1 });
  assert.equal(typeof worker.tick, 'function'); assert.equal(typeof worker.run, 'function'); assert.equal(typeof worker.stop, 'function');
});

test('migration defines event capture, immutable identity, tenant scope, leases, attempts, ordering and DLQ', async () => {
  const fs = require('node:fs/promises'); const path = require('node:path'); const sql = await fs.readFile(path.join(__dirname, '..', 'migrations', '013_durable_event_delivery.sql'), 'utf8'); const guards = await fs.readFile(path.join(__dirname, '..', 'migrations', '014_durable_event_integrity_guards.sql'), 'utf8');
  for (const token of ['forge_events','forge_event_subscriptions','forge_event_deliveries','forge_event_delivery_attempts','forge_event_dlq','FOR UPDATE SKIP LOCKED','forge_capture_event','forge_event_tenant_guard']) assert.match(sql, new RegExp(token));
  for (const token of ['forge_event_subscription_tenant_guard','forge_event_delivery_tenant_guard','forge_event_immutable_guard','forge_delivery_sequence_guard']) assert.match(guards, new RegExp(token));
});
