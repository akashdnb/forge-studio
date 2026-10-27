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
    for(const kind of TARGETS){if(typeof handlers[kind]!=='function')continue;const originalHandler=handlers[kind];handlers[kind]=async(payload={},job={})=>{const workflowId=job.workflow_id||payload.workflowId||null;if(!workflowId)return originalHandler(payload,job);const attempt=(await options.pool.query('SELECT a.*,r.id recipe_id FROM video_production_attempts a JOIN video_production_recipes r ON r.id=a.recipe_id WHERE a.workflow_id=$1 ORDER BY a.attempt_no DESC LIMIT 1',[workflowId])).rows[0];if(!attempt)return originalHandler(payload,job);const started=Date.now();try{const result=await originalHandler(payload,job);await service.reconcile(attempt.recipe_id);await options.pool.query("UPDATE video_production_stage_runs SET duration_ms=COALESCE(duration_ms,$3),provider=COALESCE(provider,$4),model=COALESCE(model,$5),updated_at=now() WHERE attempt_id=$1 AND stage=$2",[attempt.id,payload.stage||kind.slice(9).toUpperCase(),Date.now()-started,result?.provider||null,result?.model||null]);return result}catch(error){await service.reconcile(attempt.recipe_id).catch(()=>{});throw error}}}
    return handlers;
  };
  worker.__forgeVideoProductionHook=true;
}
install();
module.exports={install};
