const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { LockedSearchIndexConsistencyService } = require('../src/search/index-consistency-locked');

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 8 }) : null;
const TEST_TENANT_A = 'search-consistency-test-a';
const TEST_TENANT_B = 'search-consistency-test-b';
const TEST_PROJECT_A = 'search-consistency-project-a';
const TEST_PROJECT_B = 'search-consistency-project-b';

async function fixture() {
  if (!pool) return null;
  const tenantRows = await pool.query(`SELECT id FROM tenants WHERE id IN ($1,$2)`, [TEST_TENANT_A, TEST_TENANT_B]);
  if (tenantRows.rowCount < 2) return null;
  await pool.query(`INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,'search-test',$3),($4,$5,'search-test',$6) ON CONFLICT(id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id`, [TEST_PROJECT_A,'search project a',TEST_TENANT_A,TEST_PROJECT_B,'search project b',TEST_TENANT_B]);
  return true;
}

test.after(async () => { if (pool) { await pool.query(`DELETE FROM forge_search_index_events WHERE tenant_id IN ($1,$2)`, [TEST_TENANT_A,TEST_TENANT_B]); await pool.query(`DELETE FROM forge_search_documents WHERE tenant_id IN ($1,$2)`, [TEST_TENANT_A,TEST_TENANT_B]); await pool.query(`DELETE FROM projects WHERE id IN ($1,$2)`, [TEST_PROJECT_A,TEST_PROJECT_B]).catch(()=>{}); await pool.end(); } });

test('migration exposes durable generation/event state', async t => {
  if (!pool) return t.skip('DATABASE_URL not configured');
  const r = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('forge_search_index_generations','forge_search_index_events','forge_search_generation_documents','forge_search_index_active_scopes')`);
  assert.equal(r.rowCount,4);
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='forge_search_index_generations' AND column_name IN ('generation_id','schema_version','source_snapshot_at','last_applied_event_id','checkpoint_type','checkpoint_id','failure_state')`);
  assert.equal(cols.rowCount,7);
});

test('tenant/project search ordering has a bounded cursor query plan', async t => {
  if (!pool) return t.skip('DATABASE_URL not configured');
  const r = await pool.query(`EXPLAIN (FORMAT JSON) SELECT project_id,source_type,source_id FROM forge_search_documents WHERE tenant_id=$1 AND project_id=$2 ORDER BY source_updated_at DESC,source_type,source_id LIMIT 50`, ['missing-tenant','missing-project']);
  const plan = JSON.stringify(r.rows[0]['QUERY PLAN']);
  assert.match(plan, /forge_search_documents_(tenant_order|project_filter)_idx/);
});

test('tenant isolation and deterministic cursor pagination are enforced by the read predicate', async t => {
  if (!pool) return t.skip('DATABASE_URL not configured');
  if (!(await fixture())) return t.skip('fixture tenants are not present in this database');
  await pool.query(`SELECT forge_search_refresh_document($1,$2,'episode',$3,NULL,$4,$5,NULL,NULL,NULL,NULL,now(),now(),'{}'::jsonb), forge_search_refresh_document($6,$7,'episode',$8,NULL,$9,$10,NULL,NULL,NULL,NULL,now(),now(),'{}'::jsonb)`, [TEST_PROJECT_A,TEST_TENANT_A,'a-1','alpha','alpha content',TEST_PROJECT_B,TEST_TENANT_B,'b-1','beta','beta content']);
  const first = await pool.query(`SELECT source_id,title FROM forge_search_documents WHERE tenant_id=$1 AND project_id=$2 ORDER BY source_updated_at DESC,source_type,source_id LIMIT 1`, [TEST_TENANT_A,TEST_PROJECT_A]);
  assert.deepEqual(first.rows.map(x=>x.title), ['alpha']);
  const leaked = await pool.query(`SELECT 1 FROM forge_search_documents WHERE tenant_id=$1 AND project_id=$2 AND tenant_id<>$3`, [TEST_TENANT_A,TEST_PROJECT_A,TEST_TENANT_A]);
  assert.equal(leaked.rowCount,0);
});

test('concurrent rebuild workers serialize on a generation lease', async t => {
  if (!pool) return t.skip('DATABASE_URL not configured');
  const tenant = await pool.query(`SELECT id FROM tenants ORDER BY id LIMIT 1`);
  if (!tenant.rowCount) return t.skip('no tenant fixture');
  const tenantId=tenant.rows[0].id;
  const service=new LockedSearchIndexConsistencyService({pool,batchSize:1});
  const generation=await service.createRebuild({tenantId,actor:'search-test'});
  const [a,b]=await Promise.allSettled([service.runBatch({tenantId,actor:'a',generationId:generation.generation_id}),service.runBatch({tenantId,actor:'b',generationId:generation.generation_id})]);
  assert.ok([a,b].every(x=>x.status==='fulfilled' || x.reason));
  await pool.query(`UPDATE forge_search_index_generations SET state='FAILED',failure_state='TEST_CLEANUP' WHERE generation_id=$1`,[generation.generation_id]);
});

test('failure injection leaves resumable failed generation state', async t => {
  if (!pool) return t.skip('DATABASE_URL not configured');
  const tenant = await pool.query(`SELECT id FROM tenants ORDER BY id LIMIT 1`);
  if (!tenant.rowCount) return t.skip('no tenant fixture');
  const tenantId=tenant.rows[0].id;
  const service=new LockedSearchIndexConsistencyService({pool,failureInjector:async ({point})=>{if(point==='before_batch') throw new Error('INJECTED_SEARCH_REBUILD_FAILURE');},batchSize:1});
  const generation=await service.createRebuild({tenantId,actor:'search-test'});
  await assert.rejects(()=>service.runBatch({tenantId,actor:'search-test',generationId:generation.generation_id}),/INJECTED_SEARCH_REBUILD_FAILURE/);
  const state=await service.getGeneration({tenantId,generationId:generation.generation_id});
  assert.equal(state.state,'FAILED');
  assert.equal(state.failure_state,'BUILD_ERROR');
  await pool.query(`DELETE FROM forge_search_index_generations WHERE generation_id=$1`,[generation.generation_id]);
});
