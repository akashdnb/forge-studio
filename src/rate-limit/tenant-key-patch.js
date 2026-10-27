'use strict';
const {DistributedRateLimiter}=require('./distributed-rate-limiter');
const patched=Symbol.for('forge.distributed-rate-limit.tenant-key-patched');
if(!DistributedRateLimiter.prototype[patched]){
 const originalCheck=DistributedRateLimiter.prototype.check;
 DistributedRateLimiter.prototype.check=function(args={}){
   const tenant=String(args.tenantId||'anonymous');
   const requestKey=`${tenant}:${String(args.requestKey||'')}`;
   return originalCheck.call(this,{...args,requestKey});
 };
 DistributedRateLimiter.prototype[patched]=true;
}
