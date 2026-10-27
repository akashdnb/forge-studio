'use strict';
const { VideoProductionService } = require('./service');
const TARGETS = ['workflow:research','workflow:script','workflow:scene_plan','workflow:narration','workflow:transcription','workflow:assets','workflow:timeline','workflow:captions','workflow:render','workflow:qa','workflow:packaging'];
function install(){
  const worker=require('../worker');
  if(worker.__forgeVideoProductionHook)return;
  const original=worker.loadHandlers;
  worker.loadHandlers=function loadHandlersWithVideoProduction(options={}){
    const handlers=original(options);
    if(!options.pool)return handlers;
    const service=new VideoProductionService({pool:options.pool});
    for(const kind of TARGETS){if(typeof handlers[kind]!=='function')continue;const originalHandler=handlers[kind];handlers[kind]=async(payload={},job={})=>{const workflowId=job.workflow_id||payload.workflowId||null;if(!workflowId)return originalHandler(payload,job);const attempt=(await options.pool.query('SELECT a.*,r.id recipe_id FROM video_production_attempts a JOIN video_production_recipes r ON r.id=a.recipe_id WHERE a.workflow_id=$1 ORDER BY a.attempt_no DESC LIMIT 1',[workflowId])).rows[0];if(!attempt)return originalHandler(payload,job);const started=Date.now();try{const result=await originalHandler(payload,job);await options.pool.query("UPDATE video_production_stage_runs SET duration_ms=COALESCE(duration_ms,$3),provider=COALESCE(provider,$4),model=COALESCE(model,$5),updated_at=now() WHERE attempt_id=$1 AND stage=$2",[attempt.id,payload.stage||kind.slice(9).toUpperCase(),Date.now()-started,result?.provider||null,result?.model||null]);return result}catch(error){throw error}}}
    return handlers;
  };
  if(!worker.__forgeVideoProductionWorkflowHook){
    const { EpisodeWorkflowIntegration }=require('../pipeline/episode-workflow-integration');
    const success=EpisodeWorkflowIntegration.prototype.handleJobSuccess;
    EpisodeWorkflowIntegration.prototype.handleJobSuccess=async function(job,result){const value=await success.call(this,job,result);const workflowId=job?.payload?.workflowId;if(workflowId){const row=(await this.pool.query('SELECT recipe_id FROM video_production_attempts WHERE workflow_id=$1 ORDER BY attempt_no DESC LIMIT 1',[workflowId])).rows[0];if(row)await new VideoProductionService({pool:this.pool}).reconcile(row.recipe_id).catch(()=>{})}return value};
    const failure=EpisodeWorkflowIntegration.prototype.handleJobFailure;
    EpisodeWorkflowIntegration.prototype.handleJobFailure=async function(job,error,terminal){const value=await failure.call(this,job,error,terminal);if(terminal&&job?.payload?.workflowId){const row=(await this.pool.query('SELECT recipe_id FROM video_production_attempts WHERE workflow_id=$1 ORDER BY attempt_no DESC LIMIT 1',[job.payload.workflowId])).rows[0];if(row)await new VideoProductionService({pool:this.pool}).reconcile(row.recipe_id).catch(()=>{})}return value};
    worker.__forgeVideoProductionWorkflowHook=true;
  }
  worker.__forgeVideoProductionHook=true;
}
install();
module.exports={install};
