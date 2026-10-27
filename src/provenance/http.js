const { authenticate, applySecurityHeaders, safeError, hasRole } = require('../security/http-security');
const { randomUUID } = require('node:crypto');

function json(response, status, body, requestId) {
  applySecurityHeaders(response);
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-request-id', requestId);
  response.writeHead(status);
  response.end(JSON.stringify(body));
}
function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) reject(Object.assign(new Error('request body too large'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' })); });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('invalid json'), { statusCode: 400, code: 'INVALID_JSON' })); } });
    request.on('error', reject);
  });
}

function installProvenanceHttp(extended) {
  const original = extended.createExtendedApiServer;
  extended.createExtendedApiServer = function createExtendedApiServerWithProvenance(options = {}) {
    const result = original(options);
    if (!result?.server || !options.repository) return result;
    const baseListeners = result.server.listeners.bind(result.server);
    result.server.listeners = function listenersWithProvenance(eventName) {
      const listeners = baseListeners(eventName);
      if (eventName !== 'request' || !listeners.length) return listeners;
      const baseHandler = listeners[0];
      const wrapped = async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        if (!pathname.startsWith('/v1/provenance/')) return baseHandler(request, response);
        const requestId = request.headers['x-request-id'] || randomUUID();
        response.setHeader('x-request-id', requestId);
        const auth = authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
        if (!auth) return safeError(response, 401, 'UNAUTHORIZED', requestId);
        if (!hasRole(auth, 'VIEWER')) return safeError(response, 403, 'FORBIDDEN', requestId);
        try {
          const graph = options.repository.provenanceGraph();
          const pool = options.repository.db.pool;
          const artifactMatch = /^\/v1\/provenance\/artifacts\/([^/]+)$/.exec(pathname);
          const episodeMatch = /^\/v1\/provenance\/episodes\/([^/]+)\/snapshot$/.exec(pathname);
          const verifyMatch = /^\/v1\/provenance\/snapshots\/([^/]+)\/verify$/.exec(pathname);
          if (artifactMatch && request.method === 'POST') {
            const artifactId = decodeURIComponent(artifactMatch[1]);
            const scope = (await pool.query('SELECT e.project_id,p.tenant_id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE a.id=$1',[artifactId])).rows[0];
            if (!scope || scope.tenant_id !== auth.tenantId) return safeError(response, 404, 'NOT_FOUND', requestId);
            const result = await graph.ensureArtifactChain({ artifactId, actor: auth.actor, reason: 'operator-verification' });
            return json(response, 200, result, requestId);
          }
          if (episodeMatch && request.method === 'GET') {
            const episodeId = decodeURIComponent(episodeMatch[1]);
            const scope = (await pool.query('SELECT e.project_id,p.tenant_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=$1',[episodeId])).rows[0];
            if (!scope || scope.tenant_id !== auth.tenantId) return safeError(response, 404, 'NOT_FOUND', requestId);
            return json(response, 200, await graph.snapshot({ tenantId: auth.tenantId, projectId: scope.project_id, episodeId, createdBy: auth.actor }), requestId);
          }
          if (verifyMatch && request.method === 'GET') return json(response, 200, await graph.verifySnapshot({ snapshotId: decodeURIComponent(verifyMatch[1]), tenantId: auth.tenantId, projectId: new URL(request.url,'http://localhost').searchParams.get('projectId') }), requestId);
          if (pathname === '/v1/provenance/reconcile' && request.method === 'POST') {
            if (!hasRole(auth, 'OWNER')) return safeError(response, 403, 'FORBIDDEN', requestId);
            const body = await readJson(request);
            if (body.projectId) {
              const project = (await pool.query('SELECT tenant_id FROM projects WHERE id=$1',[body.projectId])).rows[0];
              if (!project || project.tenant_id !== auth.tenantId) return safeError(response, 404, 'NOT_FOUND', requestId);
            }
            return json(response, 200, await graph.reconcile({ tenantId: auth.tenantId, projectId: body.projectId || null, mode: body.mode === 'REPAIR_PLAN' ? 'REPAIR_PLAN' : 'READ_ONLY', limit: Math.min(5000, Math.max(1, Number(body.limit || 500))), actor: auth.actor }), requestId);
          }
          return safeError(response, 404, 'NOT_FOUND', requestId);
        } catch (error) { return safeError(response, error.statusCode || 500, error.code || 'INTERNAL_ERROR', requestId); }
      };
      return [wrapped, ...listeners.slice(1)];
    };
    return result;
  };
}

module.exports = { installProvenanceHttp };
