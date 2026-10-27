'use strict';
const {WorkflowSlaService}=require('./workflow-sla');
const {JobQueue}=require('../persistence/job-queue');
const {WorkflowScheduler}=require('../scheduling/workflow-scheduler');
const INSTALLED=Symbol.for('forge.workflowSla.installed');
function install(pool=null){if(globalThis[INSTALLED])return globalThis[INSTALLED].sla;const getSla=(owner)=>new WorkflowSlaService({pool:pool||owner.pool});
 const originalClaim=JobQueue.prototype.claim,originalClaimSpecific=JobQueue.prototype.claimSpecific,originalHeartbeat=JobQueue.prototype.heartbeat,originalSucceed=JobQueue.prototype.succeed,originalFail=JobQueue.prototype.fail;
 JobQueue.prototype.claim=async function(options={}){const job=await originalClaim.call(this,options);if(!job)return null;const sla=getSla(this);await sla.ensureRun(job,options.workerId||'worker');await sla.assertRunnable(job);job.workflowSla=await sla.inspect(job.id);return job;};
 JobQueue.prototype.claimSpecific=async function(id,workerId,now){const job=await originalClaimSpecific.call(this,id,workerId,now);if(!job)return null;const sla=getSla(this);await sla.ensureRun(job,workerId);await sla.assertRunnable(job);job.workflowSla=await sla.inspect(job.id);return job;};
 JobQueue.prototype.heartbeat=async function(id,workerId,token){const result=await originalHeartbeat.call(this,id,workerId,token);const sla=getSla(this);const h=await sla.heartbeat(id);if(!h&&result)throw Object.assign(new Error(`SLA heartbeat rejected for ${id}`),{code:'WORKFLOW_DEADLINE_EXCEEDED',retryable:false});return result;};
 JobQueue.prototype.succeed=async function(id,workerId,result,token){const sla=getSla(this);const job=await sla.inspect(id);await sla.assertRunnable(job,{phase:'COMMIT'});const updated=await originalSucceed.call(this,id,workerId,result,token);await sla.complete(id);return updated;};
 JobQueue.prototype.fail=async function(id,workerId,error,options={}){const sla=getSla(this);const job=await sla.inspect(id).catch(()=>null);if(job)await sla.assertRunnable(job,{phase:'FAILURE'}).catch(e=>{if(e.code!=='WORKFLOW_DEADLINE_EXCEEDED')throw e});return originalFail.call(this,id,workerId,error,options);};
 const originalSchedulerClaim=WorkflowScheduler.prototype.claimNext,originalSchedulerRecover=WorkflowScheduler.prototype.recover;
 WorkflowScheduler.prototype.claimNext=async function(options={}){const job=await originalSchedulerClaim.call(this,options);if(!job)return null;const sla=getSla(this);await sla.ensureRun(job,options.workerId||this.schedulerId);await sla.assertRunnable(job);job.workflowSla=await sla.inspect(job.id);return job;};
 WorkflowScheduler.prototype.recover=async function(options={}){const sla=getSla(this);const result=await sla.warnAndRecover(options);const base=await originalSchedulerRecover.call(this,options);return{...base,slaWarnings:result.warnings,slaRecovered:result.recovered,slaExpired:result.expired,slaStuck:result.stuck};};
 globalThis[INSTALLED]={sla:pool?new WorkflowSlaService({pool}):null};return globalThis[INSTALLED].sla;}
install();
module.exports={install};
