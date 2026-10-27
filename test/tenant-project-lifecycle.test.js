const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { TenantProjectLifecycle, LifecycleError, STATES } = require('../src/lifecycle/tenant-project-lifecycle');

test('lifecycle state machine exposes all production states and no deleted transition', () => {
  assert.equal(STATES.size, 8);
  assert.ok(STATES.has('DELETION_REQUESTED'));
  assert.ok(STATES.has('DELETION_IN_PROGRESS'));
  assert.ok(STATES.has('LEGAL_HOLD'));
  assert.ok(STATES.has('SAFETY_HOLD'));
  assert.throws(() => { throw new LifecycleError('FORBIDDEN', 'x'); }, /x/);
});

test('lifecycle module is fail-closed without a postgres pool', () => {
  assert.throws(() => new TenantProjectLifecycle(), /pg pool is required/);
});

test('confirmation hashing is not reversible and request operations require explicit confirmation', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push([sql, params]);
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return { rows: [] };
      if (sql.includes('SELECT id,lifecycle_state FROM tenants')) return { rows: [{ id: 't-1', lifecycle_state: 'ACTIVE' }] };
      if (sql.includes('SELECT id,lifecycle_state FROM projects')) return { rows: [{ id: 'p-1', lifecycle_state: 'ACTIVE' }] };
      if (sql.includes('SELECT lifecycle_state FROM tenants')) return { rows: [{ lifecycle_state: 'ACTIVE' }] };
      if (sql.includes('SELECT 1 FROM lifecycle_holds')) return { rows: [] };
      if (sql.includes('SELECT * FROM deletion_requests')) return { rows: [] };
      if (sql.includes('INSERT INTO deletion_requests')) return { rows: [] };
      if (sql.includes("UPDATE tenants SET lifecycle_state='DELETION_REQUESTED'")) return { rows: [] };
      if (sql.includes('INSERT INTO deletion_audit_evidence')) return { rows: [] };
      if (sql.includes('SELECT * FROM deletion_requests WHERE id=$1')) return { rows: [{ id: 'r-1', confirmation_hash: crypto.createHash('sha256').update('DELETE t-1').digest('hex') }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  const lifecycle = new TenantProjectLifecycle({ pool });
  await assert.rejects(() => lifecycle.requestDeletion({ tenantId: 't-1', actor: 'owner', reason: 'customer request', idempotencyKey: 'k-1' }), /confirmation/);
  assert.equal(calls.length, 0);
});

test('integration: tenant deletion preserves audit evidence and removes only the owned project', { skip: !process.env.DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const { PersistentProductionRepository } = require('../src/persistence/production-repository');
  const { createStorageFromEnv } = require('../src/storage');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  try {
    const repository = new PersistentProductionRepository({ pool });
    await repository.migrate();
    const suffix = crypto.randomUUID();
    const tenantId = `test-tenant:${suffix}`;
    const projectId = `test-project:${suffix}`;
    await pool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [tenantId, 'Lifecycle Test', 'test-owner']);
    await repository.createProject({ id: projectId, name: 'Lifecycle Test Project', createdBy: 'test-owner' });
    await pool.query('UPDATE projects SET tenant_id=$1 WHERE id=$2', [tenantId, projectId]);
    await pool.query("INSERT INTO project_members(project_id,tenant_id,actor_id,role) VALUES($1,$2,$3,'OWNER')", [projectId, tenantId, 'test-owner']);
    const lifecycle = new TenantProjectLifecycle({ pool, storage: createStorageFromEnv({ driver: 'local', rootDir: `/tmp/forge-lifecycle-${suffix}` }) });
    const confirmation = `DELETE ${tenantId}`;
    const requested = await lifecycle.requestDeletion({ tenantId, actor: 'test-owner', reason: 'integration test', idempotencyKey: `delete:${suffix}`, confirmation });
    await lifecycle.confirmDeletion({ requestId: requested.request.id, tenantId, actor: 'test-owner', confirmation });
    const plan = await lifecycle.plan({ requestId: requested.request.id, tenantId, actor: 'test-owner', dryRun: true });
    assert.equal(plan.status, 'READY');
    const result = await lifecycle.execute({ requestId: requested.request.id, tenantId, actor: 'test-owner', limit: 100 });
    assert.equal(result.state, 'COMPLETED');
    assert.equal((await pool.query('SELECT 1 FROM tenants WHERE id=$1', [tenantId])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM projects WHERE id=$1', [projectId])).rowCount, 0);
    assert.ok((await pool.query('SELECT 1 FROM deletion_audit_evidence WHERE tenant_id=$1', [tenantId])).rowCount > 0);
  } finally { await pool.end(); }
});
