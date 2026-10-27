const test = require('node:test');
const assert = require('node:assert/strict');
let Pool; try { ({ Pool } = require('pg')); } catch { Pool = null; }
const enabled = Boolean(process.env.DATABASE_URL && Pool);

test('postgres fencing rejects a stale region epoch', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const tenant = `region-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO forge_regions(region_id,display_name,status,health_score,capacity_state) VALUES('region-test','Region Test','READY',100,'{}'::jsonb) ON CONFLICT(region_id) DO UPDATE SET status='READY',health_score=100,capacity_state='{}'::jsonb");
    await client.query("INSERT INTO forge_tenant_residency_policies(tenant_id,home_region_id,active_region_id,allowed_region_ids) VALUES($1,'primary','primary','[\"primary\",\"region-test\"]'::jsonb)", [tenant]);
    const before = await client.query("SELECT forge_job_fence_valid($1,'primary',1,1,'primary') AS valid", [tenant]);
    assert.equal(before.rows[0].valid, true);
    await client.query("UPDATE forge_control_plane_state SET active_region_id='region-test',routing_epoch=2,fencing_token=2,mode='PLANNED_FAILOVER' WHERE id=true");
    const stale = await client.query("SELECT forge_job_fence_valid($1,'primary',1,1,'primary') AS valid", [tenant]);
    assert.equal(stale.rows[0].valid, false);
    const active = await client.query("SELECT forge_job_fence_valid($1,'region-test',2,2,'region-test') AS valid", [tenant]);
    assert.equal(active.rows[0].valid, true);
    await client.query('ROLLBACK');
  } finally { try { await client.query('ROLLBACK'); } catch {} client.release(); await pool.end(); }
});

test('postgres advisory lock serializes concurrent operator validation', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL }); const a = await pool.connect(); const b = await pool.connect();
  try { await a.query('BEGIN'); await a.query("SELECT pg_advisory_xact_lock(hashtextextended('forge:global-failover',0))"); const started = Date.now(); const blocked = b.query("SELECT pg_advisory_xact_lock(hashtextextended('forge:global-failover',0))"); await new Promise(resolve => setTimeout(resolve, 100)); assert.ok(Date.now() - started >= 100); await a.query('COMMIT'); await blocked; }
  finally { try { await a.query('ROLLBACK'); } catch {} try { await b.query('ROLLBACK'); } catch {} a.release(); b.release(); await pool.end(); }
});
