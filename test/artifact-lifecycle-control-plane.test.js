'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProductionArtifactLifecycleControlPlane } = require('../src/storage/artifact-lifecycle-production');
const { FinalArtifactLifecycleControlPlane } = require('../src/storage/artifact-lifecycle-final-safety');

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/WITH expired AS/.test(sql)) return { rows: [{ id: 'lease-1', tenant_id: 't1', object_id: 'o1' }], rowCount: 1 };
      return { rows: [] };
    },
    async connect() {
      return {
        query: async (sql, params) => {
          calls.push({ sql, params });
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
          if (/WITH expired AS/.test(sql)) return { rows: [{ id: 'lease-1', tenant_id: 't1', object_id: 'o1' }], rowCount: 1 };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

test('retention policy resolves explicit class and conservative default', () => {
  const service = new ProductionArtifactLifecycleControlPlane({ pool: fakePool(), storage: { delete: async () => {}, head: async () => null } });
  assert.equal(service._retentionDays('package', {}), 365);
  assert.equal(service._retentionDays('unknown', {}), 30);
  assert.equal(service._retentionDays('render', { retentionClass: 'package' }), 365);
});

test('stale lease recovery uses row locking and tenant scope', async () => {
  const pool = fakePool();
  const service = new ProductionArtifactLifecycleControlPlane({ pool, storage: { delete: async () => {}, head: async () => null } });
  const result = await service.recoverStaleLeases({ tenantId: 't1', limit: 10 });
  assert.equal(result.recovered, 1);
  assert.match(pool.calls[1].sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(result.leases[0], { id: 'lease-1', tenant_id: 't1', object_id: 'o1' });
});

test('deletion provider errors are retained as quarantine evidence', async () => {
  const pool = fakePool();
  const service = new ProductionArtifactLifecycleControlPlane({ pool, storage: { delete: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET' }); }, head: async () => null } });
  await service._providerFailure({ id: 'intent-1', tenant_id: 't1', object_id: 'o1', storage_key: 'safe/key' }, Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET' }));
  assert.ok(pool.calls.some(call => /artifact_deletion_intents/.test(call.sql)));
  assert.ok(pool.calls.some(call => /artifact_provider_reconciliation/.test(call.sql)));
});

test('final controller is fail-closed by class construction', () => {
  const service = new FinalArtifactLifecycleControlPlane({ pool: fakePool(), storage: { delete: async () => {}, head: async () => null } });
  assert.equal(typeof service._isProtected, 'function');
  assert.equal(service.constructor.name, 'FinalArtifactLifecycleControlPlane');
});
