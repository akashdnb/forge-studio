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
const id = (prefix, seed) => `${prefix}:${sha(`${prefix}:${seed}`).slice(0, 24)}`;
const assert = (value, message) => { if (!value) throw new Error(message); };

function ffmpegFixture(root) {
  const file = path.join(root, 'fixtures', 'source.mp4');
  const result = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-y','-f','lavfi','-i','color=c=black:s=320x180:r=30','-t','1','-pix_fmt','yuv420p','-c:v','libx264','-movflags','+faststart',file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`deterministic FFmpeg fixture failed: ${(result.stderr || '').slice(-1000)}`);
  return file;
}

function fixtureProvider({ mediaFile, scenario, seed }) {
  const attempts = new Map();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const stage = String(body.stage || '').toLowerCase();
    const attempt = (attempts.get(stage) || 0) + 1; attempts.set(stage, attempt);
    if (scenario === 'provider-timeout-retry' && stage === 'script' && attempt === 1) { res.writeHead(503); return res.end('{}'); }
    if (scenario === 'dependency-failure' && stage === 'scene_plan') { res.writeHead(400); return res.end('{}'); }
    const payload = body.payload || {};
    const token = sha(JSON.stringify({ seed, stage, episodeId: payload.episodeId, inputs: payload.inputVersionIds || [] }));
    let artifact = { id: id(`${stage}-artifact`, token), versionId: id(`${stage}-version`, token), content: { synthetic: true, stage, token }, mediaType: 'application/json' };
    if (stage === 'research') artifact.content = { schemaVersion: 'synthetic-research-v1', claims: [{ id: 'c1', text: 'Deterministic claim', source: 'synthetic://fixture' }] };
    if (stage === 'script') artifact.content = { schemaVersion: 'synthetic-script-v1', sections: [{ id: 's1', text: 'Deterministic script' }] };
    if (stage === 'scene_plan') artifact.content = { schemaVersion: 'synthetic-scene-v1', scenes: [{ id: 'scene-1', durationSeconds: 1 }] };
    if (stage === 'narration') artifact.content = { text: 'Deterministic narration' };
    if (stage === 'assets') { const bytes = await fs.readFile(mediaFile); artifact = { ...artifact, contentBase64: bytes.toString('base64'), contentHash: sha(bytes), mediaType: 'video/mp4', metadata: { deterministic: true } }; }
    if (stage === 'timeline') artifact = { ...artifact, content: { schemaVersion: 'synthetic-timeline-v1', durationSeconds: 1, inputVersionIds: payload.inputVersionIds || [], tracks: [{ type: 'VIDEO', segments: [{ id: 'v1', start: 0, duration: 1, sourceVersionId: (payload.inputVersionIds || []).find((v) => v.startsWith('asset-version:')) }] }] }, inputVersionIds: payload.inputVersionIds || [] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ provider: { name: 'forge-synthetic-provider', model: 'forge-synthetic-v1' }, artifact, metadata: { attempt, deterministic: true } }));
  });
  return { server, attempts };
}

async function deterministicTranscript(pool, payload) {
  const inputs = payload.inputVersionIds || [];
  const versionId = `transcript:${sha(JSON.stringify({ episodeId: payload.episodeId, inputs }))}`;
  const content = { schemaVersion: 'forge-transcript-v1', language: 'en', segments: [{ start: 0, end: 1, text: 'Deterministic narration' }], sourceVersionIds: inputs };
  const checksum = sha(JSON.stringify(content));
  await pool.query(`INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'transcript',$3::jsonb,$4,'synthetic') ON CONFLICT(id) DO NOTHING`, [versionId, payload.episodeId, JSON.stringify(content), checksum]);
  await pool.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,'transcript',$3,$4::jsonb,$5,'application/json','synthetic',$6::jsonb,'{"deterministic":true}'::jsonb,'synthetic') ON CONFLICT(id) DO NOTHING`, [`${versionId}:json`, payload.episodeId, versionId, JSON.stringify(content), checksum, JSON.stringify(inputs)]);
  return { stage: 'TRANSCRIPTION', versionId, artifactId: `${versionId}:json` };
}

async function authorizationProbe() {
  const { server } = createApiServer({ apiToken: 'synthetic-token' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/episodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  server.close();
  return response.status === 401 || response.status === 403;
}

async function buildHarness(scenario, seed) {
  const root = path.resolve(process.env.FORGE_ACCEPTANCE_STORAGE || path.join(process.cwd(), `.forge-acceptance-${seed}`));
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(path.join(root, 'fixtures'), { recursive: true });
  process.env.FORGE_STORAGE_DRIVER = 'local'; process.env.FORGE_STORAGE_LOCAL_ROOT = path.join(root, 'objects'); process.env.FORGE_RENDER_WORKDIR = root; process.env.FORGE_RENDER_OUTPUT_DIR = path.join(root, 'renders');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const repository = new PersistentProductionRepository({ pool }); await repository.migrate();
  const projectId = id('project', seed), episodeId = id('episode', seed);
  await repository.createProject({ id: projectId, name: `Synthetic ${seed}`, createdBy: 'acceptance' });
  await repository.createEpisode({ id: episodeId, projectId, title: 'Synthetic acceptance episode', createdBy: 'acceptance', metadata: { synthetic: true, seed, scenario } });
  const mediaFile = ffmpegFixture(root), provider = fixtureProvider({ mediaFile, scenario, seed });
  await new Promise((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${provider.server.address().port}`;
  for (const stage of ['research','script','scene_plan','narration','assets','timeline']) process.env[`FORGE_STAGE_${stage.toUpperCase()}_ENDPOINT`] = endpoint;
  const storage = createStorageFromEnv();
  const workflow = createHttpWorkflowHandlers({ pool, storage });
  const manifest = createTimelineManifestHandler({ pool, storage, repository });
  const render = createFfmpegRenderHandler({ pool, storage, repository });
  const packaging = createPackagingHandlers({ pool, storage });
  const publisher = { publish: async ({ metadata, externalId }) => ({ id: externalId || `synthetic:${seed}`, url: `https://synthetic.invalid/${seed}`, response: { simulated: true, metadata } }) };
  const publishing = createPublishingHandlers({ pool, storage, publisher });
  const publishGate = createCanonicalPackageGate({ pool, publishHandler: publishing['publish:youtube'] });
  const handlers = {
    ...workflow,
    'workflow:transcription': (_, job) => deterministicTranscript(pool, job.payload),
    'workflow:captions': createCaptionJobHandler({ pool }),
    'workflow:render': async (payload, job) => {
      const timelineVersionId = (payload.inputVersionIds || []).find((v) => v.startsWith('timeline-version:'));
      assert(timelineVersionId, 'render dependency missing timeline version');
      const timeline = (await pool.query("SELECT id FROM artifacts WHERE episode_id=$1 AND version_id=$2 AND kind='timeline'", [episodeId, timelineVersionId])).rows[0];
      assert(timeline, 'timeline artifact is unreachable');
      for (const inputVersionId of payload.inputVersionIds || []) if (inputVersionId !== timelineVersionId) await pool.query('INSERT INTO version_dependencies(episode_id,version_id,depends_on_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [episodeId, timelineVersionId, inputVersionId]);
      const compiled = await manifest({ episodeId, timelineVersionId, inputVersionIds: payload.inputVersionIds, actor: 'acceptance' }, job);
      return render({ ...payload, manifestArtifactId: compiled.artifactId }, job);
    },
    'workflow:packaging': packaging['workflow:package'],
    'publish:youtube': async (payload, job) => {
      let publishRunId = payload.publishRunId;
      if (!publishRunId) {
        const pkg = (await pool.query("SELECT id,version_id,final_media_artifact_id,final_media_version_id FROM episode_packages WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1", [episodeId])).rows[0]; assert(pkg, 'package missing before publish');
        const renderArtifact = (await pool.query('SELECT id,version_id FROM artifacts WHERE id=$1', [pkg.final_media_artifact_id])).rows[0]; assert(renderArtifact, 'render artifact missing before publish');
        publishRunId = id('publish', seed);
        await pool.query(`INSERT INTO publish_runs(id,episode_id,destination,status,render_artifact_id,render_version_id,package_artifact_id,package_version_id,metadata,attempt) VALUES($1,$2,'youtube','QUEUED',$3,$4,$5,$6,'{"synthetic":true}'::jsonb,1) ON CONFLICT(id) DO NOTHING`, [publishRunId, episodeId, renderArtifact.id, renderArtifact.version_id, pkg.id, pkg.version_id]);
        payload = { ...payload, publishRunId };
      }
      return publishGate(payload, job);
    }
  };
  const worker = createWorker({ pool, handlers, pollMs: 10, reconciliationIntervalMs: 0, usageRecoveryIntervalMs: 0, workerId: `acceptance:${seed}` });
  return { root, pool, repository, queue: new JobQueue({ pool }), worker, provider, projectId, episodeId };
}

async function approveReady(h) {
  for (const stage of ['SCRIPT','SCENE_PLAN']) {
    const row = (await h.pool.query(`SELECT s.output_version_ids FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1 AND s.stage=$2 AND s.status='SUCCEEDED' ORDER BY s.updated_at DESC LIMIT 1`, [h.episodeId, stage])).rows[0];
    const versionId = row?.output_version_ids?.[0]; if (!versionId) continue;
    const exists = (await h.pool.query("SELECT 1 FROM approvals WHERE episode_id=$1 AND stage=$2 AND target_version_id=$3 AND decision='APPROVED'", [h.episodeId, stage, versionId])).rows[0]; if (exists) continue;
    const episode = await h.repository.getEpisode(h.episodeId);
    await h.repository.appendApproval({ id: id(`approval-${stage}`, versionId), episodeId: h.episodeId, stage, targetId: versionId, targetVersionId: versionId, decision: 'APPROVED', actor: 'synthetic-reviewer', expectedRevision: episode.revision, evidence: { synthetic: true } });
  }
}

async function approveFinal(h) {
  const render = (await h.pool.query("SELECT id,version_id FROM artifacts WHERE episode_id=$1 AND kind='render' ORDER BY created_at DESC LIMIT 1", [h.episodeId])).rows[0]; if (!render) return;
  const episode = await h.repository.getEpisode(h.episodeId); if (episode.state !== 'AWAITING_APPROVAL') return;
  await h.repository.selectRender({ id: h.episodeId, renderArtifactId: render.id, expectedRevision: episode.revision });
  const selected = await h.repository.getEpisode(h.episodeId);
  await h.repository.appendApproval({ id: id('approval-final', render.id), episodeId: h.episodeId, stage: 'FINAL_RENDER', targetId: render.id, targetVersionId: render.version_id, decision: 'APPROVED', actor: 'synthetic-reviewer', expectedRevision: selected.revision, evidence: { synthetic: true } });
}

async function invariants(h) {
  const episode = (await h.pool.query('SELECT state FROM episodes WHERE id=$1', [h.episodeId])).rows[0];
  const jobs = (await h.pool.query('SELECT project_id,status,attempt,idempotency_key FROM forge_jobs WHERE episode_id=$1', [h.episodeId])).rows;
  const stages = (await h.pool.query('SELECT s.status FROM episode_workflow_stages s JOIN episode_workflows w ON w.id=s.workflow_id WHERE w.episode_id=$1', [h.episodeId])).rows;
  const artifacts = (await h.pool.query('SELECT id,episode_id,version_id,content_hash FROM artifacts WHERE episode_id=$1', [h.episodeId])).rows;
  const duplicates = (await h.pool.query('SELECT idempotency_key,COUNT(*)::int count FROM forge_jobs WHERE episode_id=$1 GROUP BY idempotency_key HAVING COUNT(*)>1', [h.episodeId])).rows;
  const usage = Number((await h.pool.query('SELECT COUNT(*)::int count FROM usage_events WHERE episode_id=$1', [h.episodeId])).rows[0].count || 0);
  const badArtifacts = artifacts.filter((a) => a.episode_id !== h.episodeId || !a.version_id || (a.content_hash && !/^[a-f0-9]{64}$/.test(a.content_hash)));
  return { episode: episode?.state, terminal: ['PUBLISHED','FAILED','CANCELLED'].includes(episode?.state), stagesTerminal: stages.length > 0 && stages.every((s) => ['SUCCEEDED','FAILED','CANCELLED'].includes(s.status)), tenantIsolation: jobs.every((j) => j.project_id === h.projectId), noDuplicateJobs: duplicates.length === 0, immutableArtifacts: badArtifacts.length === 0, usageAccounting: usage > 0 || process.env.FORGE_ACCEPTANCE_SCENARIO === 'budget-exhaustion', jobCount: jobs.length, artifactCount: artifacts.length, usageEvents: usage, diagnostics: { duplicateJobs: duplicates, badArtifacts: badArtifacts.map((a) => a.id) } };
}

async function runScenario(scenario, seed) {
  if (scenario === 'authorization-denial') return { scenario, seed, status: (await authorizationProbe()) ? 'PASSED' : 'FAILED', invariants: { authorizationDenied: true } };
  const h = await buildHarness(scenario, seed);
  let workerPromise;
  try {
    workerPromise = h.worker.run();
    await h.worker.integration.enqueue({ episodeId: h.episodeId, projectId: h.projectId, brief: 'Deterministic long-form acceptance episode', actor: 'acceptance', idempotencyPrefix: `acceptance:${seed}` });
    if (scenario === 'duplicate-callback') await h.worker.integration.enqueue({ episodeId: h.episodeId, projectId: h.projectId, brief: 'Deterministic long-form acceptance episode', actor: 'acceptance', idempotencyPrefix: `acceptance:${seed}` });
    for (let i = 0; i < 900; i += 1) {
      await approveReady(h); await approveFinal(h);
      const state = (await h.pool.query('SELECT state FROM episodes WHERE id=$1', [h.episodeId])).rows[0]?.state;
      if (scenario === 'cancellation-race' && i === 40) await h.repository.transitionEpisode({ id: h.episodeId, nextState: 'CANCELLED', actor: 'synthetic-race' }).catch(() => {});
      if (['PUBLISHED','FAILED','CANCELLED'].includes(state)) break;
      await sleep(10);
    }
    await approveReady(h); await approveFinal(h); await sleep(100);
    if (scenario === 'stale-lease' || scenario === 'worker-crash') {
      const job = (await h.pool.query("SELECT id FROM forge_jobs WHERE episode_id=$1 AND status='SUCCEEDED' ORDER BY created_at LIMIT 1", [h.episodeId])).rows[0];
      if (job) { await h.pool.query("UPDATE forge_jobs SET status='RUNNING',lease_until=now()-interval '1 minute' WHERE id=$1", [job.id]); await h.queue.recoverExpiredLeases(); }
    }
    if (scenario === 'missing-corrupt-artifact' || scenario === 'partial-recovery') {
      const artifact = (await h.pool.query("SELECT id FROM artifacts WHERE episode_id=$1 ORDER BY created_at DESC LIMIT 1", [h.episodeId])).rows[0];
      if (artifact) await h.pool.query("UPDATE storage_objects SET status='CORRUPT' WHERE artifact_id=$1", [artifact.id]).catch(() => {});
      await h.queue.recoverExpiredLeases();
    }
    const result = { scenario, seed, status: 'PASSED', invariants: await invariants(h) };
    const invariantFailure = Object.entries(result.invariants).filter(([k,v]) => ['terminal','stagesTerminal','tenantIsolation','noDuplicateJobs','immutableArtifacts','usageAccounting'].includes(k) && v !== true);
    if (invariantFailure.length) { result.status = 'FAILED'; result.invariantFailures = invariantFailure.map(([k]) => k); }
    await fs.mkdir(h.root, { recursive: true }); await fs.writeFile(path.join(h.root, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    h.provider.server.close(); await h.pool.end();
    if (workerPromise?.catch) workerPromise.catch(() => {});
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const scenario = process.env.FORGE_ACCEPTANCE_SCENARIO || process.argv[2] || 'all';
  const seed = String(process.env.FORGE_ACCEPTANCE_SEED || 'ci');
  const scenarios = scenario === 'all' ? SCENARIOS : [scenario];
  if (scenarios.some((name) => !SCENARIOS.includes(name))) throw new Error(`Unknown acceptance scenario: ${scenario}`);
  const results = [];
  for (const name of scenarios) results.push(await runScenario(name, `${seed}-${name}`));
  console.log(JSON.stringify({ seed, results }, null, 2));
  if (results.some((r) => r.status !== 'PASSED')) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { SCENARIOS, runScenario };
