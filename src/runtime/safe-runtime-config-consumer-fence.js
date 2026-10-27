'use strict';
const { serviceFor } = require('./safe-runtime-config-bootstrap');
const { JobQueue } = require('../persistence/job-queue');
if(!JobQueue.prototype.__forgeSafeRuntimeConfigFenceInstalled){
  const claim=JobQueue.prototype.claim, claimSpecific=JobQueue.prototype.claimSpecific;
  const fence=async(queue,job,workerId)=>{if(!job)return job;const tenantId=(await queue.pool.query('SELECT tenant_id FROM projects WHERE id=$1',[job.project_id])).rows[0]?.tenant_id||null;const cfg=await serviceFor(queue.pool).resolve({configKey:'background.execution.enabled',tenantId,projectId:job.project_id,actorId:workerId,includeMetadata:true});if(cfg?.generation!==undefined)await serviceFor(queue.pool).consumerFence({consumerId:workerId||'unknown',consumerType:'worker',tenantId,projectId:job.project_id,configFingerprint:cfg.schemaFingerprint||null,generation:cfg.generation,fenceEpoch:cfg.fenceEpoch,metadata:{jobId:job.id,configKey:'background.execution.enabled'}});return job;};
  JobQueue.prototype.claim=async function fencedClaim(options){return fence(this,await claim.call(this,options),options?.workerId)};
  JobQueue.prototype.claimSpecific=async function fencedClaimSpecific(id,workerId,now){return fence(this,await claimSpecific.call(this,id,workerId,now),workerId)};
  JobQueue.prototype.__forgeSafeRuntimeConfigFenceInstalled=true;
}
