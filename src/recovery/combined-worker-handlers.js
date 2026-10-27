const path = require('node:path');
const { createReplayHandler } = require('./replay-worker');
let replayHandler;
function loadGenerationHandlers() {
  const loaded = require(path.resolve(process.env.FORGE_GENERATION_HANDLER_MODULE || 'src/generation/worker-handlers.js'));
  return loaded.handlers || loaded;
}
function getReplayHandler() {
  if (!replayHandler) {
    const { Pool } = require('pg');
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for replay worker');
    replayHandler = createReplayHandler({ pool: new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) }) });
  }
  return replayHandler;
}
module.exports = { handlers: { ...loadGenerationHandlers(), 'replay:stage': (...args) => getReplayHandler()(...args) } };
