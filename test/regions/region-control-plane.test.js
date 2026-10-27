const test = require('node:test');
const assert = require('node:assert/strict');
const { dryRunFailover, executeFailover, acquireLease } = require('../../src/regions/region-control-plane');

function fakePool(initial = {}) {
  const calls = [];
  const state = { active_region_id: 'primary', routing_epoch: 7, fencing_token: 11, mode: 'ACTIVE', ...initial };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM forge_control_plane_state')) return { rows: [{ ...state }] };
      if (sql.includes('SELECT * FROM forge_regions')) return { rows: [{ region_id: params[0], status: 'READY', health_score: 100 }] };
      if (sql.includes('SELECT tenant_id FROM forge_tenant_residency_policies WHERE active_region_id')) return { rows: [{ tenant_id: 'tenant-a' }] };
      if (sql.includes('SELECT * FROM forge_tenant_residency_policies')) return { rows: [{ tenant_id: 'tenant-a', home_region_id: 'primary', active_region_id: 'primary', allowed_region_ids: ['primary', 'secondary'] }] };
      if (sql.includes('SELECT data_class FROM forge_data_movement_rules')) return { rows: [{ data_class: 'CREDENTIAL_SECRET' }, { data_class: 'ARTIFACT_BYTES' }] };
      if (sql.includes('SELECT count(*)::int AS count')) return { rows: [{ count: 2 }] };
      if (sql.includes('INSERT INTO forge_failover_leases')) return { rows: [{ lease_id: 'lease', tenant_id: 'tenant-a', status: 'ACTIVE' }] };
      return { rows: [] };
    },
    async release() {},
  };
  return { calls, async connect() { return client; }, async query(sql, params = []) { return client.query(sql, params); } };
}

test('dry-run rejects a stale routing epoch before movement', async () => {
  const pool = fakePool();
  await assert.rejects(() => dryRunFailover(pool, { targetRegionId: 'secondary', expectedEpoch: 6 }), /routing epoch changed concurrently/);
});

test('dry-run exposes in-flight reconciliation and immutable movement blocks', async () => {
  const pool = fakePool();
  const result = await dryRunFailover(pool, { targetRegionId: 'secondary', expectedEpoch: 7 });
  assert.equal(result.valid, true);
  assert.equal(result.inFlight, 2);
  assert.deepEqual(result.blockedDataClasses, ['CREDENTIAL_SECRET', 'ARTIFACT_BYTES']);
  assert.match(result.warnings[0], /IN_FLIGHT_JOBS/);
});

test('concurrent failover lease is rejected by the database conflict gate', async () => {
  const pool = fakePool();
  pool.connect = async () => ({ query: async (sql, params = []) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (sql.includes('SELECT * FROM forge_control_plane_state')) return { rows: [{ routing_epoch: 7, fencing_token: 11 }] };
    if (sql.includes('INSERT INTO forge_failover_leases')) return { rows: [] };
    return { rows: [] };
  }, release() {} });
  await assert.rejects(() => acquireLease(pool, { tenantId: 'tenant-a', ownerId: 'operator-b', targetRegionId: 'secondary', expectedEpoch: 7 }), /lease already held/);
});

test('failover increments epoch and fencing token and never requeues in-flight work', async () => {
  const pool = fakePool();
  const result = await executeFailover(pool, { actorId: 'operator-a', targetRegionId: 'secondary', expectedEpoch: 7, reason: 'planned maintenance' });
  assert.equal(result.routingEpoch, 8);
  assert.equal(result.fencingToken, 12);
  assert.equal(result.inFlightReconciliationRequired, true);
  const updateCalls = pool.calls.filter(call => call.sql.includes("UPDATE forge_jobs SET"));
  assert.ok(updateCalls.some(call => call.sql.includes("status='QUEUED'")));
  assert.ok(updateCalls.some(call => call.sql.includes('IN_FLIGHT_FENCED_REQUIRES_RECONCILIATION')));
});
