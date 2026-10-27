const http = require('node:http');
const { URL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { authenticate, hasRole } = require('../security/http-security');

const MAX_PAGE_SIZE = 100;
const MAX_BULK = 25;
const DANGEROUS = new Set(['cancel', 'retry', 'requeue', 'fence', 'recover', 'reconcile', 'quarantine', 'disable', 'enable']);
const EXTERNAL_SIDE_EFFECT_KINDS = /(^|:)(publish|youtube|shorts|handoff)(:|$)/i;
const SAFE_JOB_STATUSES = new Set(['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED']);

function json(res, status, body, requestId) {
  if (res.headersSent) return;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-request-id', requestId);
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

async function readBody(req, max = 256 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Object.assign(new Error('Request body exceeds limit'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Malformed JSON request body'), { statusCode: 400, code: 'VALIDATION_ERROR' }); }
}

function boundedInt(value, fallback, max = MAX_PAGE_SIZE) {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw Object.assign(new Error(`value must be an integer between 0 and ${max}`), { code: 'VALIDATION_ERROR', statusCode: 400 });
  return n;
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function stableBody(body) { return JSON.stringify(body, Object.keys(body).sort()); }

function installOperationsControlPlane({
  pg = null,
  apiToken = process.env.API_BEARER_TOKEN || null,
  authSecret = process.env.FORGE_AUTH_SIGNING_SECRET || null,
  staticActor = process.env.FORGE_STATIC_ACTOR_ID || null,
  staticTenant = process.env.FORGE_STATIC_TENANT_ID || null,
  logger = console,
} = {}) {
  if (http.Server.prototype.__forgeOperationsControlPlane) return;
  http.Server.prototype.__forgeOperationsControlPlane = true;
  const originalEmit = http.Server.prototype.emit;
  let pool = pg;

  async function getPool() {
    if (pool) return pool;
    if (!process.env.DATABASE_URL) return null;
    let Pool;
    try { ({ Pool } = require('pg')); } catch { return null; }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.FORGE_OPS_PG_POOL_MAX || '5', 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    return pool;
  }

  http.Server.prototype.emit = function emit(event, request, response) {
    if (event !== 'request' || !request || !response) return originalEmit.apply(this, arguments);
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/v1/ops')) return originalEmit.apply(this, arguments);
    void handle(request, response).catch((error) => {
      const requestId = request.headers['x-request-id'] || randomUUID();
      logger.error?.({ event: 'ops.request_failed', requestId, code: error.code, message: error.message });
      json(response, Number.isInteger(error.statusCode) ? error.statusCode : 500, { error: { code: error.code || 'INTERNAL_ERROR', message: safeMessage(error) }, requestId }, requestId);
    });
    return true;
  };

  async function handle(req, res) {
    const requestId = req.headers['x-request-id'] || randomUUID();
    const url = new URL(req.url || '/', 'http://localhost');
    const db = await getPool();
    if (!db) return json(res, 503, { error: { code: 'PERSISTENCE_UNAVAILABLE', message: 'Operations control plane requires PostgreSQL' }, requestId }, requestId);

    const auth = authenticate(req, { apiToken, authSecret, staticActor, staticTenant });
    if (!auth || !hasRole(auth, 'OWNER')) return json(res, auth ? 403 : 401, { error: { code: auth ? 'FORBIDDEN' : 'UNAUTHORIZED', message: auth ? 'Operations control requires OWNER role' : 'Authentication required' }, requestId }, requestId);
    if (auth.kind === 'public') return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Operations control requires an operator identity' }, requestId }, requestId);

    const route = url.pathname.replace(/^\/v1\/ops\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (req.method === 'GET' && route[0] === 'health') return health(db, res, requestId);
    if (req.method === 'GET' && route[0] === 'incidents') return incidents(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'search') return search(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'jobs') return listJobs(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'jobs' && route[1]) return getJob(db, auth, route[1], res, requestId);
    if (req.method === 'GET' && route[0] === 'projects') return listProjects(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'episodes') return listEpisodes(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'versions') return listVersions(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'artifacts') return listArtifacts(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'workers') return listWorkers(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'providers') return listProviders(db, auth, url, res, requestId);
    if (req.method === 'GET' && route[0] === 'audit') return listAudit(db, auth, url, res, requestId);
    if (req.method === 'POST' && route[0] === 'bulk' && route[1] === 'preview') return bulkPreview(db, auth, req, res, requestId);
    if (req.method === 'POST' && route[0] === 'bulk' && route[1] === 'execute') return bulkExecute(db, auth, req, res, requestId);
    if (req.method === 'POST' && route[0] === 'actions' && route[1]) return action(db, auth, route[1], req, res, requestId);
    return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Operations route not found' }, requestId }, requestId);
  }

  async function tenantProject(db, auth, projectId) {
    const r = await db.query('SELECT id, tenant_id, created_by FROM projects WHERE id=$1', [projectId]);
    const p = r.rows[0];
    if (!p || p.tenant_id !== auth.tenantId) return null;
    const m = await db.query('SELECT role FROM project_members WHERE project_id=$1 AND actor_id=$2 AND tenant_id=$3', [projectId, auth.actor, auth.tenantId]);
    if (!m.rows[0] && p.created_by !== auth.actor) return null;
    return p;
  }

  async function resolveProject(db, auth, type, id) {
    if (type === 'project') return tenantProject(db, auth, id);
    const queries = {
      episode: 'SELECT project_id FROM episodes WHERE id=$1',
      version: 'SELECT e.project_id FROM version_records v JOIN episodes e ON e.id=v.episode_id WHERE v.id=$1',
      artifact: 'SELECT e.project_id FROM artifacts a JOIN episodes e ON e.id=a.episode_id WHERE a.id=$1',
      job: 'SELECT project_id FROM forge_jobs WHERE id=$1',
    };
    const q = queries[type];
    if (!q) return null;
    const r = await db.query(q, [id]);
    return r.rows[0]?.project_id ? tenantProject(db, auth, r.rows[0].project_id) : null;
  }

  async function requireReason(body) {
    if (!body || typeof body.reason !== 'string' || body.reason.trim().length < 8 || body.reason.length > 1000) throw Object.assign(new Error('A reason of 8..1000 characters is required'), { code: 'REASON_REQUIRED', statusCode: 400 });
    if (!body.idempotencyKey || typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length > 200) throw Object.assign(new Error('idempotencyKey is required'), { code: 'IDEMPOTENCY_REQUIRED', statusCode: 400 });
  }

  async function audit(db, auth, requestId, actionName, targetType, targetId, projectId, outcome, details) {
    await db.query(`INSERT INTO security_audit_events(tenant_id,project_id,actor,action,target_type,target_id,request_id,outcome,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [auth.tenantId, projectId, auth.actor, actionName, targetType, targetId, requestId, outcome, JSON.stringify(redact(details))]);
    if (projectId) await db.query(`INSERT INTO audit_events(project_id,actor,action,target_type,target_id,request_id,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [projectId, auth.actor, actionName, targetType, targetId, requestId, JSON.stringify(redact(details))]);
  }

  async function idempotent(db, auth, key, bodyHash, operation) {
    const existing = await db.query('SELECT request_hash,response_status,response_body FROM ops_command_idempotency WHERE tenant_id=$1 AND actor=$2 AND idempotency_key=$3', [auth.tenantId, auth.actor, key]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== bodyHash) throw Object.assign(new Error('Idempotency key was already used with a different command'), { code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
      return { replay: true, status: existing.rows[0].response_status, body: existing.rows[0].response_body };
    }
    const result = await operation();
    await db.query(`INSERT INTO ops_command_idempotency(tenant_id,actor,idempotency_key,request_hash,response_status,response_body) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [auth.tenantId, auth.actor, key, bodyHash, result.status, JSON.stringify(result.body)]);
    return { replay: false, ...result };
  }

  async function action(db, auth, actionName, req, res, requestId) {
    if (!DANGEROUS.has(actionName)) return json(res, 400, { error: { code: 'UNSUPPORTED_ACTION', message: 'Unsupported operator action' }, requestId }, requestId);
    const body = await readBody(req);
    await requireReason(body);
    const targetType = body.targetType;
    const targetId = body.targetId;
    if (!['job', 'artifact', 'worker', 'provider'].includes(targetType) || typeof targetId !== 'string' || !targetId) throw Object.assign(new Error('targetType and targetId are required'), { code: 'VALIDATION_ERROR', statusCode: 400 });
    const project = await resolveProject(db, auth, targetType, targetId);
    if (!project && !['worker', 'provider'].includes(targetType)) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Target not found' }, requestId }, requestId);
    if (['worker', 'provider'].includes(targetType) && body.tenantId !== auth.tenantId) return json(res, 403, { error: { code: 'TENANT_MISMATCH', message: 'Tenant scope is required for global operator resources' }, requestId }, requestId);
    const requestHash = hash(stableBody({ actionName, targetType, targetId, ...body }));
    const result = await idempotent(db, auth, body.idempotencyKey, requestHash, async () => {
      const out = await applyAction(db, auth, actionName, targetType, targetId, body, project?.id || null, requestId);
      return { status: out.status || 200, body: { item: out.item, dryRun: Boolean(body.dryRun), requestId } };
    });
    return json(res, result.status, result.body, requestId);
  }

  async function applyAction(db, auth, actionName, targetType, targetId, body, projectId, requestId) {
    if (body.dryRun) {
      await audit(db, auth, requestId, `OPS_${actionName.toUpperCase()}_PREVIEW`, targetType, targetId, projectId, 'ALLOWED', { reason: body.reason, dryRun: true });
      return { status: 200, item: { action: actionName, targetType, targetId, permitted: true, dryRun: true } };
    }
    if (targetType === 'job') {
      const job = (await db.query('SELECT * FROM forge_jobs WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
      if (!job) throw Object.assign(new Error('Job not found'), { code: 'NOT_FOUND', statusCode: 404 });
      if (!SAFE_JOB_STATUSES.has(job.status)) throw Object.assign(new Error(`Job state ${job.status} is not operator mutable`), { code: 'STATE_CONFLICT', statusCode: 409 });
      if (['retry', 'requeue'].includes(actionName) && EXTERNAL_SIDE_EFFECT_KINDS.test(job.kind)) throw Object.assign(new Error('Retry/requeue of externally visible side-effect jobs is prohibited by the control plane'), { code: 'DANGEROUS_RETRY_REJECTED', statusCode: 409 });
      if (body.expectedStatus && body.expectedStatus !== job.status) throw Object.assign(new Error('Job state changed since preview'), { code: 'STALE_PRECONDITION', statusCode: 409 });
      let updated;
      if (actionName === 'cancel') {
        if (!['QUEUED', 'RUNNING'].includes(job.status)) throw Object.assign(new Error('Only queued/running jobs may be cancelled'), { code: 'STATE_CONFLICT', statusCode: 409 });
        updated = (await db.query(`UPDATE forge_jobs SET cancellation_requested_at=COALESCE(cancellation_requested_at,now()), updated_at=now() WHERE id=$1 RETURNING id,status,worker_id,attempts,max_attempts,leased_until,dispatch_generation`, [targetId])).rows[0];
      } else if (actionName === 'fence') {
        if (job.status !== 'RUNNING') throw Object.assign(new Error('Only running jobs may be fenced'), { code: 'STATE_CONFLICT', statusCode: 409 });
        const fence = `FENCED:${randomUUID()}`;
        updated = (await db.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=$2,leased_until=NULL,dispatch_token=NULL,dispatch_generation=dispatch_generation+1,available_at=now(),updated_at=now(),last_schedule_reason=$3 WHERE id=$1 AND status='RUNNING' RETURNING id,status,worker_id,dispatch_generation`, [targetId, fence, body.reason])).rows[0];
      } else if (actionName === 'recover') {
        if (job.status !== 'RUNNING' || !job.leased_until || new Date(job.leased_until) >= new Date()) throw Object.assign(new Error('Job does not have an expired lease'), { code: 'LEASE_NOT_EXPIRED', statusCode: 409 });
        const fence = `RECOVERED:${randomUUID()}`;
        updated = (await db.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=$2,leased_until=NULL,dispatch_token=NULL,dispatch_generation=dispatch_generation+1,available_at=now(),updated_at=now(),last_schedule_reason=$3 WHERE id=$1 AND status='RUNNING' AND leased_until<now() RETURNING id,status,worker_id,dispatch_generation`, [targetId, fence, body.reason])).rows[0];
      } else if (['retry', 'requeue'].includes(actionName)) {
        if (job.status !== 'FAILED') throw Object.assign(new Error('Only failed jobs may be retried/requeued'), { code: 'STATE_CONFLICT', statusCode: 409 });
        if (job.attempts >= job.max_attempts) throw Object.assign(new Error('Retry budget exhausted'), { code: 'RETRY_EXHAUSTED', statusCode: 409 });
        updated = (await db.query(`UPDATE forge_jobs SET status='QUEUED',worker_id=NULL,leased_until=NULL,dispatch_token=NULL,cancellation_requested_at=NULL,available_at=now(),updated_at=now(),last_schedule_reason=$2 WHERE id=$1 AND status='FAILED' AND attempts<max_attempts RETURNING id,status,attempts,max_attempts`, [targetId, body.reason])).rows[0];
      } else {
        throw Object.assign(new Error(`Action ${actionName} is not valid for jobs`), { code: 'STATE_CONFLICT', statusCode: 409 });
      }
      await audit(db, auth, requestId, `OPS_${actionName.toUpperCase()}`, 'job', targetId, projectId, 'ALLOWED', { reason: body.reason, from: job.status, to: updated?.status, attempts: job.attempts });
      return { item: updated };
    }

    if (targetType === 'artifact') {
      if (actionName !== 'quarantine') throw Object.assign(new Error('Only quarantine is supported for artifacts'), { code: 'STATE_CONFLICT', statusCode: 409 });
      const artifact = (await db.query('SELECT a.id,a.episode_id,e.project_id,l.state FROM artifacts a JOIN episodes e ON e.id=a.episode_id LEFT JOIN artifact_lifecycle_records l ON l.artifact_id=a.id WHERE a.id=$1 FOR UPDATE', [targetId])).rows[0];
      if (!artifact) throw Object.assign(new Error('Artifact not found'), { code: 'NOT_FOUND', statusCode: 404 });
      if (['DELETED','DELETION_PENDING'].includes(artifact.state)) throw Object.assign(new Error('Deleted/deletion-pending artifacts cannot be quarantined'), { code: 'STATE_CONFLICT', statusCode: 409 });
      await db.query(`INSERT INTO artifact_lifecycle_records(artifact_id,project_id,state,quarantine_at,last_evaluated_at,last_error,updated_at) VALUES($1,$2,'QUARANTINED',now(),now(),$3::jsonb,now()) ON CONFLICT(artifact_id) DO UPDATE SET state='QUARANTINED',quarantine_at=now(),last_error=$3::jsonb,updated_at=now()`, [targetId, projectId, JSON.stringify({ operator: auth.actor, reason: body.reason })]);
      await audit(db, auth, requestId, 'OPS_QUARANTINE', 'artifact', targetId, projectId, 'ALLOWED', { reason: body.reason });
      return { item: { artifactId: targetId, state: 'QUARANTINED' } };
    }

    if (targetType === 'worker' || targetType === 'provider') {
      if (!['disable', 'enable'].includes(actionName)) throw Object.assign(new Error(`Only disable/enable is supported for ${targetType}`), { code: 'STATE_CONFLICT', statusCode: 409 });
      const enabled = actionName === 'enable';
      const row = (await db.query(`INSERT INTO ops_controls(tenant_id,resource_type,resource_id,enabled,reason,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(tenant_id,resource_type,resource_id) DO UPDATE SET enabled=EXCLUDED.enabled,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`, [auth.tenantId, targetType, targetId, enabled, body.reason, auth.actor])).rows[0];
      await audit(db, auth, requestId, `OPS_${actionName.toUpperCase()}`, targetType, targetId, null, 'ALLOWED', { reason: body.reason, enabled });
      return { item: { ...row, enabled: Boolean(row.enabled) } };
    }

    if (actionName === 'reconcile' && targetType === 'provider') {
      const control = (await db.query('SELECT enabled FROM ops_controls WHERE tenant_id=$1 AND resource_type=$2 AND resource_id=$3', [auth.tenantId, 'provider', targetId])).rows[0];
      if (control && !control.enabled) throw Object.assign(new Error('Provider is disabled'), { code: 'PROVIDER_DISABLED', statusCode: 409 });
      const id = randomUUID();
      const item = (await db.query(`INSERT INTO forge_jobs(id,project_id,episode_id,kind,payload,priority,max_attempts,idempotency_key,created_by) VALUES($1,NULL,NULL,'workflow:provider-reconcile',$2::jsonb,5,1,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`, [id, JSON.stringify({ provider: targetId, reason: body.reason, tenantId: auth.tenantId }), `ops-reconcile:${auth.tenantId}:${targetId}:${hash(body.reason)}`, auth.actor])).rows[0];
      await audit(db, auth, requestId, 'OPS_RECONCILE', 'provider', targetId, null, 'ALLOWED', { reason: body.reason, jobId: item?.id });
      return { item: item || { id, status: 'QUEUED' }, status: 202 };
    }
    throw Object.assign(new Error('Unsupported operator action for target'), { code: 'STATE_CONFLICT', statusCode: 409 });
  }

  async function listProjects(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50); const offset = boundedInt(url.searchParams.get('offset'), 0, 1000000);
    const q = await db.query(`SELECT p.id,p.name,p.tenant_id,p.created_by,p.created_at,p.updated_at FROM projects p WHERE p.tenant_id=$1 ORDER BY p.updated_at DESC LIMIT $2 OFFSET $3`, [auth.tenantId, limit, offset]);
    return json(res, 200, { items: q.rows, limit, offset, nextOffset: q.rows.length === limit ? offset + limit : null }, requestId);
  }

  async function listEpisodes(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50); const offset = boundedInt(url.searchParams.get('offset'), 0, 1000000); const state = url.searchParams.get('state');
    const values = [auth.tenantId]; const where = ['p.tenant_id=$1'];
    if (state) { values.push(state); where.push(`e.state=$${values.length}`); }
    if (url.searchParams.get('projectId')) { values.push(url.searchParams.get('projectId')); where.push(`e.project_id=$${values.length}`); }
    values.push(limit, offset);
    const q = await db.query(`SELECT e.id,e.project_id,e.title,e.state,e.revision,e.current_render_id,e.approved_render_id,e.updated_at FROM episodes e JOIN projects p ON p.id=e.project_id WHERE ${where.join(' AND ')} ORDER BY e.updated_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    return json(res, 200, { items: q.rows, limit, offset, nextOffset: q.rows.length === limit ? offset + limit : null }, requestId);
  }

  async function listVersions(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50); const offset = boundedInt(url.searchParams.get('offset'), 0, 1000000); const episodeId = url.searchParams.get('episodeId');
    const values = [auth.tenantId]; const where = ['p.tenant_id=$1']; if (episodeId) { values.push(episodeId); where.push(`v.episode_id=$${values.length}`); } if (url.searchParams.get('kind')) { values.push(url.searchParams.get('kind')); where.push(`v.kind=$${values.length}`); }
    values.push(limit, offset); const q = await db.query(`SELECT v.id,v.episode_id,v.kind,v.parent_id,v.content_hash,v.created_by,v.created_at FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id WHERE ${where.join(' AND ')} ORDER BY v.created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    return json(res, 200, { items: q.rows, limit, offset, nextOffset: q.rows.length === limit ? offset + limit : null }, requestId);
  }

  async function listArtifacts(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50); const offset = boundedInt(url.searchParams.get('offset'), 0, 1000000); const state = url.searchParams.get('lifecycleState');
    const values = [auth.tenantId]; const where = ['p.tenant_id=$1']; if (state) { values.push(state); where.push(`l.state=$${values.length}`); } if (url.searchParams.get('episodeId')) { values.push(url.searchParams.get('episodeId')); where.push(`a.episode_id=$${values.length}`); }
    values.push(limit, offset); const q = await db.query(`SELECT a.id,a.episode_id,a.kind,a.version_id,a.content_hash,a.media_type,a.storage_uri,l.state lifecycle_state,l.reference_count,a.created_at FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id LEFT JOIN artifact_lifecycle_records l ON l.artifact_id=a.id WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    return json(res, 200, { items: q.rows.map(redact), limit, offset, nextOffset: q.rows.length === limit ? offset + limit : null }, requestId);
  }

  async function listJobs(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50); const offset = boundedInt(url.searchParams.get('offset'), 0, 1000000); const values = [auth.tenantId]; const where = ['(p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>\'tenantId\'=$1))'];
    for (const [key, column] of [['status','j.status'],['kind','j.kind'],['workerId','j.worker_id']]) { const v = url.searchParams.get(key); if (v) { values.push(v); where.push(`${column}=$${values.length}`); } }
    if (url.searchParams.get('projectId')) { values.push(url.searchParams.get('projectId')); where.push(`j.project_id=$${values.length}`); }
    values.push(limit, offset); const q = await db.query(`SELECT j.id,j.project_id,j.episode_id,j.kind,j.status,j.priority,j.attempts,j.max_attempts,j.available_at,j.leased_until,j.worker_id,j.dispatch_generation,j.blocked_reason,j.cancellation_requested_at,j.created_at,j.updated_at,j.trace_id,j.correlation_id FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE ${where.join(' AND ')} ORDER BY j.priority,j.created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    return json(res, 200, { items: q.rows, limit, offset, nextOffset: q.rows.length === limit ? offset + limit : null }, requestId);
  }

  async function getJob(db, auth, id, res, requestId) {
    const q = await db.query(`SELECT j.*,p.tenant_id FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE j.id=$1 AND (p.tenant_id=$2 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$2))`, [id, auth.tenantId]);
    if (!q.rows[0]) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Job not found' }, requestId }, requestId);
    const events = await db.query(`SELECT event_type,scheduler_id,details,created_at FROM forge_scheduler_events WHERE job_id=$1 ORDER BY created_at DESC LIMIT 50`, [id]);
    return json(res, 200, { item: redact(q.rows[0]), schedulerEvents: events.rows.map(redact) }, requestId);
  }

  async function listWorkers(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50); const offset = boundedInt(url.searchParams.get('offset'), 0, 1000000);
    const q = await db.query(`SELECT scheduler_key,scheduler_id,heartbeat_at,metadata FROM forge_scheduler_state WHERE COALESCE(metadata->>'tenantId',$1)=$1 ORDER BY heartbeat_at DESC LIMIT $2 OFFSET $3`, [auth.tenantId, limit, offset]);
    const controls = await db.query(`SELECT resource_id,enabled,reason,updated_at FROM ops_controls WHERE tenant_id=$1 AND resource_type='worker'`, [auth.tenantId]);
    return json(res, 200, { items: q.rows.map(r => ({ ...r, control: controls.rows.find(c => c.resource_id === r.scheduler_id) || null })), limit, offset }, requestId);
  }

  async function listProviders(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50); const offset = boundedInt(url.searchParams.get('offset'), 0, 1000000);
    const q = await db.query(`SELECT provider,COUNT(*)::int runs,COUNT(*) FILTER(WHERE status='FAILED')::int failed,COUNT(*) FILTER(WHERE status='SUCCEEDED')::int succeeded,MAX(created_at) last_run,AVG(EXTRACT(EPOCH FROM (finished_at-started_at))) FILTER(WHERE finished_at IS NOT NULL) avg_duration_seconds FROM provider_runs pr JOIN episodes e ON e.id=pr.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 GROUP BY provider ORDER BY last_run DESC NULLS LAST LIMIT $2 OFFSET $3`, [auth.tenantId, limit, offset]);
    const controls = await db.query(`SELECT resource_id,enabled,reason,updated_at FROM ops_controls WHERE tenant_id=$1 AND resource_type='provider'`, [auth.tenantId]);
    return json(res, 200, { items: q.rows.map(r => ({ ...r, control: controls.rows.find(c => c.resource_id === r.provider) || null })), limit, offset }, requestId);
  }

  async function listAudit(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50); const offset = boundedInt(url.searchParams.get('offset'), 0, 1000000); const values = [auth.tenantId]; const where = ['tenant_id=$1']; if (url.searchParams.get('action')) { values.push(url.searchParams.get('action')); where.push(`action=$${values.length}`); } if (url.searchParams.get('outcome')) { values.push(url.searchParams.get('outcome')); where.push(`outcome=$${values.length}`); } values.push(limit, offset);
    const q = await db.query(`SELECT id,actor,action,target_type,target_id,request_id,outcome,details,created_at FROM security_audit_events WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT $${values.length-1} OFFSET $${values.length}`, values);
    return json(res, 200, { items: q.rows.map(redact), limit, offset, nextOffset: q.rows.length === limit ? offset + limit : null }, requestId);
  }

  async function search(db, auth, url, res, requestId) {
    const qtext = url.searchParams.get('q'); if (!qtext || qtext.length > 200) throw Object.assign(new Error('q is required and capped at 200 characters'), { code: 'VALIDATION_ERROR', statusCode: 400 });
    const limit = boundedInt(url.searchParams.get('limit'), 25, 50);
    const term = `%${qtext.replace(/[%_]/g, '')}%`;
    const [projects, episodes, jobs] = await Promise.all([
      db.query('SELECT p.id,p.name,p.updated_at FROM projects p WHERE p.tenant_id=$1 AND p.name ILIKE $2 ORDER BY p.updated_at DESC LIMIT $3', [auth.tenantId, term, limit]),
      db.query('SELECT e.id,e.project_id,e.title,e.state,e.updated_at FROM episodes e JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND e.title ILIKE $2 ORDER BY e.updated_at DESC LIMIT $3', [auth.tenantId, term, limit]),
      db.query('SELECT j.id,j.project_id,j.kind,j.status,j.updated_at FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>\'tenantId\'=$1)) AND j.kind ILIKE $2 ORDER BY j.updated_at DESC LIMIT $3', [auth.tenantId, term, limit]),
    ]);
    return json(res, 200, { projects: projects.rows, episodes: episodes.rows, jobs: jobs.rows }, requestId);
  }

  async function incidents(db, auth, url, res, requestId) {
    const limit = boundedInt(url.searchParams.get('limit'), 50);
    const [stuck, exhausted, expired, blocked, providers, corrupt, budgets] = await Promise.all([
      db.query(`SELECT j.id,j.project_id,j.episode_id,j.kind,j.status,j.attempts,j.leased_until,j.updated_at FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$1)) AND ((j.status='RUNNING' AND j.leased_until<now()) OR (j.status='QUEUED' AND j.available_at<now()-interval '15 minutes')) ORDER BY j.updated_at ASC LIMIT $2`, [auth.tenantId, limit]),
      db.query(`SELECT j.id,j.project_id,j.episode_id,j.kind,j.attempts,j.max_attempts,j.updated_at FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$1)) AND j.status='FAILED' AND j.attempts>=j.max_attempts ORDER BY j.updated_at DESC LIMIT $2`, [auth.tenantId, limit]),
      db.query(`SELECT j.id,j.project_id,j.worker_id,j.leased_until,j.dispatch_generation FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$1)) AND j.status='RUNNING' AND j.leased_until<now() ORDER BY j.leased_until ASC LIMIT $2`, [auth.tenantId, limit]),
      db.query(`SELECT j.id,j.project_id,j.episode_id,j.kind,j.blocked_reason,j.updated_at FROM forge_jobs j LEFT JOIN projects p ON p.id=j.project_id WHERE (p.tenant_id=$1 OR (j.project_id IS NULL AND j.payload->>'tenantId'=$1)) AND j.status='QUEUED' AND (j.blocked_reason IS NOT NULL OR j.depends_on_job_id IN (SELECT id FROM forge_jobs WHERE status IN ('FAILED','CANCELLED'))) ORDER BY j.updated_at ASC LIMIT $2`, [auth.tenantId, limit]),
      db.query(`SELECT provider,COUNT(*)::int failed,COUNT(*) FILTER(WHERE status='SUCCEEDED')::int succeeded FROM provider_runs pr JOIN episodes e ON e.id=pr.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id=$1 AND pr.created_at>now()-interval '1 hour' GROUP BY provider HAVING COUNT(*) FILTER(WHERE status='FAILED')>0 ORDER BY failed DESC LIMIT $2`, [auth.tenantId, limit]),
      db.query(`SELECT a.id,a.episode_id,a.content_hash,l.state,l.last_error FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id JOIN artifact_lifecycle_records l ON l.artifact_id=a.id WHERE p.tenant_id=$1 AND l.state='QUARANTINED' ORDER BY l.updated_at DESC LIMIT $2`, [auth.tenantId, limit]),
      db.query(`SELECT project_id,state,COUNT(*)::int count FROM usage_budgets ub JOIN projects p ON p.id=ub.project_id WHERE p.tenant_id=$1 GROUP BY project_id,state ORDER BY project_id,state LIMIT $2`, [auth.tenantId, limit]).catch(() => ({ rows: [] })),
    ]);
    return json(res, 200, { stuckJobs: stuck.rows, retryExhausted: exhausted.rows, leaseExpired: expired.rows, dependencyBlocked: blocked.rows, providerOutages: providers.rows, quarantinedArtifacts: corrupt.rows.map(redact), budgetExhaustion: budgets.rows }, requestId);
  }

  async function health(db, res, requestId) {
    const dbCheck = await db.query('SELECT now() db_time');
    const jobs = await db.query(`SELECT status,COUNT(*)::int count FROM forge_jobs GROUP BY status ORDER BY status`);
    const scheduler = await db.query(`SELECT scheduler_key,scheduler_id,heartbeat_at FROM forge_scheduler_state ORDER BY heartbeat_at DESC LIMIT 50`).catch(() => ({ rows: [] }));
    return json(res, 200, { status: 'ok', persistence: { status: 'ok', dbTime: dbCheck.rows[0].db_time }, jobs: jobs.rows, schedulers: scheduler.rows }, requestId);
  }

  async function bulkPreview(db, auth, req, res, requestId) {
    const body = await readBody(req); await requireReason(body);
    if (!Array.isArray(body.targets) || body.targets.length < 1 || body.targets.length > MAX_BULK) throw Object.assign(new Error(`targets must contain 1..${MAX_BULK} items`), { code: 'BULK_SCOPE_EXCEEDED', statusCode: 400 });
    if (!DANGEROUS.has(body.action)) throw Object.assign(new Error('Unsupported bulk action'), { code: 'UNSUPPORTED_ACTION', statusCode: 400 });
    const preview = { action: body.action, targets: body.targets, reason: body.reason, tenantId: auth.tenantId, actor: auth.actor, expiresAt: Date.now() + 5 * 60 * 1000 };
    const token = randomUUID(); const tokenHash = hash(token);
    await db.query(`INSERT INTO ops_confirmation_tokens(token_hash,tenant_id,actor,action,payload,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,to_timestamp($6/1000.0))`, [tokenHash, auth.tenantId, auth.actor, body.action, JSON.stringify(preview), preview.expiresAt]);
    return json(res, 200, { preview, confirmationToken: token }, requestId);
  }

  async function bulkExecute(db, auth, req, res, requestId) {
    const body = await readBody(req); if (!body.confirmationToken) throw Object.assign(new Error('confirmationToken is required'), { code: 'CONFIRMATION_REQUIRED', statusCode: 400 });
    const tokenHash = hash(body.confirmationToken);
    const r = await db.query('SELECT * FROM ops_confirmation_tokens WHERE token_hash=$1 AND tenant_id=$2 AND actor=$3 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE', [tokenHash, auth.tenantId, auth.actor]);
    if (!r.rows[0]) throw Object.assign(new Error('Confirmation token is invalid, expired or already consumed'), { code: 'CONFIRMATION_INVALID', statusCode: 409 });
    const preview = r.rows[0].payload;
    if (preview.action !== body.action || hash(stableBody(preview.targets)) !== hash(stableBody(body.targets || preview.targets))) throw Object.assign(new Error('Confirmation scope does not match request'), { code: 'CONFIRMATION_SCOPE_MISMATCH', statusCode: 409 });
    const targets = Array.isArray(body.targets) ? body.targets : preview.targets;
    if (targets.length > MAX_BULK) throw Object.assign(new Error('Bulk scope exceeded'), { code: 'BULK_SCOPE_EXCEEDED', statusCode: 400 });
    await db.query('UPDATE ops_confirmation_tokens SET consumed_at=now() WHERE token_hash=$1', [tokenHash]);
    const results = [];
    for (const target of targets) {
      try {
        const project = await resolveProject(db, auth, target.targetType, target.targetId);
        if (!project && !['worker','provider'].includes(target.targetType)) throw Object.assign(new Error('Target not found'), { code: 'NOT_FOUND' });
        const out = await applyAction(db, auth, preview.action, target.targetType, target.targetId, { reason: preview.reason, idempotencyKey: `${body.idempotencyKey || tokenHash}:${target.targetType}:${target.targetId}` }, project?.id || null, requestId);
        results.push({ ...target, ok: true, item: out.item });
      } catch (error) { results.push({ ...target, ok: false, error: { code: error.code || 'FAILED', message: safeMessage(error) } }); }
    }
    return json(res, 200, { results, requestId }, requestId);
  }

  function redact(value) {
    if (!value || typeof value !== 'object') return value;
    const clone = Array.isArray(value) ? value.map(redact) : { ...value };
    const secretKeys = /token|secret|password|authorization|credential|access_key|refresh/i;
    for (const key of Object.keys(clone)) { if (secretKeys.test(key)) clone[key] = '[REDACTED]'; else if (clone[key] && typeof clone[key] === 'object') clone[key] = redact(clone[key]); }
    return clone;
  }
  function safeMessage(error) { return error?.code === 'INTERNAL_ERROR' ? 'Request could not be completed' : String(error?.message || 'Request could not be completed').slice(0, 300); }
}

module.exports = { installOperationsControlPlane, MAX_BULK, MAX_PAGE_SIZE };
