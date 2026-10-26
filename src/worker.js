const { randomUUID } = require('node:crypto');
const { DurableJobQueue } = require('./persistence/durable-job-queue');
const { DurableWorker } = require('./pipeline/durable-worker');
const { ProviderRunLedger } = require('./domain/provider-run-ledger');
const { ArtifactRegistry } = require('./domain/artifact-registry');
const { MockTextProvider, MockMediaProvider } = require('./pipeline/mock-providers');
const { PiperTtsProvider } = require('./providers/piper-tts-provider');
const { FfmpegRenderer } = require('./providers/ffmpeg-renderer');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the durable worker');
  let Pool;
  try { ({ Pool } = require('pg')); } catch { throw new Error('The pg package is required. Run npm install first.'); }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  const workerId = process.env.WORKER_ID || `forge-worker-${randomUUID()}`;
  const queue = new DurableJobQueue({
    pool, workerId,
    leaseSeconds: Number.parseInt(process.env.WORKER_LEASE_SECONDS || '90', 10),
  });
  const ledger = new ProviderRunLedger();
  const artifacts = new ArtifactRegistry();
  const registry = new Map();
  const allowMock = process.env.FORGE_ALLOW_MOCK_PROVIDERS === 'true';
  const register = (key, provider) => registry.set(key, provider);

  if (allowMock) {
    const text = new MockTextProvider();
    const media = new MockMediaProvider();
    for (const capability of ['research','llm','scene-plan','qa']) register(capability, text);
    for (const capability of ['image','timeline','render']) register(capability, media);
    register('publish', {
      name: 'mock-publish-dry-run',
      async execute(request, context) {
        return { artifacts: [{ id: `${context.runId}-publish-record`, versionId: `${context.runId}-v1`, kind: 'publish-record',
          content: { dryRun: true, publicationPerformed: false, request } }],
          usage: { actualPublications: 0 }, estimatedCost: 0, actualCost: 0, currency: 'USD' };
      },
    });
  }
  if (process.env.PIPER_MODEL_PATH && process.env.MEDIA_OUTPUT_ROOT) {
    register('tts', new PiperTtsProvider({ modelPath: process.env.PIPER_MODEL_PATH, outputRoot: process.env.MEDIA_OUTPUT_ROOT }));
  }
  if (process.env.MEDIA_OUTPUT_ROOT && process.env.FFMPEG_RENDER_COMMAND_ENABLED === 'true') {
    const renderer = new FfmpegRenderer({ outputRoot: process.env.MEDIA_OUTPUT_ROOT });
    register('render', {
      name: 'ffmpeg-renderer',
      async execute(request, context) {
        if (!request.inputPath || !request.outputPath) throw Object.assign(new Error('FFmpeg render requires trusted inputPath and outputPath'), { retryable: false });
        const output = await renderer.render({
          inputPath: request.inputPath, outputPath: request.outputPath, args: Array.isArray(request.args) ? request.args : [],
        });
        return { artifacts: [{
          id: request.artifactId || `${context.runId}-render`, versionId: request.versionId || `${context.runId}-v1`,
          kind: 'render', storageUri: output.path, mediaType: 'video/mp4', source: 'ffmpeg',
          inputVersionIds: context.inputVersionIds,
          metadata: { durationSeconds: output.durationSeconds, sizeBytes: output.sizeBytes, formatName: output.formatName, streams: output.streams },
        }], usage: { outputBytes: output.sizeBytes || 0 }, estimatedCost: 0, actualCost: 0, currency: 'USD' };
      },
    });
  }

  const executeJob = async (job) => {
    const provider = registry.get(job.capability);
    if (!provider) throw Object.assign(new Error(`No provider configured for capability '${job.capability}'. Configure a real adapter or explicitly enable mock mode.`), { retryable: false });
    const runId = `job-run-${job.id}-${job.attempts}`;
    const run = ledger.start({
      id: runId, episodeId: job.episode_id, capability: job.capability, provider: provider.name || 'unnamed',
      model: provider.model || null, inputVersionIds: job.input_version_ids || [],
      idempotencyKey: `workflow-job:${job.id}:attempt:${job.attempts}`, request: job.request || {}, attempt: job.attempts || 1,
    });
    ledger.transition(run.id, 'RUNNING');
    try {
      const output = await provider.execute(job.request || {}, {
        runId: run.id, episodeId: job.episode_id, stage: job.stage, attempt: job.attempts || 1,
        inputVersionIds: job.input_version_ids || [],
      });
      if (!output || !Array.isArray(output.artifacts)) throw new Error('Provider must return an artifacts array');
      const created = output.artifacts.map((artifact, index) => artifacts.register({
        ...artifact, id: artifact.id || `${run.id}-artifact-${index + 1}`, episodeId: job.episode_id,
        versionId: artifact.versionId || `${run.id}-v1`, kind: artifact.kind || job.stage.toLowerCase().replaceAll('_', '-'),
        providerRunId: run.id, inputVersionIds: job.input_version_ids || [], source: artifact.source || provider.name || 'provider',
      }));
      const finishedRun = ledger.transition(run.id, 'SUCCEEDED', {
        resultArtifactIds: created.map((artifact) => artifact.id), usage: output.usage || {},
        estimatedCost: output.estimatedCost ?? null, actualCost: output.actualCost ?? null, currency: output.currency || 'USD',
      });
      return { providerRunId: finishedRun.id, resultArtifactIds: created.map((artifact) => artifact.id), usage: output.usage || {} };
    } catch (error) {
      if (!['FAILED','CANCELLED','SUCCEEDED'].includes(ledger.get(run.id).status)) {
        ledger.transition(run.id, 'FAILED', { error: { message: error.message || 'Provider failed' } });
      }
      throw error;
    }
  };

  const worker = new DurableWorker({
    queue, executeJob, pollIntervalMs: Number.parseInt(process.env.WORKER_POLL_INTERVAL_MS || '1000', 10),
    workerId, onEvent: (event) => process.stdout.write(`[worker] ${JSON.stringify(event)}\n`),
  });
  const controller = new AbortController();
  const shutdown = (signal) => { console.log(`Received ${signal}; stopping worker after current job`); controller.abort(); worker.stop(); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  try {
    await pool.query('SELECT 1');
    console.log(`Forge durable worker started; mockMode=${allowMock}`);
    await worker.run({ signal: controller.signal });
  } finally { await pool.end(); }
}

main().catch((error) => {
  console.error('Forge worker startup failed:', error.message);
  process.exitCode = 1;
});
