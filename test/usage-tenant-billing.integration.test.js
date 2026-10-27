'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Pool}=require('pg');
const {TenantUsageBilling}=require('../src/usage/tenant-usage-billing');

const skip=!process.env.TEST_DATABASE_URL;

test('postgres billing reservation is idempotent and concurrent quota-safe',{skip},async()=>{
 const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const tenant=(await pool.query('SELECT id FROM tenants LIMIT 1')).rows[0]?.id;
 if(!tenant){await pool.end();return}
 const suffix=crypto.randomUUID().replaceAll('-','');
 const plan=`plan:test-billing:${suffix}`,pv=`planver:test-billing:${suffix}`,assign=`assign:test-billing:${suffix}`;
 const cap=`billing_test_${suffix}`,price=`test-billing-price-${suffix}`;
 const definition=JSON.stringify({capabilities:{[cap]:{enabled:true,limit:1,overagePolicy:'DENY'}}});
 const contentHash=crypto.createHash('sha256').update(definition).digest('hex');
 const job=i=>({id:`job:test:${suffix}:${i}`,tenant_id:tenant,project_id:null,attempts:1,kind:'test-op',payload:{billingCapability:cap,provider:'test',operation:'test-op',usageEstimate:{units:1}}});
 try{
  await pool.query('INSERT INTO forge_plans(id,slug,name,created_by) VALUES($1,$2,$3,$4)',[plan,`test-${suffix}`,'Billing Test','test']);
  await pool.query(`INSERT INTO forge_plan_versions(id,plan_id,version,effective_at,status,epoch,definition,content_hash,created_by,activated_at) VALUES($1,$2,1,now(),'ACTIVE',1,$3::jsonb,$4,'test',now())`,[pv,plan,definition,contentHash]);
  await pool.query(`INSERT INTO forge_plan_entitlements(plan_version_id,capability,enabled,limit_value,overage_policy) VALUES($1,$2,true,1,'DENY')`,[pv,cap]);
  await pool.query(`INSERT INTO forge_tenant_plan_assignments(id,tenant_id,plan_version_id,effective_at,status,epoch,requested_by,reason) VALUES($1,$2,$3,now()-interval '1 second','SCHEDULED',999999,'test','billing integration')`,[assign,tenant,pv]);
  await pool.query(`INSERT INTO usage_pricing_versions(pricing_version,provider_type,provider,model,operation,unit,rate,currency,effective_at) VALUES($1,'worker','test','','test-op','request',2,'USD',now())`,[price]);
  const billing=new TenantUsageBilling({pool,reservationTtlMs:60000});
  const [a,b]=await Promise.all([billing.reserveJob(job(1),{provider:'test',operation:'test-op'}),billing.reserveJob(job(2),{provider:'test',operation:'test-op'})]);
  assert.equal([a.allowed,b.allowed].filter(Boolean).length,1);
  const winner=a.allowed?a:b;
  const same=await billing.reserveJob(a.allowed?job(1):job(2),{provider:'test',operation:'test-op'});
  assert.equal(same.reused,true);
  await billing.release({reservationId:winner.reservation.reservation_id,reason:'test-cleanup'});
 }finally{
  await pool.query(`DELETE FROM forge_entitlement_reservations WHERE tenant_id=$1 AND metadata->>'billingReservationId' IN (SELECT reservation_id::text FROM usage_billing_reservations WHERE job_id LIKE $2)`,[tenant,`job:test:${suffix}:%`]);
  await pool.query(`DELETE FROM usage_billing_reservations WHERE job_id LIKE $1`,[`job:test:${suffix}:%`]);
  await pool.query('DELETE FROM forge_tenant_plan_assignments WHERE id=$1',[assign]);
  await pool.query('DELETE FROM forge_plan_entitlements WHERE plan_version_id=$1',[pv]);
  await pool.query('DELETE FROM forge_plan_versions WHERE id=$1',[pv]);
  await pool.query('DELETE FROM forge_plans WHERE id=$1',[plan]);
  await pool.query('DELETE FROM usage_pricing_versions WHERE pricing_version=$1',[price]);
  await pool.end();
 }
});
