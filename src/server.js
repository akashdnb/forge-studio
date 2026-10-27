const { createExtendedApiServer } = require('./extended-http-api');
const { PersistentProductionRepository } = require('./persistence/production-repository');
const { UsageAccountingService } = require('./usage/usage-accounting');
const { handleGithubRunnerCallback } = require('./execution/github-actions-callback');
const { URL } = require('node:url');
const { timingSafeEqual } = require('node:crypto');

const port = Number.parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('PORT must be an integer between 1 and 65535');

function tokenMatches(expected, actual) { if (!expected || typeof actual !== 'string') return false; const a=Buffer.from(expected); const b=Buffer.from(actual); return a.length===b.length && timingSafeEqual(a,b); }
function usageAuthorized(request) { const match=/^Bearer\s+(.+)$/i.exec(request.headers.authorization || ''); return tokenMatches(process.env.API_BEARER_TOKEN || '', match?.[1]); }
function usageSend(response,status,body){response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(body));}

async function start() {
  let repository = null; let pool = null; let usage = null;
  if (process.env.DATABASE_URL) {
    let Pool; try { ({ Pool } = require('pg')); } catch { throw new Error('DATABASE_URL is set but the optional pg package is unavailable'); }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number.parseInt(process.env.PG_POOL_MAX || '10', 10), idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    repository = new PersistentProductionRepository({ pool });
    usage = new UsageAccountingService({ pool });
    try { await pool.query('SELECT 1'); } catch (error) { await pool.end(); throw new Error(`PostgreSQL connection failed: ${error.message}`); }
    if (process.env.RUN_MIGRATIONS_ON_START === 'true') await repository.migrate();
    if (usage.required) await usage.syncConfiguration();
  }
  const { server } = createExtendedApiServer({ repository, apiToken: process.env.API_BEARER_TOKEN || null, allowUnauthenticatedRead: process.env.ALLOW_UNAUTHENTICATED_READS === 'true' });
  const apiHandler = server.listeners('request')[0]; server.removeAllListeners('request');
  server.on('request', async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/internal/github-actions/callback') {
      if (!repository) return response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'PERSISTENCE_UNAVAILABLE', message: 'PostgreSQL is required for runner callbacks' } }));
      return handleGithubRunnerCallback(request, response, { pool, token: process.env.FORGE_RUNNER_CALLBACK_TOKEN });
    }
    if (usage && /^\/v1\/usage(?:\/|$)/.test(pathname)) {
      if (!usageAuthorized(request)) return usageSend(response, 401, { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required' } });
      try {
        const url = new URL(request.url || '/', 'http://localhost');
        if (request.method !== 'GET') return usageSend(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Usage endpoints are read-only' } });
        if (pathname === '/v1/usage/health') {
          const budgets = await pool.query("SELECT state,COUNT(*)::int count FROM usage_budgets GROUP BY state ORDER BY state");
          const reservations = await pool.query("SELECT status,COUNT(*)::int count FROM usage_reservations GROUP BY status ORDER BY status");
          const events = await pool.query("SELECT COUNT(*)::int count,COALESCE(SUM(actual_cost),0)::text actual_cost FROM usage_events");
          return usageSend(response, 200, { enforcementEnabled: usage.required, budgets: budgets.rows, reservations: reservations.rows, events: events.rows[0] });
        }
        const match = /^\/v1\/usage\/(episodes|projects|providers)\/([^/]+)$/.exec(pathname);
        if (!match) return usageSend(response, 404, { error: { code: 'NOT_FOUND', message: 'Usage endpoint not found' } });
        const type = match[1]; const value = decodeURIComponent(match[2]);
        if (type === 'episodes') return usageSend(response, 200, { item: await usage.summary({ episodeId: value }) });
        if (type === 'projects') return usageSend(response, 200, { item: await usage.summary({ projectId: value }) });
        return usageSend(response, 200, { item: await usage.summary({ provider: value }) });
      } catch (error) { return usageSend(response, error.code === 'NOT_FOUND' ? 404 : 422, { error: { code: error.code || 'USAGE_ERROR', message: error.message } }); }
    }
    return apiHandler(request, response);
  });
  server.prependListener('request', (request, response) => {
    const origin = request.headers.origin; const allowedOrigin = process.env.CORS_ORIGIN || '';
    if (origin && allowedOrigin && (allowedOrigin === '*' || origin === allowedOrigin)) {
      response.setHeader('access-control-allow-origin', allowedOrigin === '*' ? '*' : origin); response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS'); response.setHeader('access-control-allow-headers', 'authorization,content-type,x-actor-id,x-request-id,x-forge-runner-token'); response.setHeader('access-control-max-age', '600'); response.setHeader('vary', 'Origin');
      if (request.method === 'OPTIONS') { request.method = 'GET'; request.url = '/healthz'; }
    }
    response.setHeader('x-frame-options', 'DENY'); response.setHeader('x-content-type-options', 'nosniff'); response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()'); response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  });
  server.listen(port, host, () => console.log(`Forge Studio API listening on ${host}:${port}; persistence=${repository ? 'postgres' : 'in-memory'}`));
  let shuttingDown = false;
  async function shutdown(signal) { if (shuttingDown) return; shuttingDown=true; const timeout=setTimeout(()=>{console.error(`Forced shutdown after ${signal}`);process.exit(1)},10000);timeout.unref();server.close(async(error)=>{if(error){console.error(`Failed to close HTTP server after ${signal}`,error.message);process.exitCode=1;}if(pool)await pool.end().catch(()=>{});clearTimeout(timeout);process.exit();}); }
  process.on('SIGTERM',()=>shutdown('SIGTERM')); process.on('SIGINT',()=>shutdown('SIGINT'));
}
start().catch((error)=>{console.error('Forge API startup failed:',error.message);process.exitCode=1;});
