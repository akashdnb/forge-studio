const { randomUUID } = require('node:crypto');
const { PersistentProductionRepository } = require('../persistence/production-repository');
const { executeMediaQa } = require('./media-qa-handler');
const { ArtifactStorageService } = require('../storage/artifact-storage-service');
const STAGES = ['research', 'script', 'scene_plan', 'narration', 'assets', 'timeline', 'render', 'qa'];
const VERSION_KINDS = { research: 'research', script: 'script', scene_plan: 'scene-plan', narration: 'narration', assets: 'asset', timeline: 'timeline', render: 'render', qa: 'qa' };
const CAPABILITIES = { research: 'research', script: 'llm', scene_plan: 'scene-plan', narration: 'tts', assets: 'image', timeline: 'timeline', render: 'render', qa: 'qa' };
const toEndpointKey = (stage) => 'FORGE_STAGE_' + stage.toUpperCase() + '_ENDPOINT';
function createHttpWorkflowHandlers({ pool, storage, fetchImpl = fetch, timeoutMs = 120000, logger = console } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
  const repository = new PersistentProductionRepository({ pool }); const storageService = storage ? new ArtifactStorageService({ storage, repository }) : null; const handlers = {};
  for (const stage of STAGES) handlers['workflow:' + stage] = stage === 'qa' ? (payload, job) => executeMediaQa({ payload, job, repository, logger }) : (payload, job) => executeStage({ stage, payload, job, repository, storageService, fetchImpl, timeoutMs, logger });
  return handlers;
}
async function executeStage({ stage, payload, job, repository, storageService = null, fetchImpl, timeoutMs, logger }) {
  const endpoint = process.env[toEndpointKey(stage)]; if (!endpoint) throw Object.assign(new Error(toEndpointKey(stage) + ' is not configured'), { retryable: false });
  let effectivePayload = payload || {};
  if (stage === 'render' && process.env.FORGE_REQUIRE_CAPTIONS !== 'false') {
    const captions = await repository.db.pool.query("SELECT id,version_id,kind,content_hash,media_type,metadata FROM artifacts WHERE episode_id=$1 AND kind='caption' ORDER BY created_at DESC,id ASC", [payload.episodeId]);
    if (!captions.rows.length) throw Object.assign(new Error('Render blocked: no immutable caption artifacts are available'), { retryable: false, code: 'CAPTIONS_REQUIRED' });
    effectivePayload = { ...effectivePayload, captions: captions.rows.map((artifact) => ({ id: artifact.id, versionId: artifact.version_id, kind: artifact.kind, contentHash: artifact.content_hash, mediaType: artifact.media_type, metadata: artifact.metadata })) };
  }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  try {
    const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.FORGE_STAGE_PROVIDER_TOKEN ? { authorization: 'Bearer ' + process.env.FORGE_STAGE_PROVIDER_TOKEN } : {}) }, body: JSON.stringify({ contractVersion: 'forge-stage-v1', stage: stage.toUpperCase(), capability: CAPABILITIES[stage], payload: effectivePayload, job: { id: job?.id, attempts: job?.attempts } }), signal: controller.signal });
    const text = await response.text(); let body; try { body = text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('Stage ' + stage + ' provider returned invalid JSON'), { retryable: response.status >= 500 }); }
    if (!response.ok) throw Object.assign(new Error('Stage ' + stage + ' provider returned HTTP ' + response.status), { retryable: response.status === 408 || response.status === 429 || response.status >= 500, status: response.status });
    const artifact = body.artifact || body; const hasInline = artifact?.content != null; const hasBinary = typeof artifact?.contentBase64 === 'string';
    if (!artifact || (!hasInline && !hasBinary)) throw Object.assign(new Error('Stage ' + stage + ' response must include artifact.content or artifact.contentBase64; storageUri is not a trusted input'), { retryable: false });
    const episodeId = payload.episodeId; const episode = await repository.db.getEpisode(episodeId); if (!episode) throw Object.assign(new Error('Episode not found: ' + episodeId), { retryable: false });
    const versionId = artifact.versionId || stage + ':' + randomUUID(); const artifactId = artifact.id || randomUUID(); const kind = VERSION_KINDS[stage];
    if (hasBinary && !storageService) throw Object.assign(new Error('Binary artifact requires configured artifact storage'), { retryable: false });
    if (hasBinary) {
      const binary = Buffer.from(artifact.contentBase64, 'base64');
      await storageService.putArtifact({ episodeId, projectId: episode.project_id || episode.projectId, versionId, artifactId, kind: stage === 'narration' ? 'audio' : stage === 'assets' ? 'image' : kind === 'render' ? 'render' : kind === 'qa' ? 'package' : 'package', content: binary, contentType: artifact.mediaType || 'application/octet-stream', expectedSha256: artifact.contentHash, inputVersionIds: artifact.inputVersionIds || [], metadata: { ...(artifact.metadata || {}), stage: stage.toUpperCase(), provider: body.provider || null, captionArtifactIds: stage === 'render' ? (effectivePayload.captions || []).map((item) => item.id) : undefined }, createdBy: payload.actor || 'worker' });
    } else {
      await repository.db.withTransaction(async (client) => {
        const existingVersion = await client.query('SELECT id, episode_id, kind FROM version_records WHERE id=$1', [versionId]);
        if (!existingVersion.rows[0]) await client.query('INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6)', [versionId, episodeId, kind, JSON.stringify(artifact.content), artifact.contentHash || null, payload.actor || 'worker']);
        else if (existingVersion.rows[0].episode_id !== episodeId || existingVersion.rows[0].kind !== kind) throw Object.assign(new Error('Provider version identity conflicts with episode or stage'), { retryable: false });
        await client.query(`INSERT INTO artifacts(id,episode_id,kind,version_id,storage_uri,content_json,content_hash,media_type,source,input_version_ids,metadata,created_by) VALUES($1,$2,$3,$4,NULL,$5::jsonb,$6,$7,'provider',$8::jsonb,$9::jsonb,$10) ON CONFLICT (id) DO NOTHING`, [artifactId, episodeId, kind, versionId, JSON.stringify(artifact.content), artifact.contentHash || null, artifact.mediaType || null, JSON.stringify(artifact.inputVersionIds || []), JSON.stringify({ ...(artifact.metadata || {}), stage: stage.toUpperCase(), provider: body.provider || null, captionArtifactIds: stage === 'render' ? (effectivePayload.captions || []).map((item) => item.id) : undefined }), payload.actor || 'worker']);
      });
    }
    logger.log?.('Forge stage ' + stage + ' completed for episode ' + episodeId); return { stage: stage.toUpperCase(), episodeId, versionId, artifactId, metadata: body.metadata || {} };
  } catch (error) { if (error.name === 'AbortError') throw Object.assign(new Error('Stage ' + stage + ' timed out after ' + timeoutMs + 'ms'), { retryable: true }); throw error; } finally { clearTimeout(timer); }
}
module.exports = { createHttpWorkflowHandlers, executeStage, STAGES, CAPABILITIES };
