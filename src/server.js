const { createExtendedApiServer } = require('./extended-http-api');
const { PersistentProductionRepository } = require('./persistence/production-repository');
const { handleGithubRunnerCallback } = require('./execution/github-actions-callback');
const { createStorageFromEnv } = require('./storage');
const { ProductionArtifactAccessGateway } = require('./storage/production-artifact-access-gateway');
const { handleArtifactAccess, bearerActor } = require('./storage/artifact-access-http');
const { URL } = require('node:url');
const port = Number.parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('PORT must be an integer between 1 and 65535');
function sendJson(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(body)); }
async function start() {
  let repository = null; let pool = null; let artifactGateway = null;
  if (process.env.DATABASE_URL) {
    let Pool;
    try { ({ Pool } = require('pg')); } catch { throw new Error('DATABASE_URL is set but the optional pg package is unavailable'); }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '10', 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    repository = new PersistentProductionRepository({ pool });
    try { await pool.query('SELECT 1'); } catch (error) { await pool.end(); throw new Error(`PostgreSQL connection failed: ${error.message}`); }
    if (process.env.RUN_MIGRATIONS_ON_START === 'true') await repository.migrate();
    artifactGateway = new ProductionArtifactAccessGateway({ repository, storage: createStorageFromEnv() });
  }
  const apiToken = process.env.API_BEARER_TOKEN || null;
  const { server } = createExtendedApiServer({ repository, apiToken, allowUnauthenticatedRead: process.env.ALLOW_UNAUTHENTICATED_READS === 'true' });
  const apiHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/internal/github-actions/callback') {
      if (!repository) return sendJson(response, 503, { error: { code: 'PERSISTENCE_UNAVAILABLE', message: 'PostgreSQL is required for runner callbacks' } });
      return handleGithubRunnerCallback(request, response, { pool, token: process.env.FORGE_RUNNER_CALLBACK_TOKEN });
    }
    if (artifactGateway && (pathname === '/internal/artifact-gateway/healthz' || pathname === '/internal/artifact-gateway/metrics')) {
      if (!bearerActor(request, apiToken)) return sendJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' } });
      if (pathname.endsWith('/healthz')) {
        try { await pool.query('SELECT 1'); return sendJson(response, 200, { status: 'ready', gateway: 'enabled', storageDriver: process.env.FORGE_STORAGE_DRIVER || 'local', maxRangeBytes: artifactGateway.maxRangeBytes, maxTransferBytes: artifactGateway.maxTransferBytes }); }
        catch { return sendJson(response, 503, { status: 'not-ready', gateway: 'enabled' }); }
      }
      const result = await pool.query(`SELECT action,count(*)::int AS count FROM audit_events WHERE target_type='artifact' AND created_at >= now() - interval '15 minutes' GROUP BY action ORDER BY action`);
      return sendJson(response, 200, { windowMinutes: 15, accessEvents: result.rows });
    }
    if (artifactGateway && (pathname.startsWith('/v1/artifacts/') || pathname === '/v1/artifacts')) return handleArtifactAccess(request, response, { gateway: artifactGateway, apiToken });
    return apiHandler(request, response);
  });
  server.prependListener('request', (request, response) => {
    const origin = request.headers.origin; const allowedOrigin = process.env.CORS_ORIGIN || '';
    if (origin && allowedOrigin && (allowedOrigin === '*' || origin === allowedOrigin)) {
      response.setHeader('access-control-allow-origin', allowedOrigin === '*' ? '*' : origin); response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS'); response.setHeader('access-control-allow-headers', 'authorization,content-type,x-actor-id,x-request-id,x-forge-runner-token,x-forge-artifact-purpose,x-forge-artifact-recovery,range'); response.setHeader('access-control-max-age', '600'); response.setHeader('vary', 'Origin');
      if (request.method === 'OPTIONS') { request.method = 'GET'; request.url = '/healthz'; }
    }
    response.setHeader('x-frame-options', 'DENY'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()'); response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });
  server.listen(port, host, () => console.log(`Forge Studio API listening on ${host}:${port}; persistence=${repository ? 'postgres' : 'in-memory'}; artifactGateway=${artifactGateway ? 'enabled' : 'disabled'}`));
  let shuttingDown = false;
  async function shutdown(signal) { if (shuttingDown) return; shuttingDown = true; const timeout = setTimeout(() => { console.error(`Forced shutdown after ${signal}`); process.exit(1); }, 10000); timeout.unref(); server.close(async (error) => { if (error) { console.error(`Failed to close HTTP server after ${signal}`, error.message); process.exitCode = 1; } if (pool) await pool.end().catch(() => {}); clearTimeout(timeout); process.exit(); }); }
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
}
start().catch((error) => { console.error('Forge API startup failed:', error.message); process.exitCode = 1; });
