'use strict';

const { SecurityPolicyService, inferAction } = require('./policy-enforcement');
const { CapabilityTokenService } = require('./capability-tokens');
const { assertNoSecrets, redactForAudit } = require('./secret-boundary');
const { authenticate } = require('./http-security');

const metrics = { counts: new Map(), inc(name, labels = {}) { const key = `${name}:${JSON.stringify(labels)}`; this.counts.set(key, (this.counts.get(key) || 0) + 1); }, snapshot() { return [...this.counts.entries()].map(([key, value]) => ({ key, value })); } };

function resourceFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const pairs = [['projects', 'project'], ['episodes', 'episode'], ['artifacts', 'artifact'], ['provider-runs', 'provider_run'], ['jobs', 'job'], ['executions', 'execution']];
  for (const [segment, resourceType] of pairs) {
    const index = parts.indexOf(segment);
    if (index >= 0 && parts[index + 1]) return { resourceType, resourceId: decodeURIComponent(parts[index + 1]) };
  }
  return null;
}
function verifiedAuth(request) {
  return authenticate(request, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
}

function patchArtifactGateway() {
  try {
    const { ProductionArtifactAccessGateway } = require('../storage/production-artifact-access-gateway');
    if (ProductionArtifactAccessGateway.prototype.__forgeSecurityBoundaryPatched) return;
    const originalIssue = ProductionArtifactAccessGateway.prototype.issueToken;
    const originalResolve = ProductionArtifactAccessGateway.prototype.resolve;
    ProductionArtifactAccessGateway.prototype.issueToken = async function issueTokenWithSecurity(args = {}) {
      assertNoSecrets({ ...args, token: undefined }, 'artifact-access-request');
      const policy = new SecurityPolicyService({ pool: this.repository.db.pool, metrics });
      await policy.authorize({ auth: { actor: args.actor, tenantId: args.tenantId, roles: ['VIEWER'] }, action: 'read', resourceType: 'artifact', resourceId: args.artifactId });
      return originalIssue.call(this, args);
    };
    ProductionArtifactAccessGateway.prototype.resolve = async function resolveWithSecurity(args = {}) {
      assertNoSecrets({ ...args, token: undefined }, 'artifact-access-request');
      if (args.tenantId && args.actor && !this.workerActors?.has?.(args.actor) && !this.adminActors?.has?.(args.actor)) {
        const policy = new SecurityPolicyService({ pool: this.repository.db.pool, metrics });
        await policy.authorize({ auth: { actor: args.actor, tenantId: args.tenantId, roles: ['VIEWER'] }, action: 'read', resourceType: 'artifact', resourceId: args.artifactId });
      }
      return originalResolve.call(this, args);
    };
    ProductionArtifactAccessGateway.prototype.__forgeSecurityBoundaryPatched = true;
  } catch { /* artifact gateway is optional in API-only processes */ }
}

function patchCredentialRegistry() {
  try {
    const { ProviderCredentialRegistry } = require('../providers/credential-registry');
    if (ProviderCredentialRegistry.prototype.__forgeSecurityBoundaryPatched) return;
    for (const method of ['create', 'rotate', 'revoke', 'retire', 'selectAndLease']) {
      const original = ProviderCredentialRegistry.prototype[method]; if (typeof original !== 'function') continue;
      ProviderCredentialRegistry.prototype[method] = async function securityCredentialBoundary(args = {}) {
        assertNoSecrets({ ...args, material: args.material ? '[REDACTED]' : undefined }, `credential-${method}`);
        return original.call(this, args);
      };
    }
    ProviderCredentialRegistry.prototype.__forgeSecurityBoundaryPatched = true;
  } catch { /* credential subsystem is optional */ }
}

function patchRunnerCallbacks() {
  try {
    const callback = require('../execution/github-actions-callback');
    if (callback.__forgeSecurityBoundaryPatched) return;
    const original = callback.handleGithubRunnerCallback;
    callback.handleGithubRunnerCallback = async function securedRunnerCallback(req, res, options = {}) {
      if (req.body) assertNoSecrets(req.body, 'runner-callback');
      return original(req, res, options);
    };
    callback.__forgeSecurityBoundaryPatched = true;
  } catch { /* callback module is loaded only by runner API */ }
}

function installExtendedPolicy() {
  try {
    const extended = require('../extended-http-api');
    if (extended.__forgeSecurityBoundaryPatched) return;
    const originalCreate = extended.createExtendedApiServer;
    extended.createExtendedApiServer = function securedExtendedApiServer(options = {}) {
      const result = originalCreate(options); if (!result?.server || !options.repository) return result;
      const originalListeners = result.server.listeners.bind(result.server);
      const pool = options.repository.db.pool;
      const policy = new SecurityPolicyService({ pool, metrics });
      result.server.listeners = function securedListeners(eventName) {
        const listeners = originalListeners(eventName); if (eventName !== 'request' || !listeners.length) return listeners;
        const base = listeners[0];
        const wrapped = async (request, response) => {
          const url = new URL(request.url || '/', 'http://localhost'); const pathname = url.pathname;
          const auth = verifiedAuth(request);
          if (pathname === '/internal/security/health') {
            if (!auth) { response.writeHead(401, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } })); }
            try { await policy.authorize({ auth, action: 'diagnostics', requestId: request.headers['x-request-id'], method: request.method, pathname }); const health = await policy.health(); response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return response.end(JSON.stringify({ ...health, metrics: metrics.snapshot() })); }
            catch (error) { response.writeHead(error.statusCode || 403, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return response.end(JSON.stringify({ error: { code: error.code || 'FORBIDDEN', message: 'Security diagnostics unavailable' } })); }
          }
          try {
            if (!auth || auth.kind === 'public') return base(request, response);
            const resource = resourceFromPath(pathname);
            const projectId = resource?.resourceType === 'project' ? resource.resourceId : url.searchParams.get('projectId');
            await policy.authorize({ auth, action: inferAction(request.method || 'GET', pathname), projectId, resourceType: resource?.resourceType === 'project' ? null : resource?.resourceType, resourceId: resource?.resourceType === 'project' ? null : resource?.resourceId, requestId: request.headers['x-request-id'], method: request.method, pathname });
            return base(request, response);
          } catch (error) {
            metrics.inc('forge_security_policy_denials_total', { code: error.code || 'POLICY_DENIED' });
            response.writeHead(error.statusCode || 403, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
            return response.end(JSON.stringify({ error: { code: error.code || 'POLICY_DENIED', message: error.code === 'SECURITY_POLICY_MISSING' ? error.message : 'Access denied by security policy' } }));
          }
        };
        return [wrapped, ...listeners.slice(1)];
      };
      return result;
    };
    extended.__forgeSecurityBoundaryPatched = true;
  } catch { /* extended API is unavailable in worker-only contexts */ }
}

function install() { patchArtifactGateway(); patchCredentialRegistry(); patchRunnerCallbacks(); installExtendedPolicy(); }
install();
module.exports = { install, metrics, redactForAudit, CapabilityTokenService };
