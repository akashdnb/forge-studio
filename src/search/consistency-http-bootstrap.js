const productionSearch = require('./production-search');
const { LockedSearchIndexConsistencyService } = require('./index-consistency-locked');
const { hasRole } = require('../security/http-security');

function readJsonBody(request, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > maxBytes) reject(Object.assign(new Error('Payload too large'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }));
    });
    request.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error('Malformed JSON'), { statusCode: 400, code: 'INVALID_REQUEST' })); }
    });
    request.on('error', reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  return response.end(JSON.stringify(body));
}

async function handleConsistencyRequest(request, response, { pool, auth, requestId }) {
  if (!auth || !hasRole(auth, 'OWNER')) return json(response, 403, { error: 'FORBIDDEN', requestId });
  if (!auth.tenantId) return json(response, 403, { error: 'TENANT_REQUIRED', requestId });
  const url = new URL(request.url || '/', 'http://localhost');
  const pathname = url.pathname;
  if (!pathname.startsWith('/v1/search/consistency/') && !pathname.startsWith('/internal/search/')) return false;
  const service = new LockedSearchIndexConsistencyService({ pool });
  const projectId = url.searchParams.get('projectId') || null;

  if (pathname === '/v1/search/consistency/health' && request.method === 'GET') return json(response, 200, { item: await service.health({ tenantId: auth.tenantId, projectId }) });
  if (pathname === '/v1/search/consistency/lag' && request.method === 'GET') return json(response, 200, { item: await service.lag({ tenantId: auth.tenantId, projectId }) });
  if (pathname === '/v1/search/consistency/verify' && request.method === 'GET') {
    const generationId = url.searchParams.get('generationId') || null;
    const item = await service.verifyGeneration({ tenantId: auth.tenantId, projectId, generationId });
    return json(response, item.ok ? 200 : 409, { item });
  }
  if (pathname === '/v1/search/consistency/repair' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const item = await service.repair({ tenantId: auth.tenantId, projectId: body.projectId || projectId, limit: body.limit });
    return json(response, item.verification.ok ? 200 : 409, { item });
  }
  if (pathname === '/v1/search/consistency/rebuild' && request.method === 'POST') {
    const body = await readJsonBody(request);
    const item = await service.createRebuild({ tenantId: auth.tenantId, actor: auth.actor, projectId: body.projectId || projectId });
    if (body.execute === true) {
      const executed = await service.run({ tenantId: auth.tenantId, actor: auth.actor, generationId: item.generation_id, maxBatches: body.maxBatches || 10 });
      return json(response, 202, { item: executed });
    }
    return json(response, 202, { item });
  }
  const runMatch = pathname.match(/^\/v1\/search\/consistency\/rebuild\/([^/]+)\/run$/);
  if (runMatch && request.method === 'POST') {
    const body = await readJsonBody(request);
    const item = await service.run({ tenantId: auth.tenantId, actor: auth.actor, generationId: runMatch[1], maxBatches: body.maxBatches || 10 });
    return json(response, item.state === 'FAILED' ? 409 : 200, { item });
  }
  const generationMatch = pathname.match(/^\/v1\/search\/consistency\/generations\/([^/]+)$/);
  if (generationMatch && request.method === 'GET') {
    const item = await service.getGeneration({ tenantId: auth.tenantId, generationId: generationMatch[1] });
    return json(response, 200, { item });
  }
  if (pathname === '/internal/search/metrics' && request.method === 'GET') {
    const [health, lag] = await Promise.all([service.health({ tenantId: auth.tenantId, projectId }), service.lag({ tenantId: auth.tenantId, projectId })]);
    return json(response, 200, { metrics: {
      search_index_lag_events: lag.lag,
      search_index_documents: health.indexedCount,
      search_index_generation_epoch: health.generationEpoch,
      search_index_cross_tenant_documents: health.crossTenantCount,
      search_index_rebuilds_failed: health.generations.filter(g => g.state === 'FAILED').length,
      search_index_state: health.state,
    } });
  }
  return false;
}

const originalHandleSearchRequest = productionSearch.handleSearchRequest;
productionSearch.handleSearchRequest = async function handleSearchRequestWithConsistency(request, response, options) {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname.startsWith('/v1/search/consistency/') || pathname.startsWith('/internal/search/')) {
    const requestId = request.headers?.['x-request-id'] || '';
    const handled = await handleConsistencyRequest(request, response, { pool: options.pool, auth: options.auth, requestId });
    if (handled !== false) return handled;
  }
  return originalHandleSearchRequest(request, response, options);
};

module.exports = { handleConsistencyRequest };
