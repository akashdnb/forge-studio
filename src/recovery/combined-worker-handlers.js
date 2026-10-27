const path = require('node:path');
const { createReplayHandler } = require('./replay-worker');
function loadGenerationHandlers() {
  const loaded = require(path.resolve(process.env.FORGE_GENERATION_HANDLER_MODULE || 'src/generation/worker-handlers.js'));
  return loaded.handlers || loaded;
}
function createHandlers({ pool } = {}) { return { ...loadGenerationHandlers(), 'replay:stage': createReplayHandler({ pool }) }; }
module.exports = { createHandlers };
