'use strict';
const { handleGenerationReplay } = require('./replay-handler');
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
