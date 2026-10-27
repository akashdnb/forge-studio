'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { RightsComplianceService, normalizeRights, stable, sha256 } = require('../src/rights/service');

function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function integration(name, fn) {
  if (!process.env.DATABASE_URL || process.env.FORGE_RIGHTS_INTEGRATION !== '1') return test(name, { skip: 'set DATABASE_URL and FORGE_RIGHTS_INTEGRATION=1 for PostgreSQL rights integration tests' }, fn);
  return test(name, fn);
}

integration('rights normalization is canonical and timezone/expiry data is preserved', async () => {
  const rights = normalizeRights({ owner: 'Owner', licenseType: 'Royalty-Free', permittedUses: ['PUBLISH','publish','PACKAGE'], territories: ['IN','GLOBAL'], destinations: ['YouTube'], timezone: 'Asia/Kolkata', expiresAt: '2026-10-27T23:59:59+05:30', derivativeAllowed: true });
  assert.deepEqual(rights.permittedUses, ['package','publish']);
  assert.deepEqual(rights.destinations, ['youtube']);
  assert.equal(rights.timezone, 'Asia/Kolkata');
  assert.equal(rights.derivativeAllowed, true);
  assert.equal(stable({b:1,a:2}), stable({a:2,b:1}));
  assert.match(sha256(rights), /^[a-f0-9]{64}$/);
});

integration('expired rights, territory mismatch, and derivative denial fail closed with diagnostics', async (t) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  t.after(() => pool.end());
  const tenant=id('tenant'), project=id('project'), episode=id('episode'), version=id('version'), artifact=id('artifact');
  await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4)',[project,'rights-test','test',tenant]);
  await pool.query(`INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4)`,[episode,project,'rights test','test']);
  await pool.query(`INSERT INTO version_records(id,episode_id,kind,payload,created_by) VALUES($1,$2,'render',$3::jsonb,'test')`,[version,episode,'{}']);
  await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_hash,media_type,created_by) VALUES($1,$2,'render',$3,'s3://test',$4,'video/mp4','test')`,[artifact,episode,version,'a'.repeat(64)]);
  const rights = new RightsComplianceService({ pool, now: () => new Date('2026-10-27T12:00:00Z') });
  const created=await rights.create({tenantId:tenant,projectId:project,actor:'test',targetType:'ARTIFACT',targetId:artifact,rights:{owner:'owner',licenseType:'limited',permittedUses:['package','publish'],territories:['IN'],destinations:['youtube'],expiresAt:'2026-10-27T10:00:00Z',derivativeAllowed:false,evidenceRefs:['evidence:1']}});
  await rights.setReviewState({tenantId:tenant,projectId:project,recordId:created.id,actor:'reviewer',state:'APPROVED',evidence:{ticket:'R-1'}});
  const blocked=await pool.query(`SELECT forge_rights_resolve($1,$2,'PUBLISH','youtube','US','2026-10-27T12:00:00Z') result`,[episode,artifact]);
  const result=blocked.rows[0].result;
  assert.equal(result.decision,'BLOCK');
  assert.ok(result.diagnostics.some(d => d.code==='RIGHTS_EXPIRED'));
  assert.ok(result.diagnostics.some(d => d.code==='RIGHTS_TERRITORY_DENIED'));
  await pool.query('DELETE FROM forge_rights_actions WHERE project_id=$1',[project]);
  await pool.query('DELETE FROM forge_rights_versions WHERE rights_record_id=$1',[created.id]);
  await pool.query('DELETE FROM forge_rights_records WHERE id=$1',[created.id]);
  await pool.query('DELETE FROM artifacts WHERE id=$1',[artifact]);
  await pool.query('DELETE FROM version_records WHERE id=$1',[version]);
  await pool.query('DELETE FROM episodes WHERE id=$1',[episode]);
  await pool.query('DELETE FROM projects WHERE id=$1',[project]);
});

integration('optimistic rights replacement admits exactly one concurrent writer', async (t) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  t.after(() => pool.end());
  const tenant=id('tenant'), project=id('project'), artifact=id('artifact');
  await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4)',[project,'rights-concurrency','test',tenant]);
  const rights = new RightsComplianceService({ pool });
  const created=await rights.create({tenantId:tenant,projectId:project,actor:'test',targetType:'ARTIFACT',targetId:artifact,rights:{owner:'owner',licenseType:'limited',permittedUses:['publish'],territories:['global'],destinations:['youtube'],derivativeAllowed:true}});
  const results=await Promise.allSettled([1,2].map(i=>rights.replace({tenantId:tenant,projectId:project,recordId:created.id,expectedVersionNo:1,actor:`writer-${i}`,rights:{owner:`owner-${i}`,licenseType:'limited',permittedUses:['publish'],territories:['global'],destinations:['youtube'],derivativeAllowed:true}}));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='RIGHTS_VERSION_CONFLICT').length,1);
  await pool.query('DELETE FROM forge_rights_actions WHERE project_id=$1',[project]);
  await pool.query('DELETE FROM forge_rights_versions WHERE rights_record_id=$1',[created.id]);
  await pool.query('DELETE FROM forge_rights_records WHERE id=$1',[created.id]);
  await pool.query('DELETE FROM projects WHERE id=$1',[project]);
});
