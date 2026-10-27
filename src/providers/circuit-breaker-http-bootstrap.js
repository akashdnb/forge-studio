'use strict';
require('../fairness/http-auto');

const extended = require('../extended-http-api');
const { authenticate, applySecurityHeaders, safeError, hasRole } = require('../security/http-security');
const { handleProviderCircuitBreakerRequest } = require('./circuit-breaker-http');

if (!extended.__forgeProviderCircuitBreakerHttpPatched) {
  const original = extended.createExtendedApiServer;
  extended.createExtendedApiServer = function createExtendedApiServerWithProviderCircuitBreaker(options = {}) {
    const result = original(options);
    if (!result?.server || !options.repository) return result;
    const originalListeners = result.server.listeners.bind(result.server);
    result.server.listeners = function listenersWithProviderCircuitBreaker(eventName) {
      const listeners = originalListeners(eventName);
      if (eventName !== 'request' || !listeners.length) return listeners;
      const base = listeners[0];
      const pool = options.repository.db.pool;
      const wrapped = async (request, response) => {
        applySecurityHeaders(response);
        const auth = request._auth || authenticate(request, {
          apiToken: process.env.API_BEARER_TOKEN || null,
          authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null,
          staticActor: process.env.FORGE_STATIC_ACTOR_ID || null,
          staticTenant: process.env.FORGE_STATIC_TENANT_ID || null,
        });
        if (!auth) return safeError(response, 401, 'UNAUTHORIZED', request.headers['x-request-id'] || '');
        request._auth = auth;
        const handled = await handleProviderCircuitBreakerRequest(request, response, { pool, auth, hasRole, safeError });
        if (handled !== false) return handled;
        return base(request, response);
      };
      return [wrapped, ...listeners.slice(1)];
    };
    return result;
  };
  extended.__forgeProviderCircuitBreakerHttpPatched = true;
}
