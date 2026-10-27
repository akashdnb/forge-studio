'use strict';
const { WorkflowControlService } = require('./service');
const { installWorkflowControlHttp } = require('./http');
const { WorkflowTemplateService } = require('../workflow-templates/service');
const { JobQueue } = require('../persistence/job-queue');

function installWorkflowControlGuards(){
  if(global.__forgeWorkflowControlGuards)return;
  global.__forgeWorkflowControlGuards=true;
  const originalDispatch=WorkflowTemplateService.prototype.dispatchPlan;
  WorkflowTemplateService.prototype.dispatchPlan=async function(planId,tenantId,actor,queue){
    const control=new WorkflowControlService({pool:this.pool});
    await control.ensure(planId,tenantId,actor);
    const gate=await control.assertRunnable(planId,tenantId);
    const result=await originalDispatch.call(this,planId,tenantId,actor,queue);
    const state=await control.get(planId,tenantId);
    if(!state||Number(state.execution_epoch)!==Number(gate.executionEpoch)||String(state.fence_token)!==String(gate.fenceToken))throw Object.assign(new Error('Workflow was fenced while dispatching'),{code:'STALE_WORKFLOW_EPOCH',statusCode:409});
    await this.pool.query(`UPDATE forge_jobs SET workflow_execution_epoch=$2,workflow_fence_token=$3 WHERE payload->>'executionPlanId'=$1 AND status IN ('QUEUED','RUNNING')`,[planId,gate.executionEpoch,gate.fenceToken]);
    return result;
  };
  const originalClaim=JobQueue.prototype.claim;
  const originalClaimSpecific=JobQueue.prototype.claimSpecific;
  const guarded=async function(job){if(!job)return null;const svc=new WorkflowControlService({pool:this.pool});const allowed=await svc.admitJob(job);if(!allowed)return null;return job;};
  JobQueue.prototype.claim=async function(options){return guarded.call(this,await originalClaim.call(this,options));};
  JobQueue.prototype.claimSpecific=async function(id,workerId,now){return guarded.call(this,await originalClaimSpecific.call(this,id,workerId,now));};
}
installWorkflowControlGuards();
try{const extended=require('../extended-http-api');installWorkflowControlHttp(extended);}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
module.exports={installWorkflowControlGuards};
