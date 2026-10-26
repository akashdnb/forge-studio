const { createApiServer: createBaseApiServer } = require('./http-api');
const { AsyncEpisodeOrchestrator } = require('./pipeline/async-orchestrator');
const { validateResearchPackage, validateTimeline, validatePublishRequest, buildHandoffEnvelope } = require('./pipeline/production-contracts');
const { createShortsHandoff } = require('./derivatives/shorts-handoff');
const { randomUUID } = require('node:crypto');
const { URL } = require('node:url');

const JSON_LIMIT_BYTES = 1024 * 1024;
function send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > JSON_LIMIT_BYTES) throw Object.assign(new Error('Request body exceeds 1 MiB'), { statusCode: 413 }); chunks.push(chunk); }
  if (!size) return {};
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error('Malformed JSON request body'), { statusCode: 400 }); }
}
function mapError(error) { return { status: error.statusCode || (error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : error instanceof TypeError ? 400 : 422), body: { error: { code: error.code || 'INVALID_REQUEST', message: error.message } } }; }

function createExtendedApiServer({ repository = null, ...options } = {}) {
  const base = createBaseApiServer({ repository, ...options });
  const baseHandler = base.server.listeners('request')[0];
  base.server.removeAllListeners('request');
  const orchestrator = repository ? new AsyncEpisodeOrchestrator({ pool: repository.db.pool }) : null;

  async function handler(req, res) {
    const requestId = req.headers['x-request-id'] || randomUUID(); res.setHeader('x-request-id', requestId);
    const url = new URL(req.url || '/', 'http://localhost'); const path = url.pathname.split('/').filter(Boolean);
    try {
      if (!repository) return baseHandler(req, res);
      const actor = req.headers['x-actor-id'] || 'api';
      if (req.method === 'GET' && url.pathname === '/v1/projects') {
        const r = await repository.db.pool.query('SELECT p.* FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$1 WHERE m.actor_id IS NOT NULL OR p.created_by=$1 ORDER BY p.updated_at DESC', [actor]);
        return send(res, 200, { items: r.rows });
      }
      if (req.method === 'POST' && url.pathname === '/v1/projects') {
        const body = await readJson(req); const id = body.id || randomUUID(); const project = await repository.createProject({ id, name: body.name, createdBy: actor, metadata: body.metadata || {} });
        await repository.db.pool.query("INSERT INTO project_members(project_id,actor_id,role) VALUES($1,$2,'OWNER') ON CONFLICT DO NOTHING", [id, actor]); return send(res, 201, { item: project });
      }
      if (path[0] === 'v1' && path[1] === 'jobs' && req.method === 'GET') {
        const queue = orchestrator.queue; if (path[2]) { const job = await queue.get(decodeURIComponent(path[2])); return job ? send(res, 200, { item: job }) : send(res, 404, { error: { code: 'NOT_FOUND', message: 'Job not found' } }); }
        return send(res, 200, { items: await queue.list({ episodeId: url.searchParams.get('episodeId') || null, status: url.searchParams.get('status') || null, limit: Number(url.searchParams.get('limit') || 50) }) });
      }
      if (path[0] === 'v1' && path[1] === 'episodes' && path[2]) {
        const episodeId = decodeURIComponent(path[2]); const episodeResult = await repository.db.pool.query('SELECT * FROM episodes WHERE id=$1', [episodeId]);
        if (!episodeResult.rows[0]) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Episode not found' } });
        const episode = episodeResult.rows[0];
        if (path[3] === 'workflow' && req.method === 'POST') {
          const body = await readJson(req); return send(res, 202, await orchestrator.enqueue({ episodeId, projectId: episode.project_id, brief: body.brief || episode.description, stages: body.stages, actor }));
        }
        if (path[3] === 'research' && req.method === 'POST') {
          const body = validateResearchPackage(await readJson(req)); const versionId = body.versionId || `research:${randomUUID()}`; const packageId = body.packageId || randomUUID();
          const result = await repository.db.withTransaction(async (client) => {
            await client.query("INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'research',$3::jsonb,$4,$5)", [versionId, episodeId, JSON.stringify(body), body.hash, actor]);
            await client.query('INSERT INTO research_packages(id,episode_id,version_id,status,notes,created_by) VALUES($1,$2,$3,$4,$5,$6)', [packageId, episodeId, versionId, body.status || 'DRAFT', body.notes || '', actor]);
            for (const source of body.sources) await client.query('INSERT INTO research_sources(id,package_id,url,title,publisher,published_at,content_hash,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [source.id, packageId, source.url, source.title || '', source.publisher || '', source.publishedAt || null, source.contentHash || null, JSON.stringify(source.metadata || {})]);
            for (const claim of body.claims) await client.query('INSERT INTO research_claims(id,package_id,claim,status,source_ids,metadata) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [claim.id, packageId, claim.claim, claim.status || 'DISCOVERED', JSON.stringify(claim.sourceIds || []), JSON.stringify(claim.metadata || {})]);
            return { id: packageId, episodeId, versionId, status: body.status || 'DRAFT', hash: body.hash };
          }); return send(res, 201, { item: result });
        }
        if (path[3] === 'research' && req.method === 'GET') { const r = await repository.db.pool.query('SELECT * FROM research_packages WHERE episode_id=$1 ORDER BY created_at DESC', [episodeId]); return send(res, 200, { items: r.rows }); }
        if (path[3] === 'timeline' && req.method === 'POST') {
          const input = validateTimeline(await readJson(req)); const versionId = input.versionId || `timeline:${randomUUID()}`; const id = input.id || randomUUID();
          const result = await repository.db.withTransaction(async (client) => {
            await client.query("INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'timeline',$3::jsonb,$4,$5)", [versionId, episodeId, JSON.stringify(input.timeline), input.contentHash, actor]);
            await client.query('INSERT INTO timeline_snapshots(id,episode_id,version_id,timeline,duration_seconds,content_hash,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)', [id, episodeId, versionId, JSON.stringify(input.timeline), input.durationSeconds, input.contentHash, actor]);
            return { id, episodeId, versionId, durationSeconds: input.durationSeconds, contentHash: input.contentHash };
          }); return send(res, 201, { item: result });
        }
        if (path[3] === 'timeline' && req.method === 'GET') { const r = await repository.db.pool.query('SELECT * FROM timeline_snapshots WHERE episode_id=$1 ORDER BY created_at DESC', [episodeId]); return send(res, 200, { items: r.rows }); }
        if (path[3] === 'publish' && req.method === 'POST') {
          const body = await readJson(req); const renderId = body.renderArtifactId || episode.approved_render_id;
          const renderResult = await repository.db.pool.query("SELECT * FROM artifacts WHERE id=$1 AND episode_id=$2 AND kind='render'", [renderId, episodeId]); if (!renderResult.rows[0]) throw Object.assign(new Error('Approved render artifact not found'), { code: 'NOT_FOUND' });
          const qa = await repository.db.pool.query('SELECT status FROM qa_results WHERE artifact_id=$1 AND version_id=$2 ORDER BY created_at DESC LIMIT 1', [renderId, renderResult.rows[0].version_id]);
          const validated = validatePublishRequest({ episode: { state: episode.state, approvedRenderId: episode.approved_render_id }, renderArtifact: { id: renderId }, qaStatus: qa.rows[0]?.status, metadata: body.metadata || {} });
          const idempotencyKey = body.idempotencyKey || `publish:${episodeId}:${renderId}:${validated.destination}`; const existing = await repository.db.pool.query('SELECT * FROM publish_runs WHERE idempotency_key=$1', [idempotencyKey]); if (existing.rows[0]) return send(res, 200, { item: existing.rows[0] });
          const runId = randomUUID(); if (episode.state === 'APPROVED') await repository.transitionEpisode({ id: episodeId, nextState: 'PUBLISHING', actor });
          const inserted = await repository.db.pool.query('INSERT INTO publish_runs(id,episode_id,render_artifact_id,render_version_id,destination,metadata,idempotency_key,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *', [runId, episodeId, renderId, renderResult.rows[0].version_id, validated.destination, JSON.stringify(validated.metadata), idempotencyKey, actor]);
          const job = await orchestrator.queue.enqueue({ episodeId, projectId: episode.project_id, kind: `publish:${validated.destination}`, payload: { publishRunId: runId }, idempotencyKey: `publish-job:${runId}`, createdBy: actor }); return send(res, 202, { item: inserted.rows[0], job });
        }
        if (path[3] === 'publish' && req.method === 'GET') { const r = await repository.db.pool.query('SELECT * FROM publish_runs WHERE episode_id=$1 ORDER BY created_at DESC', [episodeId]); return send(res, 200, { items: r.rows }); }
        if (path[3] === 'shorts' && path[4] === 'handoff' && req.method === 'POST') {
          if (!['APPROVED', 'PUBLISHED'].includes(episode.state)) throw new Error('Only an approved/published episode can be handed off to Shorts');
          const body = await readJson(req); const renderResult = await repository.db.pool.query('SELECT * FROM artifacts WHERE id=$1 AND episode_id=$2', [episode.approved_render_id, episodeId]); if (!renderResult.rows[0]) throw Object.assign(new Error('Approved render artifact not found'), { code: 'NOT_FOUND' });
          const rows = await repository.db.pool.query("SELECT * FROM artifacts WHERE episode_id=$1 AND kind IN ('script','scene-plan','caption') ORDER BY created_at DESC", [episodeId]); const latest = (kind) => rows.rows.find((row) => row.kind === kind) || null;
          const manifest = createShortsHandoff({ episode: { id: episode.id, projectId: episode.project_id, title: episode.title, state: episode.state, approvedRenderId: episode.approved_render_id }, renderArtifact: { id: renderResult.rows[0].id, episodeId, versionId: renderResult.rows[0].version_id, storageUri: renderResult.rows[0].storage_uri, contentHash: renderResult.rows[0].content_hash, content: renderResult.rows[0].content_json }, scriptArtifact: latest('script'), scenePlanArtifact: latest('scene-plan'), captionsArtifact: latest('caption'), candidateSegments: body.candidateSegments || [] });
          return send(res, 200, { item: buildHandoffEnvelope(manifest) });
        }
      }
      return baseHandler(req, res);
    } catch (error) { const mapped = mapError(error); return send(res, mapped.status, { ...mapped.body, requestId }); }
  }
  base.server.on('request', handler); return { server: base.server, service: base.service, repository };
}
module.exports = { createExtendedApiServer };
