'use strict';
const { WorkflowControlService } = require('./service');
const { installWorkflowControlHttp } = require('./http');
const { reenterFromCheckpoint } = require('./reentry');
const { sealCheckpoint, validateCheckpoint, quarantineCheckpoint } = require('./checkpoint-integrity');
const { WorkflowTemplateService } = require('../workflow-templates/service');
const { JobQueue } = require('../persistence/job-queue');
const { getActiveObservability } = require('../observability');

function installWorkflowControlGuards(){
  if(global.__forgeWorkflowControlGuards)return;
  global.__forgeWorkflowControlGuards=true;
  const originalDispatch=WorkflowTemplateService.prototype.dispatchPlan;
  WorkflowTemplateService.prototype.dispatchPlan=async function(planId,tenantId,actor,queue){const control=new WorkflowControlService({pool:this.pool});await control.ensure(planId,tenantId,actor);const gate=await control.assertRunnable(planId,tenantId);const result=await originalDispatch.call(this,planId,tenantId,actor,queue);const state=await control.get(planId,tenantId);if(!state||Number(state.execution_epoch)!==Number(gate.executionEpoch)||String(state.fence_token)!==String(gate.fenceToken))throw Object.assign(new Error('Workflow was fenced while dispatching'),{code:'STALE_WORKFLOW_EPOCH',statusCode:409});await this.pool.query(`UPDATE forge_jobs SET workflow_execution_epoch=$2,workflow_fence_token=$3 WHERE payload->>'executionPlanId'=$1 AND status IN ('QUEUED','RUNNING')`,[planId,gate.executionEpoch,gate.fenceToken]);return result;};
  const originalSuccess=WorkflowTemplateService.prototype.handleJobSuccess;WorkflowTemplateService.prototype.handleJobSuccess=async function(job,result,queue,actor){const control=new WorkflowControlService({pool:this.pool});try{await control.assertRunnable(job.payload.executionPlanId,job.payload.tenantId,job.workflow_execution_epoch,job.workflow_fence_token);}catch(error){if(['WORKFLOW_FENCED','STALE_WORKFLOW_EPOCH','STALE_WORKFLOW_FENCE'].includes(error.code))return{accepted:false,code:error.code};throw error;}return originalSuccess.call(this,job,result,queue,actor);};
  const originalFailure=WorkflowTemplateService.prototype.handleJobFailure;WorkflowTemplateService.prototype.handleJobFailure=async function(job){const control=new WorkflowControlService({pool:this.pool});try{await control.assertRunnable(job.payload.executionPlanId,job.payload.tenantId,job.workflow_execution_epoch,job.workflow_fence_token);}catch(error){if(['WORKFLOW_FENCED','STALE_WORKFLOW_EPOCH','STALE_WORKFLOW_FENCE'].includes(error.code))return{accepted:false,code:error.code};throw error;}return originalFailure.call(this,job);};
  const once=async function(args,original){const key=args?.idempotencyKey;if(!key)throw Object.assign(new Error('Idempotency key is required'),{code:'IDEMPOTENCY_REQUIRED',statusCode:400});const prior=(await this.pool.query('SELECT 1 FROM forge_workflow_control_events WHERE tenant_id=$1 AND idempotency_key=$2',[args.tenantId,key])).rows[0];if(prior)return this.get(args.planId,args.tenantId);return original.call(this,args);};

  const originalPause=WorkflowControlService.prototype.pause;
  WorkflowControlService.prototype.pause=async function(args){const result=await originalPause.call(this,args);if(result?.checkpoint?.id){try{await sealCheckpoint({pool:this.pool,checkpointId:result.checkpoint.id,tenantId:args.tenantId,actor:args.actor});}catch(error){getActiveObservability()?.metrics.inc('forge_workflow_checkpoint_seal_total',{outcome:error.code||'error'});throw error;}}getActiveObservability()?.metrics.inc('forge_workflow_pause_total',{outcome:'success'});return this.get(args.planId,args.tenantId);};

  const originalResume=WorkflowControlService.prototype.resume;
  WorkflowControlService.prototype.resume=async function(args){const before=await this.get(args.planId,args.tenantId);if(!before?.checkpoint?.id)throw Object.assign(new Error('No checkpoint is available for resume'),{code:'CHECKPOINT_MISSING',statusCode:409});await validateCheckpoint({pool:this.pool,checkpointId:before.checkpoint.id,tenantId:args.tenantId,actor:args.actor});const result=await originalResume.call(this,args);if(result?.state==='RUNNABLE')await reenterFromCheckpoint({pool:this.pool,planId:args.planId,tenantId:args.tenantId,actor:args.actor,idempotencyKey:`${args.idempotencyKey}:reentry`});getActiveObservability()?.metrics.inc('forge_workflow_resume_total',{outcome:'success'});return this.get(args.planId,args.tenantId);};

  const originalRetry=WorkflowControlService.prototype.retryFromCheckpoint;
  WorkflowControlService.prototype.retryFromCheckpoint=async function(args){return once.call(this,args,async a=>{const before=await this.get(a.planId,a.tenantId);if(!before?.checkpoint?.id)throw Object.assign(new Error('No checkpoint is available for re-entry'),{code:'CHECKPOINT_MISSING',statusCode:409});await validateCheckpoint({pool:this.pool,checkpointId:before.checkpoint.id,tenantId:a.tenantId,actor:a.actor});const result=await originalRetry.call(this,a);if(result?.state==='RUNNABLE')await reenterFromCheckpoint({pool:this.pool,planId:a.planId,tenantId:a.tenantId,actor:a.actor,idempotencyKey:`${a.idempotencyKey}:reentry`});return result;});};

  WorkflowControlService.prototype.sealCheckpoint=async function(args){return sealCheckpoint({pool:this.pool,...args});};
  WorkflowControlService.prototype.validateCheckpoint=async function(args){return validateCheckpoint({pool:this.pool,...args});};
  WorkflowControlService.prototype.quarantineCheckpoint=async function(args){return quarantineCheckpoint({pool:this.pool,...args});};

  for(const name of ['intervene','decideIntervention','skipWithApproval']){const original=WorkflowControlService.prototype[name];WorkflowControlService.prototype[name]=async function(args){return once.call(this,args,original);};}
  const originalClaim=JobQueue.prototype.claim;const originalClaimSpecific=JobQueue.prototype.claimSpecific;const guarded=async function(job){if(!job)return null;const svc=new WorkflowControlService({pool:this.pool});const allowed=await svc.admitJob(job);if(!allowed)return null;return job;};JobQueue.prototype.claim=async function(options){return guarded.call(this,await originalClaim.call(this,options));};JobQueue.prototype.claimSpecific=async function(id,workerId,now){return guarded.call(this,await originalClaimSpecific.call(this,id,workerId,now));};
}
installWorkflowControlGuards();
try{const extended=require('../extended-http-api');installWorkflowControlHttp(extended);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
module.exports={installWorkflowControlGuards};
