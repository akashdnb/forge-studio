const { createExtendedApiServer } = require('./extended-http-api');
const { PersistentProductionRepository } = require('./persistence/production-repository');
const { handleGithubRunnerCallback } = require('./execution/github-actions-callback');
const { JobQueue } = require('./persistence/job-queue');
const { WorkflowScheduler } = require('./scheduling/workflow-scheduler');
const { timingSafeEqual } = require('node:crypto');
const { URL } = require('node:url');

const port = Number.parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('PORT must be an integer between 1 and 65535');

function tokenMatches(expected, actual) { if (!expected || typeof actual !== 'string') return false; const a=Buffer.from(expected); const b=Buffer.from(actual); return a.length===b.length&&timingSafeEqual(a,b); }
async function start() {
  let repository = null; let pool = null; let scheduler = null;
  if (process.env.DATABASE_URL) {
    let Pool;
    try { ({ Pool } = require('pg')); } catch { throw new Error('DATABASE_URL is set but the optional pg package is unavailable'); }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '10', 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    repository = new PersistentProductionRepository({ pool });
    try { await pool.query('SELECT 1'); } catch (error) { await pool.end(); throw new Error(`PostgreSQL connection failed: ${error.message}`); }
    if (process.env.RUN_MIGRATIONS_ON_START === 'true') await repository.migrate();
    scheduler = new WorkflowScheduler({ pool, queue: new JobQueue({ pool }), schedulerId: 'forge-api-metrics' });
  }
  const { server } = createExtendedApiServer({ repository, apiToken: process.env.API_BEARER_TOKEN || null, allowUnauthenticatedRead: process.env.ALLOW_UNAUTHENTICATED_READS === 'true' });
  const apiHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/internal/github-actions/callback') {
      if (!repository) return response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'PERSISTENCE_UNAVAILABLE', message: 'PostgreSQL is required for runner callbacks' } }));
      return handleGithubRunnerCallback(request, response, { pool, token: process.env.FORGE_RUNNER_CALLBACK_TOKEN });
    }
    if (pathname === '/internal/scheduler/metrics' || pathname === '/internal/scheduler/health') {
      const auth = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '');
      if (!repository || !tokenMatches(process.env.API_BEARER_TOKEN || '', auth?.[1])) return response.writeHead(repository ? 401 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: repository ? 'UNAUTHORIZED' : 'PERSISTENCE_UNAVAILABLE' } }));
      try { const metrics=await scheduler.metrics(); return response.writeHead(200, { 'content-type':'application/json','cache-control':'no-store' }).end(JSON.stringify({status:'ok',schedulerId:scheduler.schedulerId,metrics})); } catch(error) { return response.writeHead(503, { 'content-type':'application/json' }).end(JSON.stringify({status:'unhealthy',error:{message:error.message}})); }
    }
    return apiHandler(request, response);
  });
  server.prependListener('request', (request, response) => {
    const origin = request.headers.origin; const allowedOrigin = process.env.CORS_ORIGIN || '';
    if (origin && allowedOrigin && (allowedOrigin === '*' || origin === allowedOrigin)) {
      response.setHeader('access-control-allow-origin', allowedOrigin === '*' ? '*' : origin); response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      response.setHeader('access-control-allow-headers', 'authorization,content-type,x-actor-id,x-request-id,x-forge-runner-token'); response.setHeader('access-control-max-age', '600'); response.setHeader('vary', 'Origin');
      if (request.method === 'OPTIONS') { request.method = 'GET'; request.url = '/healthz'; }
    }
    response.setHeader('x-frame-options', 'DENY'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });
  server.listen(port, host, () => console.log(`Forge Studio API listening on ${host}:${port}; persistence=${repository ? 'postgres' : 'in-memory'}`));
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return; shuttingDown = true;
    const timeout = setTimeout(() => { console.error(`Forced shutdown after ${signal}`); process.exit(1); }, 10000); timeout.unref();
    server.close(async (error) => { if (error) { console.error(`Failed to close HTTP server after ${signal}`, error.message); process.exitCode = 1; } if (pool) await pool.end().catch(() => {}); clearTimeout(timeout); process.exit(); });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
}
start().catch((error) => { console.error('Forge API startup failed:', error.message); process.exitCode = 1; });
