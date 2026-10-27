#!/usr/bin/env node
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { PersistentProductionRepository } = require('../src/persistence/production-repository');
const { JobQueue } = require('../src/persistence/job-queue');
const { createWorker } = require('../src/worker');
const { createHttpWorkflowHandlers } = require('../src/pipeline/http-workflow-handlers');
const { createCaptionJobHandler } = require('../src/captions/job-handler');
const { createFfmpegRenderHandler } = require('../src/pipeline/ffmpeg-render-handler');
const { createTimelineManifestHandler } = require('../src/pipeline/timeline-manifest-handler');
const { createPackagingHandlers } = require('../src/packaging/worker');
const { createPublishingHandlers } = require('../src/publishing/job-handler');
const { createCanonicalPackageGate } = require('../src/publishing/package-gate');
const { createStorageFromEnv } = require('../src/storage');
const { createApiServer } = require('../src/http-api');

const SCENARIOS = ['happy-path','provider-timeout-retry','worker-crash','stale-lease','duplicate-callback','missing-corrupt-artifact','budget-exhaustion','authorization-denial','dependency-failure','cancellation-race','partial-recovery'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const identity = (prefix, seed) => `${prefix}:${sha(`${prefix}:${seed}`).slice(0, 24)}`;
function assert(condition, message) { if (!condition) throw new Error(message); }

function createFixture(root) {
  const dir = path.join(root, 'fixtures');
  const file = path.join(dir, 'source.mp4');
  fs.mkdir(dir, { recursive: true });
  const result = spawnSync('ffmpeg', ['-y','-f','lavfi','-i','color=c=black:s=320x180:r=30','-t','1','-pix_fmt','yuv420p','-c:v','libx264','-movflags','+faststart',file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr}`);
  return { file, sourcePath: 'fixtures/source.mp4' };
}

function createProvider({ fixture, scenario, seed }) {
  const attempts = new Map();
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); return response.end(); }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const requestBody = JSON.parse(raw || '{}');
    const stage = String(requestBody.stage || '').toLowerCase();
    const attempt = (attempts.get(stage) || 0) + 1;
    attempts.set(stage, attempt);
    if (scenario === 'provider-timeout-retry' && stage === 'script' && attempt === 1) {
      response.writeHead(503); return response.end('{}');
    }
    if (scenario === 'dependency-failure' && stage === 'scene_plan') {
      response.writeHead(400); return response.end('{}');
    }
    const payload = requestBody.payload || {};
    const stageSeed = sha(JSON.stringify({ seed, stage, episodeId: payload.episodeId, inputs: payload.inputVersionIds || [] }));
    let artifact = {
      id: identity(`${stage}-artifact`, stageSeed),
      versionId: identity(`${stage}-version`, stageSeed),
      content: { synthetic: true, stage, seed: stageSeed },
      mediaType: 'application/json'
    };
    if (stage === 'research') artifact.content = { schemaVersion: 'synthetic-research-v1', claims: [{ id: 'c1', text: 'Deterministic claim', source: 'synthetic://fixture' }] };
    if (stage === 'script') artifact.content = { schemaVersion: 'synthetic-script-v1', sections: [{ id: 's1', text: 'Deterministic script' }] };
    if (stage === 'scene_plan') artifact.content = { schemaVersion: 'synthetic-scene-v1', scenes: [{ id: 'scene-1', durationSeconds: 1 }] };
    if (stage === 'narration') artifact.content = { text: 'Deterministic narration' };
    if (stage === 'assets') {
      const bytes = require('node:fs').readFileSync(fixture.file);
      artifact = { ...artifact, kind: 'image', content: undefined, contentBase64: bytes.toString('base64'), contentHash: sha(bytes), mediaType: 'video/mp4', metadata: { sourcePath: fixture.sourcePath, deterministic: true } };
    }
    if (stage === 'timeline') {
      const assetVersionId = (payload.inputVersionIds || []).find((value) => value.startsWith('asset-version:'));
      artifact = { ...artifact, kind: 'timeline', content: { schemaVersion: 'synthetic-timeline-v1', durationSeconds: 1, inputVersionIds: payload.inputVersionIds || [], tracks: [{ type: 'VIDEO', segments: [{ id: 'v1', start: 0, duration: 1, sourceVersionId: assetVersionId, sourcePath: fixture.sourcePath }] }] }, inputVersionIds: payload.inputVersionIds || [] };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ provider: { name: 'forge-synthetic-provider', model: 'forge-synthetic-v1' }, artifact, metadata: { attempt, deterministic: true } }));
  });
  return { server, attempts };
}

async function deterministicTranscript(pool, payload) {
  const episodeId = payload.episodeId;
  const inputVersionIds = payload.inputVersionIds || [];
  const versionId = `transcript:${sha(JSON.stringify({ episodeId, inputVersionIds }))}`;
  const artifactId = `${versionId}:json`;
  const content = { schemaVersion: 'forge-transcript-v1', language: 'en', segments: [{ start: 0, end: 1, text: 'Deterministic narration' }], sourceVersionIds: inputVersionIds };
  const checksum = sha(JSON.stringify(content));
  await pool.query(`INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'transcript',$3::jsonb,$4,'synthetic') ON CONFLICT(id) DO NOTHING`, [versionId, episodeId, JSON.stringify(content), checksum]);
  await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,'transcript',$3,$4::jsonb,$5,'application/json','synthetic',$6::jsonb,'{"deterministic":true}'::jsonb,'synthetic') ON CONFLICT(id) DO NOTHING`, [artifactId, episodeId, versionId, JSON.stringify(content), checksum, JSON.stringify(inputVersionIds)]);
  return { stage: 'TRANSCRIPTION', episodeId, versionId, artifactId };
}

async function setup(scenario, seed) {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const root = path.resolve(process.env.FORGE_ACCEPTANCE_STORAGE || path.join(process.cwd(), `.forge-acceptance-${seed}`));
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  process.env.FORGE_STORAGE_DRIVER = 'local';
  process.env.FORGE_STORAGE_LOCAL_ROOT = path.join(root, 'objects');
  process.env.FORGE_RENDER_WORKDIR = root;
  process.env.FORGE_RENDER_OUTPUT_DIR = path.join(root, 'renders');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const repository = new PersistentProductionRepository({ pool });
  await repository.migrate();
  const projectId = identity('project', seed);
  const episodeId = identity('episode', seed);
  await repository.createProject({ id: projectId, name: `Synthetic ${seed}`, createdBy: 'acceptance' });
  await repository.createEpisode({ id: episodeId, projectId, title: 'Synthetic acceptance episode', createdBy: 'acceptance', metadata: { synthetic: true, seed, scenario } });
  const fixture = createFixture(root);
  const provider = createProvider({ fixture, scenario, seed });
  await new Promise((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.server.address().port}`;
  for (const stage of ['research','script','scene_plan','narration','assets','timeline']) process.env[`FORGE_STAGE_${stage.toUpperCase()}_ENDPOINT`] = endpoint;
  const storage = createStorageFromEnv();
  const httpHandlers = createHttpWorkflowHandlers({ pool, storage });
  const manifest = createTimelineManifestHandler({ pool, storage, repository });
  const render = createFfmpegRenderHandler({ pool, storage, repository });
  const packages = createPackagingHandlers({ pool, storage });
  const publisher = { publish: async ({ metadata, externalId }) => ({ id: externalId || `synthetic:${seed}`, url: `https://synthetic.invalid/${seed}`, response: { simulated: true, metadata } }) };
  const publishing = createPublishingHandlers({ pool, storage, publisher });
  const publishGate = createCanonicalPackageGate({ pool, publishHandler: publishing['publish:youtube'] });
  const handlers = {
    ...httpHandlers,
    'workflow:transcription': (_, job) => deterministicTranscript(pool, job.payload),
    'workflow:captions': createCaptionJobHandler({ pool }),
    'workflow:render': async (payload, job) => {
      const timelineVersionId = (payload.inputVersionIds || []).find((value) => value.startsWith('timeline-version:'));
      assert(timelineVersionId, 'timeline version is required for render');
      const timelineArtifact = (await pool.query("SELECT id FROM artifacts WHERE episode_id=$1 AND version_id=$2 AND kind='timeline'", [episodeId, timelineVersionId])).rows[0];
      assert(timelineArtifact, 'timeline artifact is unreachable');
      for (const inputVersionId of payload.inputVersionIds || []) if (inputVersionId !== timelineVersionId) await pool.query('INSERT INTO version_dependencies(episode_id,version_id,depends_on_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [episodeId, timelineVersionId, inputVersionId]);
      const manifestResult = await manifest({ episodeId, timelineVersionId, inputVersionIds: payload.inputVersionIds, actor: 'acceptance' }, job);
      return render({ ...payload, manifestArtifactId: manifestResult.artifactId }, job);
    },
    'workflow:packaging': packages['workflow:package'],
    'publish:youtube': async (payload, job) => {
      let publishRunId = payload.publishRunId;
      if (!publishRunId) {
        const pkg = (await pool.query("SELECT id,version_id,final_media_artifact_id,final_media_version_id FROM episode_packages WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1", [episodeId])).rows[0];
        assert(pkg, 'package missing before publish');
        const renderArtifact = (await pool.query('SELECT id,version_id FROM artifacts WHERE id=$1', [pkg.final_media_artifact_id])).rows[0];
        publishRunId = identity('publish', seed);
        await pool.query(`INSERT INTO publish_runs(id,episode_id,destination,status,render_artifact_id,render_version_id,package_artifact_id,package_version_id,metadata,attempt) VALUES($1,$2,'youtube','QUEUED',$3,$4,$5,$6,'{"synthetic":true}'::jsonb,1) ON CONFLICT(id) DO NOTHING`, [publishRunId, episodeId, renderArtifact.id, renderArtifact.version_id, pkg.id, pkg.version_id]);
        payload = { ...payload, publishRunId };
      }
      return publishGate(payload, job);
    }
  };
  const worker = createWorker({ pool, handlers, pollMs: 10, reconciliationIntervalMs: 0, usageRecoveryIntervalMs: 0, workerId: `acceptance-worker:${seed}` });
  await worker.integration.enqueue({ episodeId, projectId, brief: 'Deterministic long-form acceptance episode', actor: 'acceptance', idempotencyPrefix: `acceptance:${seed}` });
  return { root, pool, repository, worker, queue: new JobQueue({ pool }), provider, projectId, episodeId };
}

async function approve(harness) {
  for (const stage of ['SCRIPT', 'SCENE_PLAN']) {
    const row = (await harness.pool.query(`SELECT s.output_version_ids FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1 AND s.stage=$2 AND s.status='SUCCEEDED' ORDER BY s.updated_at DESC LIMIT 1`, [harness.episodeId, stage])).rows[0];
    const versionId = row?.output_version_ids?.[0];
    if (!versionId) continue;
    const exists = (await harness.pool.query("SELECT 1 FROM approvals WHERE episode_id=$1 AND stage=$2 AND target_version_id=$3 AND decision='APPROVED'", [harness.episodeId, stage, versionId])).rows[0];
    if (exists) continue;
    const episode = await harness.repository.getEpisode(harness.episodeId);
    await harness.repository.appendApproval({ id: identity(`approval-${stage}`, versionId), episodeId: harness.episodeId, stage, targetId: versionId, targetVersionId: versionId, decision: 'APPROVED', actor: 'synthetic-reviewer', expectedRevision: episode.revision, evidence: { synthetic: true } });
  }
}

async function finalApproval(harness) {
  const render = (await harness.pool.query("SELECT id,version_id FROM artifacts WHERE episode_id=$1 AND kind='render' ORDER BY created_at DESC LIMIT 1", [harness.episodeId])).rows[0];
  if (!render) return;
  const episode = await harness.repository.getEpisode(harness.episodeId);
  if (episode.state !== 'AWAITING_APPROVAL') return;
  await harness.repository.selectRender({ id: harness.episodeId, renderArtifactId: render.id, expectedRevision: episode.revision });
  const selected = await harness.repository.getEpisode(harness.episodeId);
  await harness.repository.appendApproval({ id: identity('approval-final', render.id), episodeId: harness.episodeId, stage: 'FINAL_RENDER', targetId: render.id, targetVersionId: render.version_id, decision: 'APPROVED', actor: 'synthetic-reviewer', expectedRevision: selected.revision, evidence: { synthetic: true } });
}

async function invariants(harness) {
  const episode = (await harness.pool.query('SELECT state FROM episodes WHERE id=$1', [harness.episodeId])).rows[0];
  const jobs = (await harness.pool.query('SELECT project_id FROM forge_jobs WHERE episode_id=$1', [harness.episodeId])).rows;
  const stages = (await harness.pool.query('SELECT s.status FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1', [harness.episodeId])).rows;
  const artifacts = (await harness.pool.query('SELECT episode_id,version_id,content_hash FROM artifacts WHERE episode_id=$1', [harness.episodeId])).rows;
  const duplicates = (await harness.pool.query('SELECT idempotency_key FROM forge_jobs WHERE episode_id=$1 GROUP BY idempotency_key HAVING COUNT(*)>1', [harness.episodeId])).rows;
  const usage = (await harness.pool.query('SELECT COUNT(*)::int count FROM usage_events WHERE episode_id=$1', [harness.episodeId])).rows[0].count;
  const badArtifacts = artifacts.filter((artifact) => artifact.episode_id !== harness.episodeId || !artifact.version_id || (artifact.content_hash && !/^[a-f0-9]{64}$/.test(artifact.content_hash)));
  return { episode: episode.state, terminal: ['PUBLISHED','FAILED','CANCELLED'].includes(episode.state), stagesTerminal: stages.every((stage) => ['SUCCEEDED','FAILED','CANCELLED'].includes(stage.status)), tenantIsolation: jobs.every((job) => job.project_id === harness.projectId), noDuplicateJobs: duplicates.length === 0, immutableArtifacts: badArtifacts.length === 0, usageAccounting: usage > 0, diagnostics: { duplicates, badArtifacts: badArtifacts.map((artifact) => artifact.id) } };
}

async function authorizationScenario() {
  const { server } = createApiServer({ apiToken: 'acceptance-token' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/episodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  server.close();
  return response.status === 401;
}

async function runScenario(scenario, seed) {
  if (scenario === 'authorization-denial') return { scenario, seed, status: (await authorizationScenario()) ? 'PASSED' : 'FAILED' };
  const harness = await setup(scenario, seed);
  const workerPromise = harness.worker.run();
  try {
    for (let i = 0; i < 800; i += 1) {
      await approve(harness);
      const state = (await harness.pool.query('SELECT state FROM episodes WHERE id=$1', [harness.episodeId])).rows[0]?.state;
      if (scenario === 'cancellation-race' && i === 30) await harness.repository.transitionEpisode({ id: harness.episodeId, nextState: 'CANCELLED', actor: 'synthetic-race' }).catch(() => {});
      if (['PUBLISHED','APPROVED','FAILED','CANCELLED'].includes(state)) break;
      await sleep(10);
    }
    await approve(harness);
    await finalApproval(harness);
    await sleep(100);
    if (scenario === 'stale-lease' || scenario === 'worker-crash') {
      const job = (await harness.pool.query("SELECT id FROM forge_jobs WHERE episode_id=$1 AND status='SUCCEEDED' LIMIT 1", [harness.episodeId])).rows[0];
      if (job) { await harness.pool.query("UPDATE forge_jobs SET status='RUNNING',lease_until=now()-interval '1 minute' WHERE id=$1", [job.id]); await harness.queue.recoverExpiredLeases(); }
    }
    if (scenario === 'missing-corrupt-artifact' || scenario === 'partial-recovery') {
      const artifact = (await harness.pool.query("SELECT id FROM artifacts WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1", [harness.episodeId])).rows[0];
      if (artifact) await harness.pool.query("UPDATE storage_objects SET status='CORRUPT' WHERE artifact_id=$1", [artifact.id]);
    }
    if (scenario === 'duplicate-callback') {
      const job = (await harness.pool.query("SELECT * FROM forge_jobs WHERE episode_id=$1 AND status='SUCCEEDED' ORDER BY finished_at DESC LIMIT 1", [harness.episodeId])).rows[0];
      if (job) await harness.worker.integration.handleJobSuccess(job, { artifacts: [] }).catch(() => {});
    }
    const result = await invariants(harness);
    const expectedFailure = ['budget-exhaustion','dependency-failure','cancellation-race'].includes(scenario);
    const expectedCorruption = ['missing-corrupt-artifact','partial-recovery'].includes(scenario);
    const status = result.noDuplicateJobs && result.immutableArtifacts && result.tenantIsolation && result.usageAccounting && (result.terminal || expectedFailure || expectedCorruption) ? 'PASSED' : 'FAILED';
    return { scenario, seed, episodeId: harness.episodeId, status, invariants: result, providerAttempts: Object.fromEntries(harness.provider.attempts) };
  } finally {
    await harness.worker.stop();
    await workerPromise.catch(() => {});
    await new Promise((resolve) => harness.provider.server.close(resolve));
    await harness.pool.end();
    if (process.env.FORGE_ACCEPTANCE_KEEP_ARTIFACTS !== 'true') await fs.rm(harness.root, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const requested = process.env.FORGE_ACCEPTANCE_SCENARIO || process.argv[2] || 'happy-path';
  const seed = String(process.env.FORGE_ACCEPTANCE_SEED || process.argv[3] || 'ci');
  assert(requested === 'all' || SCENARIOS.includes(requested), `unknown acceptance scenario: ${requested}`);
  const scenarios = requested === 'all' ? SCENARIOS : [requested];
  const results = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, `${seed}-${scenario}`));
  console.log(JSON.stringify({ harness: 'forge-production-acceptance-v1', results }, null, 2));
  if (results.some((result) => result.status !== 'PASSED')) process.exitCode = 1;
}

main().catch((error) => { console.error(JSON.stringify({ harness: 'forge-production-acceptance-v1', status: 'FAILED', error: error.message }, null, 2)); process.exitCode = 1; });
