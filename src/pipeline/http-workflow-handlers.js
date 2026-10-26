const { randomUUID } = require('node:crypto');
const { PersistentProductionRepository } = require('../persistence/production-repository');

const STAGES = ['research', 'script', 'scene_plan', 'narration', 'assets', 'timeline', 'render', 'qa'];
const VERSION_KINDS = { research: 'research', script: 'script', scene_plan: 'scene-plan', narration: 'narration', assets: 'asset', timeline: 'timeline', render: 'render', qa: 'qa' };
const CAPABILITIES = { research: 'research', script: 'llm', scene_plan: 'scene-plan', narration: 'tts', assets: 'image', timeline: 'timeline', render: 'render', qa: 'qa' };
const STAGE_DEPENDENCIES = {
  research: [],
  script: ['research'],
  scene_plan: ['script'],
  narration: ['script', 'scene_plan'],
  assets: ['scene_plan'],
  timeline: ['scene_plan', 'narration', 'assets'],
  render: ['timeline'],
  qa: ['render'],
};
const toEndpointKey = (stage) => 'FORGE_STAGE_' + stage.toUpperCase() + '_ENDPOINT';

function assertProviderEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw Object.assign(new Error('Stage provider endpoint must be an absolute HTTPS URL'), { retryable: false }); }
  if (parsed.protocol !== 'https:') throw Object.assign(new Error('Stage provider endpoints must use HTTPS'), { retryable: false });
  if (parsed.username || parsed.password) throw Object.assign(new Error('Credentials must not be embedded in the provider endpoint URL'), { retryable: false });
  return parsed.href;
}

function createHttpWorkflowHandlers({ pool, fetchImpl = fetch, timeoutMs = 120000, logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  const repository = new PersistentProductionRepository({ pool });
  const handlers = {};
  for (const stage of STAGES) handlers['workflow:' + stage] = (payload, job) => executeStage({ stage, payload, job, repository, fetchImpl, timeoutMs, logger });
  return handlers;
}

async function executeStage({ stage, payload, job, repository, fetchImpl = fetch, timeoutMs = 120000, logger = console }) {
  const endpoint = process.env[toEndpointKey(stage)];
  if (!endpoint) throw Object.assign(new Error(toEndpointKey(stage) + ' is not configured'), { retryable: false });
  const safeEndpoint = assertProviderEndpoint(endpoint);
  const dependencies = STAGE_DEPENDENCIES[stage];
  if (!dependencies) throw Object.assign(new Error('Unknown workflow stage: ' + stage), { retryable: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const upstream = dependencies.length
      ? await repository.db.pool.query(
        `SELECT kind, result FROM forge_jobs
         WHERE episode_id=$1 AND status='SUCCEEDED' AND kind = ANY($2::text[])
         ORDER BY finished_at DESC`,
        [payload.episodeId, dependencies.map((name) => 'workflow:' + name)],
      )
      : { rows: [] };
    const latestByKind = new Map();
    for (const row of upstream.rows) {
      // A job result is stored as JSONB by JobQueue.succeed. Accept JSON strings
      // as well for test fixtures or older writer versions.
      let result = row.result;
      if (typeof result === 'string') {
        try { result = JSON.parse(result); } catch { result = null; }
      }
      if (result && !latestByKind.has(row.kind)) latestByKind.set(row.kind, result);
    }
    const missing = dependencies.filter((name) => {
      const result = latestByKind.get('workflow:' + name);
      return !result || typeof result.versionId !== 'string' || !result.versionId;
    });
    if (missing.length) throw Object.assign(new Error('Upstream stage result missing: ' + missing.join(', ')), { retryable: false });
    const upstreamResults = Object.fromEntries(dependencies.map((name) => [name, latestByKind.get('workflow:' + name)]));
    const dependencyVersionIds = [...new Set(dependencies.map((name) => latestByKind.get('workflow:' + name).versionId))];

    const response = await fetchImpl(safeEndpoint, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(process.env.FORGE_STAGE_PROVIDER_TOKEN ? { authorization: 'Bearer ' + process.env.FORGE_STAGE_PROVIDER_TOKEN } : {}) },
      body: JSON.stringify({
        contractVersion: 'forge-stage-v1',
        stage: stage.toUpperCase(),
        capability: CAPABILITIES[stage],
        payload: { ...payload, upstream: upstreamResults, inputVersionIds: dependencyVersionIds },
        job: { id: job?.id, attempts: job?.attempts },
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { throw Object.assign(new Error('Stage ' + stage + ' provider returned invalid JSON'), { retryable: response.status >= 500 }); }
    if (!response.ok) throw Object.assign(new Error('Stage ' + stage + ' provider returned HTTP ' + response.status), { retryable: response.status === 408 || response.status === 429 || response.status >= 500, status: response.status });
    const artifact = body.artifact || body;
    if (!artifact || (artifact.content == null && !artifact.storageUri)) throw Object.assign(new Error('Stage ' + stage + ' response must include artifact.content or artifact.storageUri'), { retryable: false });
    const episodeId = payload.episodeId;
    const episode = await repository.db.getEpisode(episodeId);
    if (!episode) throw Object.assign(new Error('Episode not found: ' + episodeId), { retryable: false });
    const versionId = artifact.versionId || stage + ':' + randomUUID();
    const artifactId = artifact.id || randomUUID();
    const kind = VERSION_KINDS[stage];
    const inputVersionIds = [...new Set([...dependencyVersionIds, ...(Array.isArray(artifact.inputVersionIds) ? artifact.inputVersionIds.map(String) : [])])];
    let qaFailure = null;
    await repository.db.withTransaction(async (client) => {
      const existingVersion = await client.query('SELECT id, episode_id, kind FROM version_records WHERE id=$1', [versionId]);
      if (!existingVersion.rows[0]) {
        await client.query('INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)', [versionId, episodeId, kind, JSON.stringify(artifact.content == null ? {} : artifact.content), artifact.contentHash || null, payload.actor || 'worker']);
      } else if (existingVersion.rows[0].episode_id !== episodeId || existingVersion.rows[0].kind !== kind) {
        throw Object.assign(new Error('Provider version identity conflicts with episode or stage'), { retryable: false });
      }
      for (const dependencyId of inputVersionIds) {
        if (dependencyId === versionId) throw Object.assign(new Error('Artifact cannot depend on itself'), { retryable: false });
        const dep = await client.query('SELECT episode_id FROM version_records WHERE id=$1 FOR SHARE', [dependencyId]);
        if (!dep.rows[0] || dep.rows[0].episode_id !== episodeId) throw Object.assign(new Error('Provider artifact references a missing or cross-episode input version: ' + dependencyId), { retryable: false });
      }
      await client.query(
        `INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'provider',$9::jsonb,$10::jsonb,$11)
         ON CONFLICT (id) DO NOTHING`,
        [artifactId, episodeId, kind, versionId, artifact.storageUri || null, artifact.content == null ? null : JSON.stringify(artifact.content),
          artifact.contentHash || null, artifact.mediaType || null, JSON.stringify(inputVersionIds),
          JSON.stringify({ ...(artifact.metadata || {}), stage: stage.toUpperCase(), provider: body.provider || null }), payload.actor || 'worker']);
      for (const dependencyId of inputVersionIds) await client.query('INSERT INTO version_dependencies(episode_id,version_id,depends_on_version_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [episodeId, versionId, dependencyId]);
      if (stage === 'qa') {
        const qa = body.qa || artifact.qa || artifact.content?.qa || artifact.content || {};
        const status = String(qa.status || body.status || '').toUpperCase();
        if (!['PASSED','WARNINGS','FAILED'].includes(status)) throw Object.assign(new Error('QA stage must return qa.status as PASSED, WARNINGS, or FAILED'), { retryable: false });
        await client.query('INSERT INTO qa_results(id,episode_id,artifact_id,version_id,status,checks,runner,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)', [randomUUID(), episodeId, artifactId, versionId, status, JSON.stringify(Array.isArray(qa.checks) ? qa.checks : []), String(body.provider || 'http-workflow-provider'), JSON.stringify(qa.metadata || {})]);
        if (status === 'FAILED') qaFailure = Object.assign(new Error('QA provider marked the render as failed'), { retryable: false });
      }
    });
    logger.log?.('Forge stage ' + stage + ' completed for episode ' + episodeId);
    if (qaFailure) throw qaFailure;
    return { stage: stage.toUpperCase(), episodeId, versionId, artifactId, inputVersionIds, metadata: body.metadata || {} };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Stage ' + stage + ' timed out after ' + timeoutMs + 'ms'), { retryable: true });
    throw error;
  } finally { clearTimeout(timer); }
}
module.exports = { createHttpWorkflowHandlers, executeStage, assertProviderEndpoint, STAGES, CAPABILITIES, STAGE_DEPENDENCIES };
