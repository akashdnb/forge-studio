const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { JobQueue } = require('./persistence/job-queue');
const { createPublishingHandlers } = require('./publishing/job-handler');
const { createHttpWorkflowHandlers } = require('./pipeline/http-workflow-handlers');
const { createCaptionJobHandler } = require('./captions/job-handler');
const { createFfmpegRenderHandler } = require('./pipeline/ffmpeg-render-handler');

function createWorker({ pool, handlers = {}, workerId = `forge-worker:${randomUUID()}`, pollMs = 1000, logger = console } = {}) {
  const queue = new JobQueue({ pool }); let stopping = false; let timer = null;
  async function tick() {
    if (stopping) return;
    await queue.recoverExpiredLeases(); await queue.recoverBlockedDependencies();
    const job = await queue.claim({ workerId }); if (!job) return;
    const handler = handlers[job.kind];
    if (typeof handler !== 'function') { await queue.fail(job.id, workerId, Object.assign(new Error(`No worker handler registered for ${job.kind}`), { retryable: false }), { retry: false }); return; }
    const heartbeat = setInterval(() => queue.heartbeat(job.id, workerId).catch((error) => logger.error?.('Forge worker heartbeat failed', error)), 30000); heartbeat.unref?.();
    try { const result = await handler(job.payload, job); await queue.succeed(job.id, workerId, result || {}); }
    catch (error) { logger.error?.(`Forge job ${job.id} (${job.kind}) failed: ${error.message}`); await queue.fail(job.id, workerId, error, { retry: error?.retryable !== false }); }
    finally { clearInterval(heartbeat); }
  }
  async function run() { while (!stopping) { try { await tick(); } catch (error) { logger.error?.('Forge worker loop failed', error); } if (!stopping) await new Promise((resolve) => { timer = setTimeout(resolve, pollMs); timer.unref?.(); }); } }
  async function stop() { stopping = true; if (timer) clearTimeout(timer); }
  return { queue, run, stop, workerId };
}

function loadHandlers({ pool } = {}) {
  const handlers = pool ? { ...createHttpWorkflowHandlers({ pool }), ...createPublishingHandlers({ pool }), 'workflow:captions': createCaptionJobHandler({ pool }), 'workflow:render': createFfmpegRenderHandler({ pool }) } : {};
  const modulePath = process.env.FORGE_WORKER_HANDLERS;
  if (modulePath) { const loaded = require(path.resolve(modulePath)); Object.assign(handlers, loaded.handlers || loaded); }
  return handlers;
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) });
  const worker = createWorker({ pool, handlers: loadHandlers({ pool }) });
  const shutdown = async () => { await worker.stop(); await pool.end(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  worker.run().catch(async (error) => { console.error('Forge worker failed:', error); await pool.end(); process.exit(1); });
}
module.exports = { createWorker, loadHandlers };
