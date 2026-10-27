'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { OutboundWebhookReliability } = require('../src/events/outbound-webhook-reliability');

const integration = process.env.DATABASE_URL ? test : test.skip;
let pool;
let tenantId;
let projectId;
let episodeId;
const ids = [];

function endpointOptions(overrides = {}) {
  return {
    dnsResolver: async () => ({ host: 'example.com', address: '93.184.216.34', family: 4 }),
    config: { leaseSeconds: 30, maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2, ...overrides },
  };
}

integration('outbound webhook delivery is tenant scoped, fenced, signed, replayable and circuit protected', async () => {
  process.env.FORGE_EVENT_SECRET_KEY ||= 'integration-webhook-secret-0123456789';
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
  tenantId = `webhook-tenant-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  projectId = `webhook-project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  episodeId = `webhook-episode-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await pool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [tenantId, 'outbound-webhook-test', 'integration']);
  await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4)', [projectId, 'outbound-webhook-test', 'integration', tenantId]);
  await pool.query('INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4)', [episodeId, projectId, 'webhook test', 'integration']);

  const delivery = new OutboundWebhookReliability({ pool, ...endpointOptions() });
  const sub = await delivery.createSubscription({
    tenantId, projectId, endpointUrl: 'https://example.com/webhooks', eventTypes: ['job.state.changed'], ordered: true,
    secret: '0123456789012345', createdBy: 'integration', configurationRef: 'config:webhook-test', maxAttempts: 4,
  });
  ids.push(sub.id);

  const eventId = (await pool.query(`SELECT forge_capture_event('job.state.changed',$1,$2,'job','webhook-job',$3::jsonb) AS id`, [
    projectId, episodeId, JSON.stringify({ jobId: 'webhook-job', projectId, kind: 'integration', status: 'SUCCEEDED' }),
  ])).rows[0].id;
  await delivery.fanout(10, 'fanout-a');

  const workerA = new OutboundWebhookReliability({ pool, ...endpointOptions() });
  const workerB = new OutboundWebhookReliability({ pool, ...endpointOptions() });
  const [claimsA, claimsB] = await Promise.all([
    workerA.claim({ workerId: 'worker-a', limit: 10 }),
    workerB.claim({ workerId: 'worker-b', limit: 10 }),
  ]);
  const claimed = [...claimsA, ...claimsB].filter((row) => row.event_id === eventId);
  assert.equal(claimed.length, 1);

  let request;
  workerA.requestImpl = async (_url, body, headers) => {
    request = { body, headers };
    return { status: 204, headers: {}, body: '' };
  };
  const result = await (claimsA[0] ? workerA.deliver(claimsA[0]) : workerB.deliver(claimsB[0]));
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(request.headers['x-forge-event-id'], eventId);
  assert.equal(request.headers['x-forge-idempotency-key'], claimed[0].id);
  assert.match(request.headers['x-forge-signature'], /^v1=/);
  assert.ok(request.headers['x-forge-nonce']);

  const first = (await pool.query('SELECT * FROM forge_event_deliveries WHERE id=$1', [claimed[0].id])).rows[0];
  assert.equal(first.status, 'SUCCEEDED');

  const rotation = await delivery.rotateSecret(sub.id, tenantId, '0123456789abcdef', 'integration');
  assert.equal(Number(rotation.deliveryEpoch), Number(sub.delivery_epoch) + 1);
  const eventId2 = (await pool.query(`SELECT forge_capture_event('job.state.changed',$1,$2,'job','webhook-job-2',$3::jsonb) AS id`, [
    projectId, episodeId, JSON.stringify({ jobId: 'webhook-job-2', projectId, kind: 'integration', status: 'READY' }),
  ])).rows[0].id;
  await delivery.fanout(10, 'fanout-b');
  const second = (await delivery.claim({ workerId: 'worker-c', limit: 10 })).find((row) => row.event_id === eventId2);
  assert.ok(second);
  assert.notEqual(second.key_id, first.key_id);
  assert.equal(second.endpoint_url_snapshot, 'https://example.com/webhooks');

  const replay = await delivery.replayDelivery(first.id, tenantId, 'integration');
  assert.equal(replay.replay_of, first.id);
  assert.ok(Number(replay.delivery_epoch) > Number(first.delivery_epoch));
  assert.notEqual(replay.id, first.id);

  const circuitSub = await delivery.createSubscription({
    tenantId, projectId, endpointUrl: 'https://example.com/circuit', eventTypes: ['job.state.changed'], ordered: false,
    secret: '0123456789012345', createdBy: 'integration', circuitFailureThreshold: 2, maxAttempts: 4,
  });
  ids.push(circuitSub.id);
  await pool.query(`SELECT forge_capture_event('job.state.changed',$1,$2,'job','circuit-job',$3::jsonb)`, [
    projectId, episodeId, JSON.stringify({ jobId: 'circuit-job', projectId, kind: 'integration', status: 'FAILED' }),
  ]);
  await delivery.fanout(20, 'fanout-circuit');
  const circuitFirst = (await delivery.claim({ workerId: 'circuit-a', limit: 20 })).find((row) => row.subscription_id === circuitSub.id);
  assert.ok(circuitFirst);
  delivery.requestImpl = async () => ({ status: 503, headers: {}, body: 'unavailable' });
  await delivery.deliver(circuitFirst);
  await pool.query(`UPDATE forge_event_deliveries SET available_at=now() WHERE id=$1`, [circuitFirst.id]);
  const circuitSecond = (await delivery.claim({ workerId: 'circuit-b', limit: 20 })).find((row) => row.id === circuitFirst.id);
  assert.ok(circuitSecond);
  await delivery.deliver(circuitSecond);
  const circuit = (await pool.query('SELECT circuit_state,circuit_failures FROM forge_event_subscriptions WHERE id=$1', [circuitSub.id])).rows[0];
  assert.equal(circuit.circuit_state, 'OPEN');
  assert.ok(Number(circuit.circuit_failures) >= 2);

  await delivery.resetCircuit(circuitSub.id, tenantId, 'integration');
  const reset = (await pool.query('SELECT circuit_state,circuit_failures FROM forge_event_subscriptions WHERE id=$1', [circuitSub.id])).rows[0];
  assert.equal(reset.circuit_state, 'CLOSED');
  assert.equal(Number(reset.circuit_failures), 0);
});

test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM security_audit_events WHERE tenant_id=$1', [tenantId]).catch(() => {});
  await pool.query('DELETE FROM forge_event_delivery_attempts WHERE subscription_id IN (SELECT id FROM forge_event_subscriptions WHERE tenant_id=$1)', [tenantId]);
  await pool.query('DELETE FROM forge_event_dlq WHERE delivery_id IN (SELECT id FROM forge_event_deliveries WHERE tenant_id=$1)', [tenantId]);
  await pool.query('DELETE FROM forge_event_consumer_cursors WHERE tenant_id=$1', [tenantId]);
  await pool.query('DELETE FROM forge_event_deliveries WHERE tenant_id=$1', [tenantId]);
  await pool.query('DELETE FROM forge_event_subscription_keys WHERE tenant_id=$1', [tenantId]);
  await pool.query('DELETE FROM forge_outbox WHERE tenant_id=$1', [tenantId]);
  await pool.query('DELETE FROM forge_events WHERE tenant_id=$1', [tenantId]);
  await pool.query('DELETE FROM forge_event_order_counters WHERE tenant_id=$1', [tenantId]);
  await pool.query('DELETE FROM episodes WHERE id=$1', [episodeId]);
  await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
  await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
  await pool.end();
});
