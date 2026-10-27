'use strict';

const { randomUUID } = require('node:crypto');
const { ArtifactIntegrityControlPlane } = require('./artifact-integrity-control-plane');
const { createStorageFromEnv } = require('./index');
const { hasRole } = require('../security/http-security');

async function readJson(req) {
  let size = 0;
  const chunks = [];
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
  } catch {
    throw Object.assign(new Error('Malformed JSON request body'), { statusCode: 400 });
  }
}

function send(res, status, body, requestId) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': requestId });
  res.end(JSON.stringify(body));
}

function installArtifactIntegrityHttp() {
  try {
    const extended = require('../extended-http-api');
    if (extended.createExtendedApiServer.__forgeArtifactIntegrityInstalled) return;
    const originalCreate = extended.createExtendedApiServer;
    extended.createExtendedApiServer = function createExtendedApiServerWithArtifactIntegrity(options = {}) {
      const result = originalCreate(options);
      if (!result?.server || !options.repository) return result;
      const baseHandler = result.server.listeners('request')[0];
      result.server.removeAllListeners('request');
      const storage = options.storage || createStorageFromEnv();
      result.server.on('request', async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/v1/artifacts/integrity')) return baseHandler(req, res);
        const requestId = req.headers['x-request-id'] || randomUUID();
        const auth = req._auth;
        if (!auth?.tenantId) return send(res, 403, { error: { code: 'TENANT_CONTEXT_REQUIRED' } }, requestId);
        if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'OPERATOR_APPROVAL_REQUIRED' } }, requestId);
        const service = new ArtifactIntegrityControlPlane({ pool: options.repository.db.pool, storage });
        const actor = req.headers['x-actor-id'] || auth.actor || 'operator';
        try {
          if (req.method === 'GET' && url.pathname === '/v1/artifacts/integrity/health') return send(res, 200, await service.health({ tenantId: auth.tenantId }), requestId);
          if (req.method === 'POST' && url.pathname === '/v1/artifacts/integrity/scan') {
            const body = await readJson(req);
            return send(res, 202, await service.scan({ tenantId: auth.tenantId, projectId: body.projectId || null, limit: body.limit, actor }), requestId);
          }
          if (req.method === 'POST' && url.pathname === '/v1/artifacts/integrity/repair') {
            const body = await readJson(req);
            return send(res, 202, await service.requestRepair({ tenantId: auth.tenantId, projectId: body.projectId, artifactId: body.artifactId, action: body.action, actor }), requestId);
          }
          if (req.method === 'POST' && url.pathname === '/v1/artifacts/integrity/rebuild-ref') {
            const body = await readJson(req);
            return send(res, 200, await service.rebuildContentReference({ tenantId: auth.tenantId, artifactId: body.artifactId, actor }), requestId);
          }
          return send(res, 404, { error: { code: 'NOT_FOUND' } }, requestId);
        } catch (error) {
          const status = error.statusCode || (error.code === 'TENANT_SCOPE_VIOLATION' ? 403 : error instanceof TypeError ? 400 : 422);
          return send(res, status, { error: { code: error.code || 'ARTIFACT_INTEGRITY_ERROR', message: error.message } }, requestId);
        }
      });
      return result;
    };
    extended.createExtendedApiServer.__forgeArtifactIntegrityInstalled = true;
  } catch (error) {
    if (process.env.FORGE_ARTIFACT_INTEGRITY_REQUIRED === 'true') throw error;
  }
}

installArtifactIntegrityHttp();
module.exports = { installArtifactIntegrityHttp };
