'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { Pool } = require('pg');
const { JobQueue } = require('../persistence/job-queue');
const { createReleaseScheduleService } = require('./release-scheduler');
const { authenticate, hasRole, safeError } = require('../security/http-security');

const INSTALLED = Symbol.for('forge.release.schedule.http.installed');
function json(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
async function readJson(request) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw Object.assign(new Error('request body too large'), { statusCode: 413 }); chunks.push(chunk); } if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { statusCode: 400 }); } }
function roleFor(method, pathname) { if (method === 'GET') return 'VIEWER'; if (/\/controls$/.test(pathname)) return 'OWNER'; return 'EDITOR'; }

function installReleaseScheduleHttp() {
  if (globalThis[INSTALLED] || !process.env.DATABASE_URL) return;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.FORGE_RELEASE_API_POOL_MAX || '4', 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  const queue = new JobQueue({ pool });
  const service = createReleaseScheduleService({ pool, queue, workerId: 'forge-release-api' });
  const originalOn = http.Server.prototype.on;
  http.Server.prototype.on = function releaseScheduleRequestPatch(event, listener) {
    if (event !== 'request' || typeof listener !== 'function') return originalOn.call(this, event, listener);
    return originalOn.call(this, event, async (request, response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/v1/release-schedules') && !pathname.startsWith('/v1/release-calendar') && !pathname.startsWith('/internal/release-calendar')) return listener(request, response);
      try {
        const auth = request._auth || authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
        if (!auth) return json(response, 401, { error: { code: 'UNAUTHORIZED' } });
        const method = request.method || 'GET'; const role = roleFor(method, pathname); if (!hasRole(auth, role)) return json(response, 403, { error: { code: 'FORBIDDEN', message: `requires ${role}` } });
        const path = pathname.split('/').filter(Boolean).map(decodeURIComponent);
        if (pathname === '/v1/release-schedules' && method === 'GET') { const u = new URL(request.url, 'http://localhost'); const projectId = u.searchParams.get('projectId'); if (!projectId) return json(response, 400, { error: { code: 'VALIDATION_ERROR', message: 'projectId is required' } }); const access = (await pool.query('SELECT 1 FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$2 WHERE p.id=$1 AND p.tenant_id=$3 AND (m.actor_id IS NOT NULL OR p.created_by=$2)', [projectId, auth.actor, auth.tenantId])).rows[0]; if (!access) return json(response, 403, { error: { code: 'FORBIDDEN' } }); return json(response, 200, { items: await service.list({ tenantId: auth.tenantId, projectId, status: u.searchParams.get('status'), limit: u.searchParams.get('limit') || 100 }) }); }
        if (pathname === '/v1/release-schedules' && method === 'POST') { const body = await readJson(request); const projectId = body.projectId; const episodeId = body.episodeId; const access = (await pool.query('SELECT 1 FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$2 WHERE p.id=$1 AND p.tenant_id=$3 AND (m.actor_id IS NOT NULL OR p.created_by=$2)', [projectId, auth.actor, auth.tenantId])).rows[0]; if (!access) return json(response, 403, { error: { code: 'FORBIDDEN' } }); return json(response, 201, { item: await service.create({ ...body, tenantId: auth.tenantId, actor: auth.actor, requestId: request.headers['x-request-id'] || null }) }); }
        if (path[0] === 'v1' && path[1] === 'release-schedules' && path[2]) { const id = path[2]; const existing = await service.get(id, auth.tenantId); const access = (await pool.query('SELECT 1 FROM project_members WHERE project_id=$1 AND actor_id=$2 UNION ALL SELECT 1 FROM projects WHERE id=$1 AND tenant_id=$3 AND created_by=$2 LIMIT 1', [existing.project_id, auth.actor, auth.tenantId])).rows[0]; if (!access) return json(response, 403, { error: { code: 'FORBIDDEN' } }); if (path.length === 3 && method === 'GET') return json(response, 200, { item: existing }); if (path.length === 3 && method === 'PATCH') return json(response, 200, { item: await service.mutate(id, { tenantId: auth.tenantId, projectId: existing.project_id, actor: auth.actor, requestId: request.headers['x-request-id'] || null, action: 'VERSION_CREATED', patch: await readJson(request) }) }); if (path.length === 4 && method === 'POST' && ['pause','resume','cancel'].includes(path[3])) { const action = path[3] === 'pause' ? 'PAUSED' : path[3] === 'resume' ? 'RESUMED' : 'CANCELLED'; return json(response, 200, { item: await service.mutate(id, { tenantId: auth.tenantId, projectId: existing.project_id, actor: auth.actor, requestId: request.headers['x-request-id'] || null, action }) }); } if (path.length === 4 && method === 'GET' && path[3] === 'executions') return json(response, 200, { items: (await pool.query('SELECT * FROM forge_release_schedule_executions WHERE schedule_id=$1 AND tenant_id=$2 ORDER BY planned_at DESC LIMIT 100', [id, auth.tenantId])).rows }); }
        if (pathname === '/v1/release-calendar/blackouts' && method === 'POST') { const body = await readJson(request); return json(response, 201, { item: await service.addBlackout({ ...body, tenantId: auth.tenantId, actor: auth.actor, requestId: request.headers['x-request-id'] || null }) }); }
        if (pathname === '/v1/release-calendar/controls' && method === 'GET') { const u = new URL(request.url, 'http://localhost'); const projectId = u.searchParams.get('projectId'); if (!projectId || !(await pool.query('SELECT 1 FROM projects WHERE id=$1 AND tenant_id=$2', [projectId, auth.tenantId])).rows[0]) return json(response, 403, { error: { code: 'FORBIDDEN' } }); return json(response, 200, { item: await service.controls(auth.tenantId, projectId) }); }
        if (pathname === '/v1/release-calendar/controls' && method === 'PUT') { const body = await readJson(request); if (!body.projectId || !(await pool.query('SELECT 1 FROM projects WHERE id=$1 AND tenant_id=$2', [body.projectId, auth.tenantId])).rows[0]) return json(response, 403, { error: { code: 'FORBIDDEN' } }); return json(response, 200, { item: await service.setControl({ tenantId: auth.tenantId, projectId: body.projectId, emergencyHold: body.emergencyHold, bumpEpoch: Boolean(body.bumpEpoch), actor: auth.actor, requestId: request.headers['x-request-id'] || null }) }); }
        if (pathname === '/internal/release-calendar/metrics' && method === 'GET') return json(response, 200, await service.metrics(auth.tenantId));
        return json(response, 404, { error: { code: 'NOT_FOUND' } });
      } catch (error) { return safeError(response, error.statusCode || 400, error.code || 'INVALID_REQUEST', request.headers['x-request-id'] || null); }
    });
  };
  globalThis[INSTALLED] = { pool, service };
}

installReleaseScheduleHttp();
module.exports = globalThis[INSTALLED] || null;
