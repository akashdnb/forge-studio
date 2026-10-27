'use strict';
const {Pool}=require('pg');
const {TenantUsageBilling}=require('./tenant-usage-billing');
const {ProviderReliability}=require('../reliability/provider-reliability');
const {ArtifactStorageService}=require('../storage/artifact-storage-service');

if(process.env.DATABASE_URL){
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,idleTimeoutMillis:30000,connectionTimeoutMillis:5000});
 const billing=new TenantUsageBilling({pool,reservationTtlMs:Number(process.env.FORGE_BILLING_RESERVATION_TTL_MS||900000)});
 if(!ProviderReliability.prototype.__forgeBillingUsage){
  const original=ProviderReliability.prototype.execute;
  ProviderReliability.prototype.execute=async function(options={}){
   const episodeId=options.context?.episodeId||options.request?.episodeId;if(!episodeId)return original.call(this,options);
   const scope=(await pool.query('SELECT p.tenant_id,e.project_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1',[episodeId])).rows[0];if(!scope)return original.call(this,options);
   const jobId=options.context?.jobId||options.request?.jobId;const attempt=Number(options.context?.executionAttempt||options.request?.executionAttempt||1);
   let reservation=(jobId?(await pool.query(`SELECT * FROM usage_billing_reservations WHERE job_id=$1 AND attempt=$2 AND status='HELD' ORDER BY created_at DESC LIMIT 1`,[jobId,attempt])).rows[0]:null);
   if(!reservation){const job={id:`provider:${options.context?.idempotencyKey||options.request?.idempotencyKey||`${episodeId}:${options.operation||'provider'}`}`,tenant_id:scope.tenant_id,project_id:scope.project_id,attempts:1,kind:options.operation||'provider',payload:{billingCapability:'provider_execution',provider:options.provider||options.providerName||'provider',model:options.model||'',operation:options.operation||'provider',usageEstimate:{units:1}}};const admission=await billing.reserveJob(job,{providerType:'provider',provider:job.payload.provider,model:job.payload.model,operation:job.payload.operation,capability:'provider_execution',idempotencyKey:`billing:provider:${job.id}`});reservation=admission.reservation}
   try{const result=await original.call(this,options);const usage=result?.usage||result?.billing||{};await billing.commit({reservationId:reservation.reservation_id,actualQuantity:usage.units??usage.quantity??1,actualAmount:usage.actualCost,providerReference:usage.providerRunId||result?.providerRunId||null,metadata:{source:'provider_reliability'}});return result}catch(error){await billing.release({reservationId:reservation.reservation_id,reason:'provider_failed'});throw error}
  };
  ProviderReliability.prototype.__forgeBillingUsage=true;
 }
 if(!ArtifactStorageService.prototype.__forgeBillingUsage){
  const original=ArtifactStorageService.prototype.putArtifact;
  ArtifactStorageService.prototype.putArtifact=async function(options={}){
   if(!options.projectId)return original.call(this,options);
   const scope=(await pool.query('SELECT tenant_id FROM projects WHERE id=$1',[options.projectId])).rows[0];if(!scope)return original.call(this,options);
   const jobId=options.jobId||options.context?.jobId;const attempt=Number(options.attempt||options.context?.executionAttempt||1);let reservation=jobId?(await pool.query(`SELECT * FROM usage_billing_reservations WHERE job_id=$1 AND attempt=$2 AND status='HELD' ORDER BY created_at DESC LIMIT 1`,[jobId,attempt])).rows[0]:null;
   if(!reservation){const job={id:`artifact:${options.artifactId||options.id||require('node:crypto').randomUUID()}`,tenant_id:scope.tenant_id,project_id:options.projectId,attempts:1,kind:'artifact-storage',payload:{billingCapability:'artifact_storage',provider:'object-storage',operation:'artifact.put',usageEstimate:{units:1}}};const admission=await billing.reserveJob(job,{providerType:'storage',provider:'object-storage',operation:'artifact.put',capability:'artifact_storage',idempotencyKey:`billing:artifact:${job.id}`});reservation=admission.reservation}
   try{const result=await original.call(this,options);const bytes=Number(options.sizeBytes||options.bytes||result?.sizeBytes||0);await billing.commit({reservationId:reservation.reservation_id,actualQuantity:1,metadata:{source:'artifact_storage',bytes}});return result}catch(error){await billing.release({reservationId:reservation.reservation_id,reason:'artifact_put_failed'});throw error}
  };
  ArtifactStorageService.prototype.__forgeBillingUsage=true;
 }
}
