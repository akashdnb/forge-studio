'use strict';
const {Pool}=require('pg');
const {JobQueue}=require('../persistence/job-queue');
const {TenantUsageBilling,BillingAdmissionError}=require('./tenant-usage-billing');

if(process.env.DATABASE_URL){
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,idleTimeoutMillis:30000,connectionTimeoutMillis:5000});
  const billing=new TenantUsageBilling({pool,reservationTtlMs:Number(process.env.FORGE_BILLING_RESERVATION_TTL_MS||900000)});
  const marker=Symbol.for('forge.tenant-usage-billing.worker-hook');
  if(!JobQueue.prototype[marker]){
    const originalClaim=JobQueue.prototype.claim;
    JobQueue.prototype.claim=async function(...args){
      const job=await originalClaim.apply(this,args);
      if(!job)return job;
      try{
        const result=await billing.reserveJob(job);
        if(!result.allowed){
          await pool.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,dispatch_token=NULL,updated_at=now(),error=$2::jsonb WHERE id=$1 AND status='RUNNING'`,[job.id,JSON.stringify({code:'BILLING_ADMISSION_REJECTED',message:'billing reservation is not available'})]);
          return null;
        }
        return job;
      }catch(error){
        await pool.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,dispatch_token=NULL,updated_at=now(),error=$2::jsonb WHERE id=$1 AND status='RUNNING'`,[job.id,JSON.stringify({code:error.code||'BILLING_ADMISSION_REJECTED',message:error.message})]);
        if(error instanceof BillingAdmissionError) return null;
        throw error;
      }
    };
    const originalSucceed=JobQueue.prototype.succeed;
    JobQueue.prototype.succeed=async function(id,workerId,result={},dispatchToken=null){
      const updated=await originalSucceed.call(this,id,workerId,result,dispatchToken);
      const reservation=(await pool.query(`SELECT reservation_id FROM usage_billing_reservations WHERE job_id=$1 AND attempt=$2 AND status='HELD' ORDER BY created_at DESC LIMIT 1`,[id,updated.attempts])).rows[0];
      if(reservation){
        const usage=result?.usage||result?.billing||{};
        await billing.commit({reservationId:reservation.reservation_id,actualQuantity:usage.units??usage.quantity,actualAmount:usage.actualCost,providerReference:usage.providerReference||result?.providerRunId||null,metadata:{jobStatus:'SUCCEEDED'}});
      }
      return updated;
    };
    const originalCancel=JobQueue.prototype.cancel;
    JobQueue.prototype.cancel=async function(id,workerId,reason){
      const updated=await originalCancel.call(this,id,workerId,reason);
      const rows=(await pool.query(`SELECT reservation_id FROM usage_billing_reservations WHERE job_id=$1 AND status='HELD' ORDER BY created_at DESC`,[id])).rows;
      for(const row of rows)await billing.release({reservationId:row.reservation_id,reason:'job_cancelled'});
      return updated;
    };
    const originalFail=JobQueue.prototype.fail;
    JobQueue.prototype.fail=async function(id,workerId,error,options={}){
      const updated=await originalFail.call(this,id,workerId,error,options);
      const rows=(await pool.query(`SELECT reservation_id FROM usage_billing_reservations WHERE job_id=$1 AND status='HELD' ORDER BY created_at DESC`,[id])).rows;
      for(const row of rows)await billing.release({reservationId:row.reservation_id,reason:updated.status==='QUEUED'?'attempt_failed_retry':'job_failed'});
      return updated;
    };
    const interval=setInterval(()=>billing.recoverExpired().catch(error=>console.error(JSON.stringify({event:'billing.reservation_recovery_failed',code:error.code,message:error.message}))),Number(process.env.FORGE_BILLING_RECOVERY_INTERVAL_MS||60000));
    interval.unref?.();
    JobQueue.prototype[marker]=true;
  }
}
