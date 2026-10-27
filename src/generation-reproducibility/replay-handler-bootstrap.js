'use strict';
const { handleGenerationReplay } = require('./replay-handler');
const { GenerationRecipeService } = require('./service');
const { PersistentProductionRepository } = require('../persistence/production-repository');
const worker = require('../worker');
if (!worker.__generationRecipeReplayHook) {
  const original = worker.loadHandlers;
  worker.loadHandlers = function loadHandlersWithGenerationReplay(options = {}) {
    const handlers = original(options);
    if (options.pool) handlers['workflow:generation-replay'] = (payload, job) => handleGenerationReplay({ ...options, payload, job });
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
