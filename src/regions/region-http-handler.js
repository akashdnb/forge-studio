const { dryRunFailover, executeFailover, recoverOrFailback, acquireLease, health, requireOperator } = require('./region-control-plane');

async function readJson(request) {
  return new Promise((resolve, reject) => { let body = ''; request.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) reject(Object.assign(new Error('payload too large'), { statusCode: 413 })); }); request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { statusCode: 400 })); } }); request.on('error', reject); });
}
function json(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
async function handleRegionRequest(request, response, { pool }) {
  try {
    const auth = request._auth || { actor: process.env.FORGE_STATIC_ACTOR_ID || 'internal', roles: ['PLATFORM_OPERATOR'] };
    requireOperator(auth);
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/internal/regions/health') {
      const regionId = new URL(request.url, 'http://localhost').searchParams.get('region') || process.env.FORGE_REGION_ID || 'primary';
      return json(response, 200, await health(pool, regionId));
    }
    if (request.method === 'POST' && pathname === '/internal/regions/failover/dry-run') return json(response, 200, await dryRunFailover(pool, await readJson(request)));
    if (request.method === 'POST' && pathname === '/internal/regions/failover') return json(response, 200, await executeFailover(pool, { ...(await readJson(request)), actorId: auth.actor }));
    if (request.method === 'POST' && pathname === '/internal/regions/recover') return json(response, 200, await recoverOrFailback(pool, { ...(await readJson(request)), actorId: auth.actor }));
    if (request.method === 'POST' && pathname === '/internal/regions/lease') return json(response, 201, await acquireLease(pool, { ...(await readJson(request)), ownerId: auth.actor }));
    return json(response, 404, { error: 'NOT_FOUND' });
  } catch (error) { return json(response, error.statusCode || 500, { error: error.code || 'INTERNAL_ERROR', message: error.message, tenants: error.tenants || undefined }); }
}
module.exports = { handleRegionRequest };
