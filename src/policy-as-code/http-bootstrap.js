'use strict';

const extended = require('../extended-http-api');
const { authenticate, hasRole } = require('../security/http-security');
const { handlePolicyRequest } = require('./bootstrap');

if (!extended.__forgePolicyHttpPatched) {
  const original = extended.createExtendedApiServer;
  extended.createExtendedApiServer = function createExtendedApiServerWithPolicy(options = {}) {
    const result = original(options);
    if (!result?.server || !options.repository) return result;
    const listeners = result.server.listeners.bind(result.server);
    result.server.listeners = function policyListeners(eventName) {
      const current = listeners(eventName);
      if (eventName !== 'request' || !current.length) return current;
      const base = current[0];
      const pool = options.repository.db.pool;
      const wrapped = async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        if (!pathname.startsWith('/internal/policy')) return base(request, response);
        const auth = request._auth || authenticate(request, {
          apiToken: process.env.API_BEARER_TOKEN || null,
          authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null,
          staticActor: process.env.FORGE_STATIC_ACTOR_ID || null,
          staticTenant: process.env.FORGE_STATIC_TENANT_ID || null
        });
        return handlePolicyRequest(request, response, { pool, auth, hasRole });
      };
      return [wrapped, ...current.slice(1)];
    };
    return result;
  };
  extended.__forgePolicyHttpPatched = true;
}
