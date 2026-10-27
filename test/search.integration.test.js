const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ProductionSearchService, SearchConcurrency, normalizeQuery, parseLimit } = require('../src/search/production-search');
const { PersistentProductionRepository } = require('../src/persistence/production-repository');

let pg;
try { pg = require('pg'); } catch { pg = null; }
const hasDatabase = Boolean(process.env.DATABASE_URL && pg);

test('search validation rejects unsafe input and unbounded limits', () => {
  assert.throws(() => normalizeQuery('a\u0000b'), /control characters/);
  assert.throws(() => parseLimit('101'), /between 1 and 100/);
});

test('search concurrency applies backpressure', () => {
  const gate = new SearchConcurrency(1);
  assert.equal(gate.acquire(), true);
  assert.equal(gate.acquire(), false);
  gate.release();
  assert.equal(gate.acquire(), true);
});

test('postgres search integration: tenant isolation, filters, ordering and index maintenance', { skip: !hasDatabase }, async (t) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const repo = new PersistentProductionRepository({ pool });
  await repo.migrate();
  const tenantA = `test-search-tenant-a:${crypto.randomUUID()}`;
  const tenantB = `test-search-tenant-b:${crypto.randomUUID()}`;
  const actorA = `search-actor-a:${crypto.randomUUID()}`;
  const actorB = `search-actor-b:${crypto.randomUUID()}`;
  const projectA = `search-project-a:${crypto.randomUUID()}`;
  const projectB = `search-project-b:${crypto.randomUUID()}`;
  const episodeA = `search-episode-a:${crypto.randomUUID()}`;
  const episodeB = `search-episode-b:${crypto.randomUUID()}`;
  const jobA = `search-job-a:${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3),($4,$5,$6)`, [tenantA,'Search A',actorA,tenantB,'Search B',actorB]);
  await pool.query(`INSERT INTO projects(id,tenant_id,name,created_by,metadata) VALUES($1,$2,$3,$4,'{}'),($5,$6,$7,$8,'{}')`, [projectA,tenantA,'Volcano Search Project',actorA,projectB,tenantB,'Secret Volcano Project',actorB]);
  await pool.query(`INSERT INTO project_members(project_id,tenant_id,actor_id,role) VALUES($1,$2,$3,'OWNER'),($4,$5,$6,'OWNER')`, [projectA,tenantA,actorA,projectB,tenantB,actorB]);
  await pool.query(`INSERT INTO episodes(id,project_id,title,description,created_by) VALUES($1,$2,'Volcano Episode','geology production',$3),($4,$5,'Hidden Volcano','tenant secret',$6)`, [episodeA,projectA,actorA,episodeB,projectB,actorB]);
  await pool.query(`INSERT INTO forge_jobs(id,project_id,episode_id,kind,status,idempotency_key,created_by) VALUES($1,$2,$3,'render','FAILED',$4,$5)`, [jobA,projectA,episodeA,`search-idem:${crypto.randomUUID()}`,actorA]);
  const search = new ProductionSearchService({ pool });
  t.after(async () => {
    await pool.query(`DELETE FROM forge_jobs WHERE id=$1`, [jobA]);
    await pool.query(`DELETE FROM episodes WHERE id IN ($1,$2)`, [episodeA,episodeB]);
    await pool.query(`DELETE FROM project_members WHERE project_id IN ($1,$2)`, [projectA,projectB]);
    await pool.query(`DELETE FROM projects WHERE id IN ($1,$2)`, [projectA,projectB]);
    await pool.query(`DELETE FROM tenants WHERE id IN ($1,$2)`, [tenantA,tenantB]);
    await pool.end();
  });
  const first = await search.search({ tenantId:tenantA, actor:actorA, params:{ query:'Volcano', projectId:projectA, limit:'10' } });
  assert.ok(first.items.length >= 2);
  assert.ok(first.items.every(item => item.project_id === projectA));
  assert.equal(first.items[0].source_type, 'project');
  assert.ok(Number(first.items[0].relevance) > 0);
  const isolated = await search.search({ tenantId:tenantA, actor:actorA, params:{ query:'Secret', limit:'10' } });
  assert.equal(isolated.items.length, 0);
  const incident = await search.search({ tenantId:tenantA, actor:actorA, params:{ query:'render', sourceTypes:'job', state:'FAILED', projectId:projectA, limit:'10' } });
  assert.equal(incident.items.length, 1);
  assert.equal(incident.items[0].source_id, jobA);
  const health = await search.health({ tenantId:tenantA });
  assert.equal(health.schemaVersion,1);
  assert.equal(health.staleEntries,0);
});

test('postgres search integration: resumable rebuild and missing-entry reconciliation', { skip: !hasDatabase }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const repo = new PersistentProductionRepository({ pool });
  await repo.migrate();
  const tenant = `test-rebuild-tenant:${crypto.randomUUID()}`;
  const actor = `rebuild-actor:${crypto.randomUUID()}`;
  const project = `rebuild-project:${crypto.randomUUID()}`;
  await pool.query(`INSERT INTO tenants(id,name,created_by) VALUES($1,'Rebuild',$2)`, [tenant,actor]);
  await pool.query(`INSERT INTO projects(id,tenant_id,name,created_by) VALUES($1,$2,'Rebuild Project',$3)`, [project,tenant,actor]);
  await pool.query(`INSERT INTO project_members(project_id,tenant_id,actor_id,role) VALUES($1,$2,$3,'OWNER')`, [project,tenant,actor]);
  await pool.query(`DELETE FROM forge_search_documents WHERE project_id=$1`, [project]);
  const search = new ProductionSearchService({ pool });
  const rebuild = await search.createRebuild({ tenantId:tenant, actor, projectId:project });
  let state = rebuild;
  for (let i=0;i<20 && state.state!=='SUCCEEDED';i++) state = await search.rebuildBatch({ tenantId:tenant, actor, rebuildId:rebuild.id, limit:10 });
  assert.equal(state.state,'SUCCEEDED');
  const found = await search.search({ tenantId:tenant, actor, params:{ query:'Rebuild', projectId:project, limit:'10' } });
  assert.ok(found.items.some(item => item.source_id === project));
  await pool.query(`DELETE FROM forge_search_documents WHERE project_id=$1 AND source_type='project' AND source_id=$1`, [project]);
  const reconciled = await search.reconcile({ tenantId:tenant, actor, projectId:project, limit:10 });
  assert.ok(reconciled.missingRepaired >= 1);
  const repaired = await search.search({ tenantId:tenant, actor, params:{ query:'Rebuild', projectId:project, limit:'10' } });
  assert.ok(repaired.items.some(item => item.source_id === project));
  await pool.query(`DELETE FROM project_members WHERE project_id=$1`, [project]);
  await pool.query(`DELETE FROM projects WHERE id=$1`, [project]);
  await pool.query(`DELETE FROM tenants WHERE id=$1`, [tenant]);
  await pool.end();
});
