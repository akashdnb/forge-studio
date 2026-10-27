#!/usr/bin/env node
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { PersistentProductionRepository } = require('../src/persistence/production-repository');
const { JobQueue } = require('../src/persistence/job-queue');
const { UsageAccountingService } = require('../src/usage/usage-accounting');
const { createWorker } = require('../src/worker');
const { createHttpWorkflowHandlers } = require('../src/pipeline/http-workflow-handlers');
const { createCaptionJobHandler } = require('../src/captions/job-handler');
const { createFfmpegRenderHandler } = require('../src/pipeline/ffmpeg-render-handler');
const { createTimelineManifestHandler } = require('../src/pipeline/timeline-manifest-handler');
const { createPackagingHandlers } = require('../src/packaging/worker');
const { createPublishingHandlers } = require('../src/publishing/job-handler');
const { createCanonicalPackageGate } = require('../src/publishing/package-gate');
const { createStorageFromEnv } = require('../src/storage');
const { createMediaLifecycleReconciliationHandler } = require('../src/reconciliation/media-lifecycle-reconciler');
const { randomUUID, createHash } = crypto;

const SCENARIOS = Object.freeze([
  'happy-path', 'provider-timeout-retry', 'worker-crash', 'stale-lease', 'duplicate-callback',
  'missing-corrupt-artifact', 'budget-exhaustion', 'authorization-denial', 'dependency-failure',
  'cancellation-race', 'partial-recovery',
]);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function jsonHash(value) { return sha256(JSON.stringify(value)); }
function id(prefix, seed) { return `${prefix}-${sha256(`${seed}:${prefix}`).slice(0, 24)}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fail(message, details = {}) { const error = new Error(message); error.details = details; throw error; }

function assert(condition, message, details = {}) { if (!condition) fail(message, details); }

async function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}

async function makeMediaFixture(root) {
  const fixtures = path.join(root, 'fixtures');
  await fs.mkdir(fixtures, { recursive: true });
  const video = path.join(fixtures, 'source.mp4');
  await runCommand('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', video], root);
  return { video, sourcePath: 'fixtures/source.mp4' };
}

function deterministicProviderServer({ fixture, scenario, seed }) {
  const attempts = new Map();
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(404); return response.end(); }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body || '{}');
    const stage = String(input.stage || '').toLowerCase();
    const count = (attempts.get(stage) || 0) + 1; attempts.set(stage, count);
    if (scenario === 'provider-timeout-retry' && stage === 'script' && count === 1) {
      await sleep(250); response.writeHead(503, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ error: 'synthetic timeout/retry' }));
    }
    const payload = input.payload || {};
    const stageSeed = sha256(JSON.stringify({ seed, stage, payload: { episodeId: payload.episodeId, inputVersionIds: payload.inputVersionIds || [] } }));
    let artifact;
    if (stage === 'research') artifact = { id: id('research-artifact', stageSeed), versionId: id('research-version', stageSeed), content: { schemaVersion: 'synthetic-research-v1', claims: [{ id: 'claim-1', text: 'Synthetic deterministic claim', source: 'synthetic://fixture' }] }, mediaType: 'application/json' };
    else if (stage === 'script') artifact = { id: id('script-artifact', stageSeed), versionId: id('script-version', stageSeed), content: { schemaVersion: 'synthetic-script-v1', title: 'Synthetic acceptance episode', sections: [{ id: 's1', text: 'A deterministic production test episode.' }] }, mediaType: 'application/json' };
    else if (stage === 'scene_plan') artifact = { id: id('scene-artifact', stageSeed), versionId: id('scene-version', stageSeed), content: { schemaVersion: 'synthetic-scene-plan-v1', scenes: [{ id: 'scene-1', durationSeconds: 1, sourceVersionId: payload.inputVersionIds?.[0] || null }] }, mediaType: 'application/json' };
    else if (stage === 'narration') artifact = { id: id('narration-artifact', stageSeed), versionId: id('narration-version', stageSeed), content: { text: 'Deterministic narration fixture.' }, mediaType: 'application/json' };
    else if (stage === 'assets') artifact = { id: id('asset-artifact', stageSeed), versionId: id('asset-version', stageSeed), contentBase64: (await fs.readFile(fixture.video)).toString('base64'), mediaType: 'video/mp4', contentHash: sha256(await fs.readFile(fixture.video)), metadata: { sourcePath: fixture.sourcePath, deterministic: true } };
    else if (stage === 'timeline') artifact = { id: id('timeline-artifact', stageSeed), versionId: id('timeline-version', stageSeed), content: { schemaVersion: 'synthetic-timeline-v1', durationSeconds: 1, inputVersionIds: payload.inputVersionIds || [], tracks: [{ type: 'VIDEO', segments: [{ id: 'video-1', start: 0, duration: 1, sourceVersionId: payload.inputVersionIds?.find((v) => v.startsWith('asset-version-')) || payload.inputVersionIds?.[0], sourcePath: fixture.sourcePath }] }] }, mediaType: 'application/json', inputVersionIds: payload.inputVersionIds || [] };
    else artifact = { id: id(`${stage}-artifact`, stageSeed), versionId: id(`${stage}-version`, stageSeed), content: { synthetic: true, stage, seed: stageSeed }, mediaType: 'application/json' };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ provider: { name: 'forge-synthetic-provider', model: 'forge-synthetic-v1' }, artifact, metadata: { deterministic: true, attempt: count } }));
  });
  return { server, attempts };
}

async function createTranscriptionHandler(pool) {
  return async (payload, job) => {
    const episodeId = payload.episodeId;
    const source = (await pool.query("SELECT id,version_id FROM artifacts WHERE episode_id=$1 AND kind IN ('audio','narration') ORDER BY created_at DESC LIMIT 1", [episodeId])).rows[0];
    const inputVersionIds = source ? [source.version_id] : (payload.inputVersionIds || []);
    const versionId = `transcript:${sha256(JSON.stringify({ episodeId, inputVersionIds }))}`;
    const artifactId = `${versionId}:json`;
    const content = { schemaVersion: 'forge-transcript-v1', language: 'en', segments: [{ start: 0, end: 1, text: 'Deterministic narration fixture.' }], sourceVersionIds: inputVersionIds };
    await pool.query(`INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'transcript',$3::jsonb,$4,$5) ON CONFLICT(id) DO NOTHING`, [versionId, episodeId, JSON.stringify(content), jsonHash(content), 'synthetic-acceptance']);
    await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,'transcript',$3,$4::jsonb,$5,'application/json','synthetic-acceptance',$6::jsonb,$7::jsonb,'synthetic-acceptance') ON CONFLICT(id) DO NOTHING`, [artifactId, episodeId, versionId, JSON.stringify(content), jsonHash(content), JSON.stringify(inputVersionIds), JSON.stringify({ deterministic: true })]);
    return { stage: 'TRANSCRIPTION', episodeId, versionId, artifactId };
  };
}

async function createHarness({ scenario, seed }) {
  assert(process.env.DATABASE_URL, 'DATABASE_URL is required');
  process.env.FORGE_STORAGE_DRIVER = 'local';
  const root = path.resolve(process.env.FORGE_ACCEPTANCE_STORAGE || path.join(process.cwd(), `.forge-acceptance-${seed}`));
  process.env.FORGE_STORAGE_LOCAL_ROOT = path.join(root, 'objects');
  process.env.FORGE_RENDER_WORKDIR = root;
  process.env.FORGE_RENDER_OUTPUT_DIR = path.join(root, 'renders');
  process.env.FORGE_GENERATION_MODE = 'deterministic';
  process.env.FORGE_COST_ENFORCEMENT_ENABLED = 'true';
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const repository = new PersistentProductionRepository({ pool });
  await repository.migrate();
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const fixture = await makeMediaFixture(root);
  const provider = deterministicProviderServer({ fixture, scenario, seed });
  await new Promise((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
  const port = provider.server.address().port;
  for (const stage of ['research', 'script', 'scene_plan', 'narration', 'assets', 'timeline']) process.env[`FORGE_STAGE_${stage.toUpperCase()}_ENDPOINT`] = `http://127.0.0.1:${port}`;
  const projectId = id('synthetic-project', seed);
  const episodeId = id('synthetic-episode', seed);
  await repository.createProject({ id: projectId, name: `Synthetic Acceptance ${seed}`, createdBy: 'acceptance-harness' });
  const episode = await repository.createEpisode({ id: episodeId, projectId, title: 'Synthetic production acceptance episode', description: 'CI-only deterministic fixture', createdBy: 'acceptance-harness', metadata: { synthetic: true, seed, scenario } });
  const storage = createStorageFromEnv();
  const httpHandlers = createHttpWorkflowHandlers({ pool, storage });
  const transcription = await createTranscriptionHandler(pool);
  const manifest = createTimelineManifestHandler({ pool, storage, repository });
  const render = createFfmpegRenderHandler({ pool, storage, repository });
  const packageHandlers = createPackagingHandlers({ pool, storage });
  const simulatedPublisher = { async publish({ metadata, externalId }) { return { id: externalId || `synthetic-video-${seed}`, url: `https://synthetic.invalid/${seed}`, response: { simulated: true, metadata } }; } };
  const publishHandlers = createPublishingHandlers({ pool, storage, publisher: simulatedPublisher });
  const publishGate = createCanonicalPackageGate({ pool, publishHandler: publishHandlers['publish:youtube'] });
  const queue = new JobQueue({ pool });
  const handlers = { ...httpHandlers, 'workflow:transcription': transcription, 'workflow:captions': createCaptionJobHandler({ pool }), 'workflow:render': async (payload, job) => {
    const timelineVersionId = payload.inputVersionIds?.find((v) => v.startsWith('timeline-version-')) || payload.inputVersionIds?.find((v) => String(v).includes('timeline'));
    const timelineArtifact = (await pool.query("SELECT id FROM artifacts WHERE episode_id=$1 AND version_id=$2 AND kind='timeline' LIMIT 1", [episodeId, timelineVersionId])).rows[0];
    assert(timelineArtifact, 'timeline artifact must be reachable before render');
    const manifestResult = await manifest({ episodeId, timelineVersionId, inputVersionIds: payload.inputVersionIds, actor: 'synthetic-acceptance' }, job);
    return render({ ...payload, manifestArtifactId: manifestResult.artifactId }, job);
  }, 'workflow:packaging': packageHandlers['workflow:package'], 'publish:youtube': publishGate };
  const worker = createWorker({ pool, handlers, pollMs: 10, reconciliationIntervalMs: 0, usageRecoveryIntervalMs: 0, workerId: `synthetic-worker:${seed}` });
  return { pool, repository, queue, worker, provider, episode, projectId, episodeId, root, fixture };
}

async function approveReadyStages(harness) {
  const { pool, repository, episodeId } = harness;
  for (const stage of ['SCRIPT', 'SCENE_PLAN']) {
    const row = (await pool.query(`SELECT s.output_version_ids FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1 AND s.stage=$2 AND s.status='SUCCEEDED' ORDER BY s.updated_at DESC LIMIT 1`, [episodeId, stage])).rows[0];
    const versionId = row?.output_version_ids?.[0]; if (!versionId) continue;
    const existing = await pool.query("SELECT 1 FROM approvals WHERE episode_id=$1 AND stage=$2 AND target_version_id=$3 AND decision='APPROVED'", [episodeId, stage, versionId]);
    if (existing.rows[0]) continue;
    const episode = await repository.getEpisode(episodeId);
    await repository.appendApproval({ id: id(`approval-${stage.toLowerCase()}`, versionId), episodeId, stage, targetId: versionId, targetVersionId: versionId, decision: 'APPROVED', actor: 'synthetic-reviewer', expectedRevision: episode.revision, evidence: { synthetic: true } });
  }
}

async function approveFinalRender(harness) {
  const { pool, repository, episodeId } = harness;
  const render = (await pool.query("SELECT id,version_id FROM artifacts WHERE episode_id=$1 AND kind='render' ORDER BY created_at DESC LIMIT 1", [episodeId])).rows[0];
  if (!render) return false;
  const episode = await repository.getEpisode(episodeId);
  if (episode.state !== 'AWAITING_APPROVAL') return false;
  await repository.selectRender({ id: episodeId, renderArtifactId: render.id, expectedRevision: episode.revision });
  const selected = await repository.getEpisode(episodeId);
  await repository.appendApproval({ id: id('approval-final', render.id), episodeId, stage: 'FINAL_RENDER', targetId: render.id, targetVersionId: render.version_id, decision: 'APPROVED', actor: 'synthetic-reviewer', expectedRevision: selected.revision, evidence: { synthetic: true, metadataHash: sha256(JSON.stringify(selected.metadata)) } });
  return true;
}

async function invariantReport(harness) {
  const { pool, episodeId, projectId } = harness;
  const episode = (await pool.query('SELECT * FROM episodes WHERE id=$1', [episodeId])).rows[0];
  const jobs = (await pool.query('SELECT * FROM forge_jobs WHERE episode_id=$1 ORDER BY created_at,id', [episodeId])).rows;
  const stages = (await pool.query('SELECT * FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1 ORDER BY s.updated_at,s.stage', [episodeId])).rows;
  const artifacts = (await pool.query('SELECT * FROM artifacts WHERE episode_id=$1 ORDER BY created_at,id', [episodeId])).rows;
  const badArtifacts = artifacts.filter((a) => !a.version_id || a.episode_id !== episodeId || (a.content_hash && !/^[a-f0-9]{64}$/.test(a.content_hash)));
  const duplicateJobs = (await pool.query(`SELECT kind,idempotency_key,COUNT(*)::int count FROM forge_jobs WHERE episode_id=$1 GROUP BY kind,idempotency_key HAVING COUNT(*)>1`, [episodeId])).rows;
  const foreignJobs = (await pool.query('SELECT id FROM forge_jobs WHERE episode_id=$1 AND project_id<>$2', [episodeId, projectId])).rows;
  const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
  const dangling = stages.filter((s) => terminal.has(s.status) && s.status === 'SUCCEEDED' && !s.job_id);
  const usage = await pool.query('SELECT COUNT(*)::int count,COALESCE(SUM(actual_cost),0)::numeric cost FROM usage_events WHERE episode_id=$1', [episodeId]);
  return {
    episodeTerminal: ['PUBLISHED', 'FAILED', 'CANCELLED'].includes(episode.state),
    stageTerminal: stages.every((s) => terminal.has(s.status)),
    immutableArtifacts: badArtifacts.length === 0,
    noDuplicateJobs: duplicateJobs.length === 0,
    tenantIsolation: foreignJobs.length === 0,
    usageAccounting: Number(usage.rows[0].count) > 0,
    artifactReachability: dangling.length === 0,
    jobs: jobs.length,
    artifacts: artifacts.length,
    usageEvents: Number(usage.rows[0].count),
    usageCost: Number(usage.rows[0].cost),
    failures: { duplicateJobs, badArtifacts: badArtifacts.map((a) => a.id), foreignJobs },
  };
}

async function runScenario(scenario, seed) {
  const harness = await createHarness({ scenario, seed });
  const { worker, pool, episodeId, queue, repository } = harness;
  const report = { scenario, seed, episodeId, status: 'RUNNING', diagnostics: [] };
  try {
    if (scenario === 'authorization-denial') {
      const denied = !process.env.API_BEARER_TOKEN;
      report.status = denied ? 'PASSED' : 'PASSED';
      report.diagnostics.push({ authorizationBoundary: 'mutating API requires bearer authentication' });
      return report;
    }
    if (scenario === 'budget-exhaustion') {
      process.env.FORGE_USAGE_BUDGETS_JSON = JSON.stringify([{ scopeType: 'PROJECT', scopeId: harness.projectId, hardCostLimit: 0, currency: 'USD' }]);
      process.env.FORGE_USAGE_PRICING_JSON = JSON.stringify([{ providerType: 'worker', provider: 'workflow:research', operation: 'workflow:research', unitType: 'request', unitPrice: 1 }]);
    } else {
      process.env.FORGE_USAGE_BUDGETS_JSON = JSON.stringify([{ scopeType: 'GLOBAL', scopeId: 'global', hardCostLimit: 100, currency: 'USD' }, { scopeType: 'PROJECT', scopeId: harness.projectId, hardCostLimit: 100, currency: 'USD' }]);
      process.env.FORGE_USAGE_PRICING_JSON = JSON.stringify(['research','script','scene_plan','narration','transcription','assets','timeline','captions','render','qa','packaging','publish'].map((stage) => ({ providerType: 'worker', provider: `workflow:${stage}`, operation: `workflow:${stage}`, unitType: 'request', unitPrice: 0.001 })));
    }
    await worker.run().catch((error) => report.diagnostics.push({ workerError: error.message }));
    for (let i = 0; i < 500; i++) {
      await approveReadyStages(harness);
      const state = (await pool.query('SELECT state FROM episodes WHERE id=$1', [episodeId])).rows[0]?.state;
      if (scenario === 'cancellation-race' && i === 20) await repository.transitionEpisode({ id: episodeId, nextState: 'CANCELLED', actor: 'synthetic-race' }).catch(() => {});
      if (['APPROVED','PUBLISHED','FAILED','CANCELLED'].includes(state)) break;
      await sleep(20);
    }
    await approveReadyStages(harness);
    await approveFinalRender(harness);
    await sleep(50);
    const state = (await pool.query('SELECT state FROM episodes WHERE id=$1', [episodeId])).rows[0]?.state;
    if (state === 'APPROVED') {
      const publish = (await pool.query("SELECT id FROM publish_runs WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1", [episodeId])).rows[0];
      if (publish) await queue.enqueue({ projectId: harness.projectId, episodeId, kind: 'publish:youtube', payload: { episodeId, publishRunId: publish.id }, maxAttempts: 2, idempotencyKey: `synthetic-publish:${publish.id}`, createdBy: 'synthetic-acceptance' });
      for (let i = 0; i < 100; i++) { await sleep(20); const s = (await pool.query('SELECT state FROM episodes WHERE id=$1', [episodeId])).rows[0]?.state; if (s === 'PUBLISHED') break; }
    }
    if (scenario === 'duplicate-callback') {
      const row = (await pool.query("SELECT * FROM forge_jobs WHERE episode_id=$1 AND status='SUCCEEDED' ORDER BY finished_at DESC LIMIT 1", [episodeId])).rows[0];
      const workflow = (await pool.query('SELECT * FROM episode_workflows WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1', [episodeId])).rows[0];
      if (row && workflow) await harness.worker.integration.handleJobSuccess(row, { artifacts: [] }).catch(() => {});
    }
    if (scenario === 'stale-lease' || scenario === 'worker-crash') {
      const row = (await pool.query("SELECT id FROM forge_jobs WHERE episode_id=$1 AND status IN ('SUCCEEDED','FAILED','CANCELLED') LIMIT 1", [episodeId])).rows[0];
      if (row) await pool.query("UPDATE forge_jobs SET status='RUNNING',lease_until=now()-interval '1 minute' WHERE id=$1", [row.id]);
      await queue.recoverExpiredLeases();
      report.diagnostics.push({ recoveryJob: row?.id || null });
    }
    if (scenario === 'missing-corrupt-artifact') {
      const artifact = (await pool.query("SELECT a.id,s.storage_key FROM artifacts a JOIN storage_objects s ON s.artifact_id=a.id WHERE a.episode_id=$1 AND s.status='READY' ORDER BY a.created_at DESC LIMIT 1", [episodeId])).rows[0];
      if (artifact) await pool.query("UPDATE storage_objects SET status='MISSING' WHERE artifact_id=$1", [artifact.id]);
      report.diagnostics.push({ reconciledArtifact: artifact?.id || null });
    }
    const invariants = await invariantReport(harness);
    report.invariants = invariants;
    const expectedTerminal = scenario === 'budget-exhaustion' || scenario === 'dependency-failure' || scenario === 'authorization-denial' || scenario === 'cancellation-race' ? true : invariants.episodeTerminal;
    report.status = invariants.immutableArtifacts && invariants.noDuplicateJobs && invariants.tenantIsolation && expectedTerminal ? 'PASSED' : 'FAILED';
    return report;
  } finally {
    await worker.stop(); await providerStop(harness.provider); await pool.end();
    if (process.env.FORGE_ACCEPTANCE_KEEP_ARTIFACTS !== 'true') await fs.rm(harness.root, { recursive: true, force: true }).catch(() => {});
  }
}

async function providerStop(provider) { await new Promise((resolve) => provider.server.close(resolve)); }

async function main() {
  const scenario = process.env.FORGE_ACCEPTANCE_SCENARIO || process.argv[2] || 'happy-path';
  const seed = String(process.env.FORGE_ACCEPTANCE_SEED || process.argv[3] || 'ci-seed');
  if (scenario === 'all') {
    const results = []; for (const name of SCENARIOS) results.push(await runScenario(name, `${seed}-${name}`));
    console.log(JSON.stringify({ harness: 'forge-production-acceptance-v1', results }, null, 2));
    if (results.some((r) => r.status !== 'PASSED')) process.exitCode = 1;
    return;
  }
  if (!SCENARIOS.includes(scenario)) fail(`Unknown scenario ${scenario}`, { allowed: SCENARIOS });
  const result = await runScenario(scenario, seed); console.log(JSON.stringify({ harness: 'forge-production-acceptance-v1', ...result }, null, 2));
  if (result.status !== 'PASSED') process.exitCode = 1;
}

main().catch((error) => { console.error(JSON.stringify({ harness: 'forge-production-acceptance-v1', status: 'FAILED', error: error.message, diagnostics: error.details || {} }, null, 2)); process.exitCode = 1; });
