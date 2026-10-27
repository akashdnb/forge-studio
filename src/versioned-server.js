const { installHttpVersioning } = require('./api/api-versioning');
require('./runtime/runtime-http-hook');
const extended = require('./extended-http-api');
const { ProductionSearchService, handleSearchRequest } = require('./search/production-search');
const { authenticate, applySecurityHeaders, safeError } = require('./security/http-security');
const { randomUUID } = require('node:crypto');

// server.js removes the initial extended-api listener and captures it as apiHandler.
// Wrap that listener here so search routes use the verified production identity and
// never bypass the main security boundary.
const originalCreateExtendedApiServer = extended.createExtendedApiServer;
extended.createExtendedApiServer = function createExtendedApiServerWithSearch(options = {}) {
  const result = originalCreateExtendedApiServer(options);
  if (!result?.server || !options.repository) return result;
  const originalListeners = result.server.listeners.bind(result.server);
  result.server.listeners = function listenersWithSearch(eventName) {
    const listeners = originalListeners(eventName);
    if (eventName !== 'request' || !listeners.length) return listeners;
    const baseHandler = listeners[0];
    const pool = options.repository.db.pool;
    const search = new ProductionSearchService({ pool });
    const wrapped = async (request, response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/v1/search')) return baseHandler(request, response);
      const requestId = request.headers['x-request-id'] || randomUUID();
      response.setHeader('x-request-id', requestId);
      applySecurityHeaders(response);
      try {
        const auth = authenticate(request, {
          apiToken: process.env.API_BEARER_TOKEN || null,
          authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null,
          staticActor: process.env.FORGE_STATIC_ACTOR_ID || null,
          staticTenant: process.env.FORGE_STATIC_TENANT_ID || null,
        });
        if (!auth) return safeError(response, 401, 'UNAUTHORIZED', requestId);
        return handleSearchRequest(request, response, { pool, auth, observability: null, service: search });
      } catch (error) {
        return safeError(response, error.statusCode || 500, error.code || 'INTERNAL_ERROR', requestId);
      }
    };
    return [wrapped, ...listeners.slice(1)];
  };
  return result;
};

installHttpVersioning();
require('./server');
