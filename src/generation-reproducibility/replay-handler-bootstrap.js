'use strict';
const { handleGenerationReplay } = require('./replay-handler');
const { GenerationRecipeService } = require('./service');
const { PersistentProductionRepository } = require('../persistence/production-repository');
const worker = require('../worker');
async function projectScope(pool,episodeId){return (await pool.query('SELECT e.project_id,p.tenant_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1',[episodeId])).rows[0]||null;}
function wrapDirectGenerationHandler(handler,capability,options){const pool=options.pool;if(!pool)return handler;return async(payload={},job={})=>{const episodeId=payload.episodeId||job.episode_id;const scope=await projectScope(pool,episodeId);if(!scope)return handler(payload,job);const service=new GenerationRecipeService({pool});let prompt='',inputDigests=[],model={},provider={};if(capability==='tts'){const {loadApprovedScript,extractScriptText,createProviderRegistry}=require('../narration/tts-worker');const loaded=await loadApprovedScript(pool,{episodeId,scriptVersionId:payload.scriptVersionId||payload.inputVersionId});prompt=extractScriptText(loaded.script.payload);inputDigests=[loaded.script.content_hash];const registry=createProviderRegistry();const p=registry.get('tts');model={id:p?.model||process.env.FORGE_TTS_MODEL||null,voice:payload.voice||process.env.FORGE_TTS_VOICE||null};provider={name:p?.name||'configured-tts-command'};}else if(capability==='transcription'){const narration=(await pool.query(`SELECT a.* FROM artifacts a WHERE a.episode_id=$1 AND a.kind='narration' ORDER BY a.created_at DESC LIMIT 1`,[episodeId])).rows[0];if(narration){inputDigests=[narration.content_hash].filter(Boolean);provider={name:process.env.FORGE_WHISPER_COMMAND||'whisper-command'};model={id:process.env.FORGE_WHISPER_MODEL||null};}}
const recipe=await service.createSnapshot({tenantId:scope.tenant_id,projectId:scope.project_id,episodeId,recipeKey:`${episodeId}:${capability}`,capability,operation:capability.toUpperCase(),prompt,structuredInputs:{...payload,inputVersionIds:payload.inputVersionIds||payload.scriptVersionId?[payload.inputVersionIds||payload.scriptVersionId].flat():[]},model,provider,providerContract:{version:capability==='tts'?(process.env.FORGE_TTS_CONTRACT_VERSION||'forge-tts-v1'):(process.env.FORGE_TRANSCRIPTION_CONTRACT_VERSION||'forge-transcription-v1')},deterministicParameters:{seed:payload.seed??null},inputArtifactDigests:inputDigests,actor:job.created_by||job.actor||'worker'});
const attempt=await service.createAttempt({recipeId:recipe.id,tenantId:scope.tenant_id,projectId:scope.project_id,idempotencyKey:`${capability}:${job.id||episodeId}:${recipe.recipeHash}`,jobId:job.id||null,actor:job.created_by||job.actor||'worker',observed:{provider:recipe.snapshot.provider,model:recipe.snapshot.model,recipeHash:recipe.recipeHash}});
try{const result=await handler(payload,job);await service.finishAttempt({attemptId:attempt.id,status:'SUCCEEDED',outputArtifactIds:[result?.artifactId].filter(Boolean)});return result;}catch(error){await service.finishAttempt({attemptId:attempt.id,status:error?.code==='CANCELLED'?'CANCELLED':'FAILED',error});throw error;}};}
if (!worker.__generationRecipeReplayHook) {
  const original = worker.loadHandlers;
  worker.loadHandlers = function loadHandlersWithGenerationReplay(options = {}) {
    const handlers = original(options);
    if (options.pool) {
      handlers['workflow:generation-replay'] = (payload, job) => handleGenerationReplay({ ...options, payload, job });
      if(handlers['workflow:narration']) handlers['workflow:narration']=wrapDirectGenerationHandler(handlers['workflow:narration'],'tts',options);
      if(handlers['workflow:transcription']) handlers['workflow:transcription']=wrapDirectGenerationHandler(handlers['workflow:transcription'],'transcription',options);
    }
    return handlers;
  };
  worker.__generationRecipeReplayHook = true;
}
if (!PersistentProductionRepository.prototype.__generationRecipeTransitionHook) {
  const originalTransition = PersistentProductionRepository.prototype.transitionProviderRun;
  PersistentProductionRepository.prototype.transitionProviderRun = async function transitionProviderRunWithRecipeAttempt(args) {
    const result = await originalTransition.call(this, args);
    if (result?.generation_recipe_id && ['SUCCEEDED','FAILED','CANCELLED'].includes(result.status)) {
      const service = new GenerationRecipeService({ pool: this.db.pool });
      await service.finishAttempt({ attemptId: `provider-run:${result.id}`, status: result.status, outputArtifactIds: result.result_artifact_ids || [], error: result.error ? { code: result.error.code || 'PROVIDER_FAILED', message: result.error.message || 'provider run failed' } : null, drift: result.error?.code === 'RECIPE_DRIFT' }).catch(() => {});
    }
    return result;
  };
  PersistentProductionRepository.prototype.__generationRecipeTransitionHook = true;
}
require('../video-production/worker-hook');
