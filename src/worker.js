const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { JobQueue } = require('./persistence/job-queue');
const { createPublishingHandlers } = require('./publishing/job-handler');
const { createHttpWorkflowHandlers } = require('./pipeline/http-workflow-handlers');
const { createCaptionJobHandler } = require('./captions/job-handler');
const { createTranscriptionHandlers } = require('./transcription/whisper-worker');
const { createNarrationHandlers, createProviderRegistry } = require('./narration/tts-worker');
const { createStorageFromEnv } = require('./storage');
const { createFfmpegRenderHandler } = require('./pipeline/ffmpeg-render-handler');
const { createMediaLifecycleReconciliationHandler, MediaLifecycleReconciler } = require('./reconciliation/media-lifecycle-reconciler');

function createWorker({ pool, handlers = {}, workerId = `forge-worker:${randomUUID()}`, pollMs = 1000, reconciliationIntervalMs = Number.parseInt(process.env.FORGE_RECONCILIATION_INTERVAL_MS || '300000', 10), logger = console, storage = null } = {}) {
  const queue = new JobQueue({ pool }); let stopping = false; let timer = null; let reconciliationTimer = null; let reconciling = false;
  async function reconcileNow(reason = 'scheduled') {
    if (reconciling || stopping) return { status: 'SKIPPED_BUSY' };
    reconciling = true;
    try {
      return await new MediaLifecycleReconciler({ pool, storage: storage || createStorageFromEnv(), workerId, scanLimit: Number.parseInt(process.env.FORGE_RECONCILIATION_SCAN_LIMIT || '50', 10), recentWindowMinutes: Number.parseInt(process.env.FORGE_RECONCILIATION_RECENT_MINUTES || '60', 10), partialMaxAgeMinutes: Number.parseInt(process.env.FORGE_RECONCILIATION_PARTIAL_MAX_AGE_MINUTES || '60', 10), logger }).run({ reason });
    } finally { reconciling = false; }
  }
  async function tick() {
    if (stopping) return;
    await queue.recoverExpiredLeases(); await queue.recoverBlockedDependencies();
    const job = await queue.claim({ workerId }); if (!job) return;
    const handler = handlers[job.kind];
    if (typeof handler !== 'function') { await queue.fail(job.id, workerId, Object.assign(new Error(`No worker handler registered for ${job.kind}`), { retryable: false }), { retry: false }); return; }
    const heartbeat = setInterval(() => queue.heartbeat(job.id, workerId).catch((e) => logger.error?.('Forge worker heartbeat failed', e)), 30000); heartbeat.unref?.();
    try { const result = await handler(job.payload, job); await queue.succeed(job.id, workerId, result || {}); }
    catch (error) { logger.error?.(`Forge job ${job.id} (${job.kind}) failed: ${error.message}`); await queue.fail(job.id, workerId, error, { retry: error?.retryable !== false }); }
    finally { clearInterval(heartbeat); }
  }
  async function run() {
    if (Number.isFinite(reconciliationIntervalMs) && reconciliationIntervalMs >= 60000) {
      reconciliationTimer = setInterval(() => reconcileNow('scheduled').catch((error) => logger.error?.('Forge media reconciliation failed', error)), reconciliationIntervalMs); reconciliationTimer.unref?.();
    }
    while (!stopping) { try { await tick(); } catch (error) { logger.error?.('Forge worker loop failed', error); } if (!stopping) await new Promise((resolve) => { timer = setTimeout(resolve, pollMs); timer.unref?.(); }); }
  }
  async function stop() { stopping = true; if (timer) clearTimeout(timer); if (reconciliationTimer) clearInterval(reconciliationTimer); }
  return { queue, run, stop, workerId, reconcileNow };
}

function loadHandlers({ pool } = {}) {
  const storage = pool ? createStorageFromEnv() : null; let providerRegistry = null; let providerConfigError = null;
  if (pool) { try { providerRegistry = createProviderRegistry(); } catch (error) { providerConfigError = error; providerRegistry = { get: () => ({ name: 'unconfigured-tts', execute: async () => { throw providerConfigError; } }) }; } }
  const handlers = pool ? {
    ...createHttpWorkflowHandlers({ pool, storage }), ...createPublishingHandlers({ pool }), 'workflow:captions': createCaptionJobHandler({ pool }),
    ...createTranscriptionHandlers({ pool }), ...createNarrationHandlers({ pool, storage, providerRegistry }), 'workflow:render': createFfmpegRenderHandler({ pool, storage }),
    'workflow:media-reconcile': createMediaLifecycleReconciliationHandler({ pool, storage }),
  } : {};
  const modulePath = process.env.FORGE_WORKER_HANDLERS;
  if (modulePath) { const loaded = require(path.resolve(modulePath)); Object.assign(handlers, loaded.handlers || loaded); }
  return handlers;
}
if (require.main === module) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) });
  const worker = createWorker({ pool, handlers: loadHandlers({ pool }) });
  const shutdown = async () => { await worker.stop(); await pool.end(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown); worker.run().catch(async (e) => { console.error('Forge worker failed:', e); await pool.end(); process.exit(1); });
}
module.exports = { createWorker, loadHandlers };
