'use strict';

require('../crypto/bootstrap');

const http = require('node:http');
const { Pool } = require('pg');
const { authenticate, hasRole } = require('../security/http-security');
const { SecretCipher } = require('../runtime/runtime-policy');
const { ProviderCredentialRegistry } = require('./credential-registry');
const { handleCredentialRequest } = require('./credential-http');

const installed = Symbol.for('forge.provider.credentials.http.installed');
if (!http.Server.prototype[installed] && process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.FORGE_CREDENTIAL_POOL_MAX || '3', 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  const cipher = process.env.FORGE_SECRET_ENCRYPTION_KEY ? new SecretCipher(process.env.FORGE_SECRET_ENCRYPTION_KEY) : null;
  const registry = cipher ? new ProviderCredentialRegistry({ pool, secretCipher: cipher, releaseEpoch: process.env.FORGE_RELEASE_ID || null }) : null;
  const originalOn = http.Server.prototype.on;
  http.Server.prototype.on = function credentialControlPlaneOn(event, listener) {
    if (event !== 'request' || typeof listener !== 'function') return originalOn.call(this, event, listener);
    const wrapped = async (request, response) => {
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (!pathname.startsWith('/internal/providers/credentials')) return listener(request, response);
      const auth = authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
      if (!auth) { response.statusCode = 401; response.setHeader('content-type', 'application/json; charset=utf-8'); return response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } })); }
      const requestId = request.headers['x-request-id'] || require('node:crypto').randomUUID();
      const handled = await handleCredentialRequest(request, response, { registry, auth, hasRole: (actor, role) => hasRole(auth, role), pool, requestId });
      if (handled === false) return listener(request, response);
    };
    return originalOn.call(this, event, wrapped);
  };
  http.Server.prototype[installed] = { pool, registry };
}

module.exports = { installed };
