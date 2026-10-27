'use strict';
const { FinalArtifactLifecycleControlPlane } = require('./artifact-lifecycle-final-safety');
const { createStorageFromEnv } = require('./index');
const { hasRole } = require('../security/http-security');
const { randomUUID } = require('node:crypto');

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw Object.assign(new Error('Request body exceeds 1 MiB'), { statusCode: 413 }); chunks.push(chunk); }
  if (!size) return {};
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error('Malformed JSON request body'), { statusCode: 400 }); }
}
function send(res, status, body, requestId) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId }); res.end(JSON.stringify(body)); }
function scopeTenant(pool, tenantId) { return pool.query('SELECT id FROM tenants WHERE id=$1', [tenantId]).then(r => Boolean(r.rows[0])); }

function installArtifactLifecycleHttp() {
  try {
    const extended = require('../extended-http-api');
    if (extended.createExtendedApiServer.__forgeArtifactLifecycleInstalled) return;
    const originalCreate = extended.createExtendedApiServer;
    extended.createExtendedApiServer = function createExtendedApiServerWithArtifactLifecycle(options = {}) {
      const result = originalCreate(options); if (!result?.server || !options.repository) return result;
      const baseHandler = result.server.listeners('request')[0]; result.server.removeAllListeners('request');
      const storage = options.storage || createStorageFromEnv();
      result.server.on('request', async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/v1/artifacts/gc')) return baseHandler(req, res);
        const requestId = req.headers['x-request-id'] || randomUUID();
        const auth = req._auth;
        if (!auth || !auth.tenantId) return send(res, 403, { error: { code: 'TENANT_CONTEXT_REQUIRED' } }, requestId);
        if (!(await scopeTenant(options.repository.db.pool, auth.tenantId))) return send(res, 403, { error: { code: 'TENANT_ISOLATION' } }, requestId);
        const service = new FinalArtifactLifecycleControlPlane({ pool: options.repository.db.pool, storage });
        const actor = req.headers['x-actor-id'] || auth.actor || 'api';
        const parts = url.pathname.split('/').filter(Boolean);
        try {
          if (req.method === 'GET' && url.pathname === '/v1/artifacts/gc/health') return send(res, 200, await service.health({ tenantId: auth.tenantId }), requestId);
          if (req.method === 'POST' && url.pathname === '/v1/artifacts/gc/preview') return send(res, 200, await service.preview({ tenantId: auth.tenantId, actor, policy: (await readJson(req)).policy || {} }), requestId);
          if (req.method === 'POST' && url.pathname === '/v1/artifacts/gc/generations') {
            const body = await readJson(req); const destructive = body.mode === 'ENFORCE';
            if (destructive && !hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'OPERATOR_APPROVAL_REQUIRED' } }, requestId);
            const generation = await service.createGeneration({ tenantId: auth.tenantId, actor, mode: body.mode || 'DRY_RUN', policy: body.policy || {} });
            const marked = await service.markGeneration({ tenantId: auth.tenantId, generationId: generation.id, actor });
            return send(res, 201, { generation, marked }, requestId);
          }
          if (parts[0] === 'v1' && parts[1] === 'artifacts' && parts[2] === 'gc' && parts[3] === 'generations' && parts[4]) {
            const generationId = decodeURIComponent(parts[4]);
            if (req.method === 'POST' && parts[5] === 'approve') { if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'OPERATOR_APPROVAL_REQUIRED' } }, requestId); return send(res, 200, await service.approveGeneration({ tenantId: auth.tenantId, generationId, actor }), requestId); }
            if (req.method === 'POST' && parts[5] === 'sweep') return send(res, 200, await service.sweepGeneration({ tenantId: auth.tenantId, generationId, actor, dryRun: url.searchParams.get('dryRun') === 'true' }), requestId);
            if (req.method === 'POST' && parts[5] === 'delete') { if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'OPERATOR_APPROVAL_REQUIRED' } }, requestId); const body = await readJson(req); return send(res, 200, await service.executeApprovedDeletes({ tenantId: auth.tenantId, generationId, actor, maxDeletes: body.maxDeletes, maxDeleteBytes: body.maxDeleteBytes }), requestId); }
          }
          if (req.method === 'POST' && url.pathname === '/v1/artifacts/gc/reconcile') return send(res, 200, await service.reconcileProvider({ tenantId: auth.tenantId, limit: Number(url.searchParams.get('limit') || 100) }), requestId);
          if (req.method === 'POST' && url.pathname === '/v1/artifacts/gc/recover-leases') return send(res, 200, await service.recoverStaleLeases({ tenantId: auth.tenantId, limit: Number(url.searchParams.get('limit') || 500) }), requestId);
          return send(res, 404, { error: { code: 'NOT_FOUND' } }, requestId);
        } catch (error) { return send(res, error.statusCode || (error.code === 'FORBIDDEN' ? 403 : error.code === 'GC_BUSY' ? 409 : error.code === 'OPERATOR_APPROVAL_REQUIRED' ? 403 : error instanceof TypeError ? 400 : 422), { error: { code: error.code || 'ARTIFACT_GC_ERROR', message: error.message } }, requestId); }
      });
      return result;
    };
    extended.createExtendedApiServer.__forgeArtifactLifecycleInstalled = true;
  } catch (error) { if (process.env.FORGE_ARTIFACT_GC_REQUIRED === 'true') throw error; }
}

installArtifactLifecycleHttp();
module.exports = { installArtifactLifecycleHttp };
