'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {ProviderAdmission,AdmissionRejected}=require('../src/admission/provider-admission');

const databaseUrl=process.env.DATABASE_URL;
test('provider admission PostgreSQL concurrency, stale lease and idempotency', {skip:!databaseUrl}, async()=>{
 const pool=new Pool({connectionString:databaseUrl,max:8});
 const project=(await pool.query('SELECT id,tenant_id FROM projects WHERE tenant_id IS NOT NULL ORDER BY created_at LIMIT 1')).rows[0];
 if(!project){await pool.end();return test.skip('no tenant project fixture');}
 const provider=`test-provider-${Date.now()}`, admission=new ProviderAdmission({pool});
 await pool.query(`INSERT INTO provider_execution_policies(tenant_id,project_id,provider,model,operation,priority,weight,max_concurrency,rate_per_second,burst,lease_ms,epoch,active,updated_by) VALUES($1,$2,$3,'test-model','test',100,1,1,0,1,1000,1,true,'test')`,[project.tenant_id,project.id,provider]);
 try{
  const ctx={tenantId:project.tenant_id,projectId:project.id,idempotencyKey:`concurrency:${Date.now()}`};
  const results=await Promise.allSettled([admission.acquire({provider,model:'test-model',operation:'test',context:{...ctx,idempotencyKey:ctx.idempotencyKey+':a'}}),admission.acquire({provider,model:'test-model',operation:'test',context:{...ctx,idempotencyKey:ctx.idempotencyKey+':b'}})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected'&&x.reason instanceof AdmissionRejected).length,1);
  const held=(await pool.query(`SELECT id FROM provider_admission_leases WHERE tenant_id=$1 AND project_id=$2 AND provider=$3 AND status='HELD'`,[project.tenant_id,project.id,provider])).rows[0];
  assert.ok(held);
  const reused=await admission.acquire({provider,model:'test-model',operation:'test',context:{...ctx,idempotencyKey:ctx.idempotencyKey+':a'}});
  assert.equal(reused.reused,true);
  await admission.settle(held.id,{success:true});
  await pool.query(`UPDATE provider_admission_leases SET status='HELD',lease_until=now()-interval '1 second' WHERE id=$1`,[held.id]);
  const recovered=await admission.acquire({provider,model:'test-model',operation:'test',context:{...ctx,idempotencyKey:ctx.idempotencyKey+':stale'}});
  assert.equal(recovered.allowed,true);
  await admission.settle(recovered.lease.id,{success:false});
 } finally {await pool.query('DELETE FROM provider_admission_leases WHERE provider=$1',[provider]);await pool.query('DELETE FROM provider_admission_decisions WHERE provider=$1',[provider]);await pool.query('DELETE FROM provider_execution_policies WHERE provider=$1',[provider]);await pool.query('DELETE FROM provider_admission_buckets WHERE provider=$1',[provider]);await pool.end();}
});

test('provider admission fails closed on injected database failure', async()=>{
 const injected={query:async()=>{throw Object.assign(new Error('db unavailable'),{code:'ECONNRESET'})},connect:async()=>{throw Object.assign(new Error('db unavailable'),{code:'ECONNRESET'})}};
 const admission=new ProviderAdmission({pool:injected});
 await assert.rejects(()=>admission.acquire({provider:'x',operation:'execute',context:{tenantId:'tenant-x'}}),/db unavailable|ECONNRESET/);
});
