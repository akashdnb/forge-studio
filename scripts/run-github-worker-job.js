const { Pool } = require('pg');
const { createCaptionJobHandler } = require('../src/captions/job-handler');
const { createTranscriptionHandlers } = require('../src/transcription/whisper-worker');
const { createFfmpegRenderHandler } = require('../src/pipeline/ffmpeg-render-handler');
const { executeMediaQa } = require('../src/pipeline/media-qa-handler');
const { PersistentProductionRepository } = require('../src/persistence/production-repository');
const { createStorageFromEnv } = require('../src/storage');
const HANDLER_KIND = Object.freeze({ transcription: 'workflow:transcription', render: 'workflow:render', captions: 'workflow:captions', qa: 'workflow:qa' });
async function notifyCallback({ jobId, workerType, correlationId, status, metadata = {}, logger = console }) {
  const url = process.env.FORGE_RUNNER_CALLBACK_URL; const token = process.env.FORGE_RUNNER_CALLBACK_TOKEN; if (!url || !token) return;
  try { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-runner-token': token }, body: JSON.stringify({ jobId, workerType, correlationId, status, githubRunId: process.env.GITHUB_RUN_ID || null, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null, metadata }) }); if (!response.ok) logger.warn?.(`Forge runner callback returned HTTP ${response.status}`); } catch (error) { logger.warn?.(`Forge runner callback unavailable: ${error.message}`); }
}
async function main() {
  const jobId = process.argv[2]; const workerType = process.argv[3]; if (!jobId || !workerType || !HANDLER_KIND[workerType]) throw new Error('usage: node scripts/run-github-worker-job.js <job-id> <transcription|render|captions|qa>'); if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }); const repository = new PersistentProductionRepository({ pool });
  try {
    const job = (await pool.query('SELECT * FROM forge_jobs WHERE id=$1', [jobId])).rows[0]; if (!job) throw new Error(`Durable job ${jobId} was not found`); if (job.status === 'SUCCEEDED' || job.status === 'CANCELLED') return process.stdout.write(JSON.stringify({ status: job.status, jobId, idempotent: true }) + '\n'); if (job.status !== 'RUNNING') throw new Error(`Durable job ${jobId} is not running (status=${job.status})`); if (job.kind !== HANDLER_KIND[workerType]) throw new Error(`Worker ${workerType} cannot execute ${job.kind}`);
    const execution = (await pool.query('SELECT * FROM forge_execution_runs WHERE job_id=$1 AND attempt=$2', [job.id, job.attempts])).rows[0]; if (!execution) throw new Error(`No execution metadata exists for ${jobId} attempt ${job.attempts}`);
    await notifyCallback({ jobId, workerType, correlationId: execution.correlation_id, status: 'started' });
    let result; if (workerType === 'transcription') result = await createTranscriptionHandlers({ pool })[HANDLER_KIND[workerType]](job.payload, job); else if (workerType === 'captions') result = await createCaptionJobHandler({ pool })(job.payload, job); else if (workerType === 'render') result = await createFfmpegRenderHandler({ pool, storage: createStorageFromEnv() })(job.payload, job); else result = await executeMediaQa({ payload: job.payload, job, repository });
    await notifyCallback({ jobId, workerType, correlationId: execution.correlation_id, status: 'completed', metadata: { result: result || {} } }); process.stdout.write(JSON.stringify({ status: 'SUCCEEDED', jobId, workerType, result: result || {} }) + '\n');
  } catch (error) {
    const execution = (await pool.query('SELECT correlation_id FROM forge_execution_runs WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1', [jobId])).rows[0]; if (execution) await notifyCallback({ jobId, workerType, correlationId: execution.correlation_id, status: 'failed', metadata: { retryable: error?.retryable !== false, code: error?.code || 'WORKER_FAILED' } }); throw error;
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(`Forge GitHub worker failed: ${error.message}`); process.exitCode = 1; });
module.exports = { HANDLER_KIND, notifyCallback };
