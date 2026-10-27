const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { TransactionalOutboxDelivery } = require('../src/events/transactional-outbox');

const enabled = Boolean(process.env.DATABASE_URL);
const integration = enabled ? test : test.skip;
let pool;
let projectId;
let episodeId;

integration('transactional outbox preserves per-aggregate ordering under concurrent writers', async () => {
  process.env.FORGE_EVENT_SECRET_KEY ||= 'integration-test-secret-0123456789';
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  projectId = `it-project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  episodeId = `it-episode-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `tenant-${projectId}`;
  await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4)', [projectId, 'transactional-outbox-test', 'integration', tenantId]);
  await pool.query('INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4)', [episodeId, projectId, 'outbox test', 'integration']);

  const writes = Array.from({ length: 12 }, (_, i) => pool.query(
    `SELECT forge_capture_event('job.state.changed',$1,$2,'job','ordered-job',$3::jsonb) AS id`,
    [projectId, episodeId, JSON.stringify({ jobId: 'ordered-job', projectId, kind: `integration-${i}`, status: 'RUNNING' })],
  ));
  await Promise.all(writes);
  const events = (await pool.query(`SELECT aggregate_sequence,ordering_key FROM forge_events WHERE project_id=$1 AND aggregate_type='job' AND aggregate_id='ordered-job' ORDER BY aggregate_sequence`, [projectId])).rows;
  assert.equal(events.length, 12);
  assert.deepEqual(events.map((r) => Number(r.aggregate_sequence)), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(new Set(events.map((r) => r.ordering_key)).size, 1);

  await assert.rejects(
    pool.query(`UPDATE forge_events SET payload='{}'::jsonb WHERE project_id=$1`, [projectId]),
    /immutable|55000/i,
  );
});

integration('outbox leases recover and stale replays are suppressed by the consumer cursor', async () => {
  const delivery = new TransactionalOutboxDelivery({ pool, config: { leaseSeconds: 1 } });
  const tenantId = `tenant-${projectId}`;
  const sub = await delivery.createSubscription({ tenantId, projectId, endpointUrl: 'https://example.com/events', eventTypes: [], ordered: true, secret: 'integration-test-secret-0123456789', createdBy: 'integration' });
  await pool.query(`SELECT forge_capture_event('job.state.changed',$1,$2,'job','replay-job',$3::jsonb)`, [projectId, episodeId, JSON.stringify({ jobId: 'replay-job', projectId, kind: 'integration', status: 'SUCCEEDED' })]);
  await delivery.fanout(20, 'integration-worker-a');
  const row = (await pool.query(`SELECT * FROM forge_event_deliveries WHERE subscription_id=$1 ORDER BY ordering_sequence DESC LIMIT 1`, [sub.id])).rows[0];
  assert.ok(row);

  await pool.query(`UPDATE forge_event_deliveries SET status='IN_FLIGHT',lease_token='expired-token',lease_until=now()-interval '1 second',worker_id='dead-worker' WHERE id=$1`, [row.id]);
  const recovered = await delivery.recoverExpiredLeases();
  assert.equal(recovered.deliveries, 1);
  const recoveredRow = (await pool.query('SELECT status FROM forge_event_deliveries WHERE id=$1', [row.id])).rows[0];
  assert.equal(recoveredRow.status, 'RETRY');

  await pool.query(`UPDATE forge_event_deliveries SET status='SUCCEEDED',acked_at=now(),acked_by='integration' WHERE id=$1`, [row.id]);
  await pool.query(`INSERT INTO forge_event_consumer_cursors(subscription_id,tenant_id,ordering_key,last_acked_sequence,last_event_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(subscription_id,ordering_key) DO UPDATE SET last_acked_sequence=EXCLUDED.last_acked_sequence,last_event_id=EXCLUDED.last_event_id`, [sub.id, tenantId, row.ordering_key, row.ordering_sequence, row.event_id]);
  await delivery.replayDelivery(row.id, tenantId);
  const claimed = await delivery.claim({ workerId: 'integration-worker-b', limit: 10 });
  assert.equal(claimed.some((item) => item.id === row.id), false);
});

test.after(async () => {
  if (!pool) return;
  if (projectId) {
    await pool.query('DELETE FROM forge_event_delivery_attempts WHERE delivery_id IN (SELECT id FROM forge_event_deliveries WHERE project_id=$1)', [projectId]);
    await pool.query('DELETE FROM forge_event_dlq WHERE delivery_id IN (SELECT id FROM forge_event_deliveries WHERE project_id=$1)', [projectId]);
    await pool.query('DELETE FROM forge_event_consumer_cursors WHERE tenant_id=$1', [`tenant-${projectId}`]);
    await pool.query('DELETE FROM forge_event_deliveries WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM forge_outbox WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM forge_events WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM forge_event_subscriptions WHERE project_id=$1', [projectId]);
    await pool.query('DELETE FROM forge_event_order_counters WHERE tenant_id=$1', [`tenant-${projectId}`]);
    await pool.query('DELETE FROM episodes WHERE id=$1', [episodeId]);
    await pool.query('DELETE FROM projects WHERE id=$1', [projectId]);
  }
  await pool.end();
});
