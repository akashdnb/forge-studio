'use strict';
const crypto=require('node:crypto');
const {DistributedRateLimiter}=require('./distributed-rate-limiter');
const patched=Symbol.for('forge.distributed-rate-limit.emergency-patched');
if(!DistributedRateLimiter.prototype[patched]){
 const originalPolicies=DistributedRateLimiter.prototype.policies;
 DistributedRateLimiter.prototype.policies=async function(c,tenantId,projectId,method,route){
   const base=await originalPolicies.call(this,c,tenantId,projectId,method,route);
   const emergency=(await c.query(`SELECT * FROM forge_rate_limit_policies WHERE active AND metadata->>'emergency'='true' AND (metadata->>'expires_at')::timestamptz>clock_timestamp() AND (method=$1 OR method='*') AND (scope_type='GLOBAL' OR (scope_type='TENANT' AND tenant_id=$2) OR (scope_type='PROJECT' AND project_id=$3)) ORDER BY CASE scope_type WHEN 'GLOBAL' THEN 1 WHEN 'TENANT' THEN 2 ELSE 3 END,effective_version DESC`,[method,tenantId,projectId])).rows;
   return [...emergency,...base];
 };
 DistributedRateLimiter.prototype.emergency=async function({tenantId=null,projectId=null,actor,reason='emergency throttle',minutes=15}){
   const duration=Math.max(1,Math.min(1440,Number(minutes)||15));
   const route=`emergency:${crypto.randomUUID()}`;
   return this.upsertPolicy({scopeType:projectId?'PROJECT':tenantId?'TENANT':'GLOBAL',tenantId,projectId,method:'*',routeClass:route,planVersion:'emergency',sustainedRate:0,burstCapacity:0,concurrencyLimit:1,priority:0,enforcementMode:'ENFORCE',failMode:'FAIL_CLOSED',metadata:{emergency:true,expires_at:new Date(Date.now()+duration*60000).toISOString(),reason},actor});
 };
 DistributedRateLimiter.prototype[patched]=true;
}
