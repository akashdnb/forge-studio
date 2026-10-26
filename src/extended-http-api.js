const { createApiServer: createBaseApiServer } = require('./http-api');
const { AsyncEpisodeOrchestrator } = require('./pipeline/async-orchestrator');
const { validateResearchPackage, validateTimeline, validatePublishRequest, buildHandoffEnvelope } = require('./pipeline/production-contracts');
const { createShortsHandoff } = require('./derivatives/shorts-handoff');
const { randomUUID, timingSafeEqual, createHash } = require('node:crypto');
const { URL } = require('node:url');

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('Request body exceeds 1 MiB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Malformed JSON request body'), { statusCode: 400 }); }
}
function tokenMatches(expected, actual) {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(expected); const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
function authorize(req, { apiToken, allowUnauthenticatedRead }) {
  const method = req.method || 'GET';
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (method === 'GET' && ['/healthz', '/readyz', '/openapi.json'].includes(pathname)) return true;
  if (!apiToken) return allowUnauthenticatedRead && method === 'GET';
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return Boolean(match && tokenMatches(apiToken, match[1]));
}
function mapError(error) {
  const status = error.statusCode || (error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : ['CONFLICT','REVISION_CONFLICT','STATE_CONFLICT','QA_BLOCKED'].includes(error.code) ? 409 : error instanceof TypeError ? 400 : 422);
  return { status, body: { error: { code: error.code || 'INVALID_REQUEST', message: error.message } } };
}
function idempotencyHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createExtendedApiServer({
  repository = null,
  apiToken = process.env.API_BEARER_TOKEN || null,
  allowUnauthenticatedRead = process.env.ALLOW_UNAUTHENTICATED_READS === 'true',
  ...options
} = {}) {
  const base = createBaseApiServer({ repository, apiToken, allowUnauthenticatedRead, ...options });
  const baseHandler = base.server.listeners('request')[0];
  base.server.removeAllListeners('request');
  const orchestrator = repository ? new AsyncEpisodeOrchestrator({ pool: repository.db.pool }) : null;

  async function assertEpisodeAccess(episode, actor, method) {
    const membership = await repository.db.pool.query('SELECT role FROM project_members WHERE project_id=$1 AND actor_id=$2', [episode.project_id, actor]);
    const role = membership.rows[0]?.role || (episode.created_by === actor ? 'OWNER' : null);
    if (!role) throw Object.assign(new Error('Project access denied'), { code: 'FORBIDDEN' });
    if (['POST','PUT','PATCH','DELETE'].includes(method) && role === 'VIEWER') {
      throw Object.assign(new Error('Viewer access is read-only'), { code: 'FORBIDDEN' });
    }
    return role;
  }
  async function assertProjectAccess(projectId, actor, method) {
    if (!projectId) throw Object.assign(new Error('projectId is required'), { code: 'FORBIDDEN' });
    const r = await repository.db.pool.query(
      'SELECT p.created_by,m.role FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$2 WHERE p.id=$1',
      [projectId, actor],
    );
    const role = r.rows[0]?.role || (r.rows[0]?.created_by === actor ? 'OWNER' : null);
    if (!role) throw Object.assign(new Error('Project access denied'), { code: 'FORBIDDEN' });
    if (['POST','PUT','PATCH','DELETE'].includes(method) && role === 'VIEWER') {
      throw Object.assign(new Error('Viewer access is read-only'), { code: 'FORBIDDEN' });
    }
    return role;
  }

  async function storeIdempotentResponse(client, key, actor, requestHash, status, body) {
    if (!key) return;
    await client.query(
      'UPDATE forge_idempotency_keys SET response_status=$1,response_body=$2::jsonb WHERE key=$3 AND actor=$4 AND request_hash=$5',
      [status, JSON.stringify(body), key, actor, requestHash],
    );
  }

  async function reserveIdempotency(client, { key, actor, requestHash }) {
    if (!key) return null;
    await client.query('DELETE FROM forge_idempotency_keys WHERE expires_at < now()');
    const existing = await client.query('SELECT * FROM forge_idempotency_keys WHERE key=$1 FOR UPDATE', [key]);
    if (existing.rows[0]) {
      if (existing.rows[0].actor !== actor || existing.rows[0].request_hash !== requestHash) {
        throw Object.assign(new Error('Idempotency-Key was already used with a different actor or request'), { code: 'CONFLICT' });
      }
      if (existing.rows[0].response_status == null) throw Object.assign(new Error('An identical request is already in progress'), { code: 'CONFLICT' });
      return { status: existing.rows[0].response_status, body: existing.rows[0].response_body, replay: true };
    }
    await client.query(
      'INSERT INTO forge_idempotency_keys(key,actor,request_hash,expires_at) VALUES($1,$2,$3,now()+interval \'24 hours\')',
      [key, actor, requestHash],
    );
    return { replay: false };
  }

  async function handler(req, res) {
    const requestId = req.headers['x-request-id'] || randomUUID();
    res.setHeader('x-request-id', requestId);
    if (!authorize(req, { apiToken, allowUnauthenticatedRead })) {
      return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' }, requestId });
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.split('/').filter(Boolean);
    try {
      if (!repository) return baseHandler(req, res);
      const actor = req.headers['x-actor-id'] || 'api';

      if (req.method === 'GET' && url.pathname === '/v1/projects') {
        const r = await repository.db.pool.query(
          'SELECT p.* FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$1 WHERE m.actor_id IS NOT NULL OR p.created_by=$1 ORDER BY p.updated_at DESC',
          [actor],
        );
        return send(res, 200, { items: r.rows });
      }

      if (req.method === 'POST' && url.pathname === '/v1/projects') {
        const body = await readJson(req);
        if (!String(body.name || '').trim()) throw new TypeError('Project name is required');
        const id = body.id || randomUUID();
        const result = await repository.db.withTransaction(async (client) => {
          const created = await client.query(
            'INSERT INTO projects(id,name,created_by,metadata) VALUES($1,$2,$3,$4::jsonb) RETURNING *',
            [id, String(body.name).trim(), actor, JSON.stringify(body.metadata || {})],
          );
          await client.query("INSERT INTO project_members(project_id,actor_id,role) VALUES($1,$2,'OWNER')", [id, actor]);
          return created.rows[0];
        });
        return send(res, 201, { item: result });
      }

      if (req.method === 'GET' && url.pathname === '/v1/episodes') {
        const projectId = url.searchParams.get('projectId');
        if (projectId) await assertProjectAccess(projectId, actor, 'GET');
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        const r = projectId
          ? await repository.db.pool.query('SELECT * FROM episodes WHERE project_id=$1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3', [projectId, limit, offset])
          : await repository.db.pool.query(
            'SELECT e.* FROM episodes e LEFT JOIN project_members m ON m.project_id=e.project_id AND m.actor_id=$1 WHERE m.actor_id IS NOT NULL OR e.created_by=$1 ORDER BY e.updated_at DESC LIMIT $2 OFFSET $3',
            [actor, limit, offset],
          );
        return send(res, 200, { items: r.rows });
      }

      if (req.method === 'POST' && url.pathname === '/v1/episodes') {
        const body = await readJson(req);
        await assertProjectAccess(body.projectId, actor, 'POST');
        const created = await repository.db.createEpisode({ ...body, createdBy: actor });
        return send(res, 201, { item: created });
      }

      if (path[0] === 'v1' && path[1] === 'jobs' && req.method === 'GET') {
        const queue = orchestrator.queue;
        if (path[2]) {
          const job = await queue.get(decodeURIComponent(path[2]));
          if (!job) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Job not found' }, requestId });
          if (job.project_id) await assertProjectAccess(job.project_id, actor, 'GET');
          if (job.episode_id) {
            const e = await repository.db.getEpisode(job.episode_id);
            if (e) await assertEpisodeAccess({ project_id: e.projectId, created_by: e.createdBy }, actor, 'GET');
          }
          return send(res, 200, { item: job });
        }
        const items = await queue.list({
          projectId: url.searchParams.get('projectId') || null,
          episodeId: url.searchParams.get('episodeId') || null,
          status: url.searchParams.get('status') || null,
          limit: Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50))),
        });
        const visible = [];
        for (const job of items) {
          if (job.project_id) {
            try { await assertProjectAccess(job.project_id, actor, 'GET'); } catch { continue; }
          }
          visible.push(job);
        }
        return send(res, 200, { items: visible });
      }

      if (path[0] === 'v1' && path[1] === 'versions' && path[2] && path[3] === 'invalidation-plan' && req.method === 'POST') {
        const versionId = decodeURIComponent(path[2]);
        const vr = await repository.db.pool.query('SELECT e.* FROM version_records v JOIN episodes e ON e.id=v.episode_id WHERE v.id=$1', [versionId]);
        if (!vr.rows[0]) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Version not found' }, requestId });
        await assertEpisodeAccess(vr.rows[0], actor, 'POST');
        const body = await readJson(req);
        const ids = Array.isArray(body.changedVersionIds) && body.changedVersionIds.length ? body.changedVersionIds : [versionId];
        const plans = await Promise.all(ids.map((id) => repository.db.invalidationPlan(id)));
        const merged = [...new Map(plans.flat().map((item) => [item.id, item])).values()];
        return send(res, 200, { items: merged });
      }

      if (path[0] === 'v1' && path[1] === 'episodes' && path[2]) {
        const episodeId = decodeURIComponent(path[2]);
        const episodeResult = await repository.db.pool.query('SELECT * FROM episodes WHERE id=$1', [episodeId]);
        if (!episodeResult.rows[0]) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Episode not found' }, requestId });
        const episode = episodeResult.rows[0];
        await assertEpisodeAccess(episode, actor, req.method);

        if (path[3] === 'workflow' && req.method === 'POST') {
          const body = await readJson(req);
          if (body.stages !== undefined && !Array.isArray(body.stages)) throw new TypeError('stages must be an array');
          const stages = body.stages;
          const result = await orchestrator.enqueue({ episodeId, projectId: episode.project_id, brief: body.brief || episode.description, stages, actor });
          return send(res, 202, result);
        }

        if (path[3] === 'research' && req.method === 'POST') {
          const raw = await readJson(req);
          const body = validateResearchPackage(raw);
          const versionId = raw.versionId || `research:${randomUUID()}`;
          const packageId = raw.packageId || randomUUID();
          const packageStatus = raw.status || body.status;
          const notes = raw.notes == null ? body.notes : String(raw.notes);
          const key = req.headers['idempotency-key'] || null;
          const requestHash = idempotencyHash({ episodeId, body, packageStatus, notes });
          const result = await repository.db.withTransaction(async (client) => {
            const reserved = await reserveIdempotency(client, { key, actor, requestHash });
            if (reserved?.replay) return { status: reserved.status, body: reserved.body, replay: true };
            await client.query("INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'research',$3::jsonb,$4,$5)", [versionId, episodeId, JSON.stringify(body), body.hash, actor]);
            await client.query('INSERT INTO research_packages(id,episode_id,version_id,status,notes,created_by) VALUES($1,$2,$3,$4,$5,$6)', [packageId, episodeId, versionId, packageStatus, notes, actor]);
            for (const source of body.sources) await client.query('INSERT INTO research_sources(id,package_id,url,title,publisher,published_at,content_hash,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [source.id, packageId, source.url, source.title, source.publisher, source.publishedAt, source.contentHash, JSON.stringify(source.metadata)]);
            for (const claim of body.claims) await client.query('INSERT INTO research_claims(id,package_id,claim,status,source_ids,metadata) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [claim.id, packageId, claim.claim, claim.status, JSON.stringify(claim.sourceIds), JSON.stringify(claim.metadata)]);
            const responseBody = { item: { id: packageId, episode_id: episodeId, version_id: versionId, status: packageStatus, notes, hash: body.hash } };
            await storeIdempotentResponse(client, key, actor, requestHash, 201, responseBody);
            return { status: 201, body: responseBody, replay: false };
          });
          return send(res, result.status, result.body);
        }

        if (path[3] === 'research' && req.method === 'GET') {
          const r = await repository.db.pool.query('SELECT * FROM research_packages WHERE episode_id=$1 ORDER BY created_at DESC', [episodeId]);
          return send(res, 200, { items: r.rows });
        }

        if (path[3] === 'timeline' && req.method === 'POST') {
          const raw = await readJson(req);
          const input = validateTimeline(raw);
          const versionId = input.versionId || `timeline:${randomUUID()}`;
          const id = input.id || randomUUID();
          const result = await repository.db.withTransaction(async (client) => {
            await client.query("INSERT INTO version_records(id,episode_id,kind,payload,content_hash,created_by) VALUES($1,$2,'timeline',$3::jsonb,$4,$5)", [versionId, episodeId, JSON.stringify(input.timeline), input.contentHash, actor]);
            await client.query('INSERT INTO timeline_snapshots(id,episode_id,version_id,timeline,duration_seconds,content_hash,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)', [id, episodeId, versionId, JSON.stringify(input.timeline), input.durationSeconds, input.contentHash, actor]);
            return { id, episodeId, versionId, durationSeconds: input.durationSeconds, contentHash: input.contentHash };
          });
          return send(res, 201, { item: result });
        }

        if (path[3] === 'timeline' && req.method === 'GET') {
          const r = await repository.db.pool.query('SELECT * FROM timeline_snapshots WHERE episode_id=$1 ORDER BY created_at DESC', [episodeId]);
          return send(res, 200, { items: r.rows });
        }

        if (path[3] === 'publish' && req.method === 'POST') {
          const body = await readJson(req);
          const renderId = body.renderArtifactId || episode.approved_render_id;
          const renderResult = await repository.db.pool.query("SELECT * FROM artifacts WHERE id=$1 AND episode_id=$2 AND kind='render'", [renderId, episodeId]);
          if (!renderResult.rows[0]) throw Object.assign(new Error('Approved render artifact not found'), { code: 'NOT_FOUND' });
          const render = renderResult.rows[0];
          const qa = await repository.db.pool.query("SELECT status FROM qa_results WHERE artifact_id=$1 AND version_id=$2 ORDER BY created_at DESC LIMIT 1", [renderId, render.version_id]);
          const validated = validatePublishRequest({ episode: { state: episode.state, approvedRenderId: episode.approved_render_id }, renderArtifact: { id: renderId }, qaStatus: qa.rows[0]?.status, metadata: body.metadata || {} });
          const idempotencyKey = String(body.idempotencyKey || req.headers['idempotency-key'] || `publish:${episodeId}:${renderId}:${validated.destination}`);
          const runId = randomUUID();
          const result = await repository.db.withTransaction(async (client) => {
            const existing = await client.query('SELECT * FROM publish_runs WHERE idempotency_key=$1 FOR UPDATE', [idempotencyKey]);
            if (existing.rows[0]) return { run: existing.rows[0], existing: true };
            const locked = await client.query('SELECT * FROM episodes WHERE id=$1 FOR UPDATE', [episodeId]);
            const current = locked.rows[0];
            if (!current || current.state !== 'APPROVED' || current.approved_render_id !== renderId) throw Object.assign(new Error('Episode approval changed; re-check the approved render before publishing'), { code: 'STATE_CONFLICT' });
            const inserted = await client.query('INSERT INTO publish_runs(id,episode_id,render_artifact_id,render_version_id,destination,metadata,idempotency_key,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *', [runId, episodeId, renderId, render.version_id, validated.destination, JSON.stringify(validated.metadata), idempotencyKey, actor]);
            await client.query("UPDATE episodes SET state='PUBLISHING',revision=revision+1,updated_at=now() WHERE id=$1", [episodeId]);
            const jobId = randomUUID();
            const job = await client.query('INSERT INTO forge_jobs(id,project_id,episode_id,kind,payload,idempotency_key,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *', [jobId, current.project_id, episodeId, 'publish:youtube', JSON.stringify({ publishRunId: runId }), `publish-job:${runId}`, actor]);
            return { run: inserted.rows[0], job: job.rows[0], existing: false };
          });
          return send(res, result.existing ? 200 : 202, { item: result.run, ...(result.job ? { job: result.job } : {}) });
        }

        if (path[3] === 'publish' && req.method === 'GET') {
          const r = await repository.db.pool.query('SELECT * FROM publish_runs WHERE episode_id=$1 ORDER BY created_at DESC', [episodeId]);
          return send(res, 200, { items: r.rows });
        }

        if (path[3] === 'shorts' && path[4] === 'handoff' && req.method === 'POST') {
          if (!['APPROVED', 'PUBLISHED'].includes(episode.state)) throw new Error('Only an approved/published episode can be handed off to Shorts');
          const body = await readJson(req);
          const renderResult = await repository.db.pool.query('SELECT * FROM artifacts WHERE id=$1 AND episode_id=$2', [episode.approved_render_id, episodeId]);
          if (!renderResult.rows[0]) throw Object.assign(new Error('Approved render artifact not found'), { code: 'NOT_FOUND' });
          const rows = await repository.db.pool.query("SELECT * FROM artifacts WHERE episode_id=$1 AND kind IN ('script','scene-plan','caption') ORDER BY created_at DESC", [episodeId]);
          const latest = (kind) => rows.rows.find((row) => row.kind === kind) || null;
          const manifest = createShortsHandoff({ episode: { id: episode.id, projectId: episode.project_id, title: episode.title, state: episode.state, approvedRenderId: episode.approved_render_id }, renderArtifact: { id: renderResult.rows[0].id, episodeId, versionId: renderResult.rows[0].version_id, storageUri: renderResult.rows[0].storage_uri, contentHash: renderResult.rows[0].content_hash, content: renderResult.rows[0].content_json }, scriptArtifact: latest('script'), scenePlanArtifact: latest('scene-plan'), captionsArtifact: latest('caption'), candidateSegments: body.candidateSegments || [] });
          return send(res, 200, { item: buildHandoffEnvelope(manifest) });
        }

        return baseHandler(req, res);
      }

      return baseHandler(req, res);
    } catch (error) {
      const mapped = mapError(error);
      return send(res, mapped.status, { ...mapped.body, requestId });
    }
  }

  base.server.on('request', handler);
  return { server: base.server, service: base.service, repository };
}
module.exports = { createExtendedApiServer };
