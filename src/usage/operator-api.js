const http = require('node:http');
const { URL } = require('node:url');
const { timingSafeEqual } = require('node:crypto');

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function json(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function tokenOk(expected, actual) {
  if (!expected || typeof actual !== 'string') return false;
  const a = Buffer.from(expected); const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
function tenantFrom(req) {
  const tenant = req.headers['x-tenant-id'];
  if (!tenant || typeof tenant !== 'string') throw Object.assign(new Error('x-tenant-id is required'), { statusCode: 400 });
  return tenant;
}
function createUsageOperatorServer({ ledger, token = process.env.FORGE_USAGE_OPERATOR_TOKEN, logger = console } = {}) {
  if (!ledger) throw new TypeError('ledger is required');
  return http.createServer(async (req, res) => {
    if (!tokenOk(token, (req.headers.authorization || '').replace(/^Bearer\s+/i, ''))) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'operator bearer token required' } });
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname.split('/').filter(Boolean);
      const tenantId = tenantFrom(req);
      if (req.method === 'GET' && path[0] === 'v1' && path[1] === 'usage' && path[2] === 'ledger') {
        return send(res, 200, { items: await ledger.inspect({ tenantId, projectId: url.searchParams.get('projectId'), dimension: url.searchParams.get('dimension'), limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }) });
      }
      if (req.method === 'GET' && path[0] === 'v1' && path[1] === 'usage' && path[2] === 'totals') {
        return send(res, 200, { items: await ledger.totals({ tenantId, projectId: url.searchParams.get('projectId'), currency: url.searchParams.get('currency') }) });
      }
      if (req.method === 'GET' && path[0] === 'v1' && path[1] === 'usage' && path[2] === 'integrity') return send(res, 200, await ledger.verifyTenant(tenantId));
      if (req.method === 'POST' && path[0] === 'v1' && path[1] === 'usage' && path[2] === 'reconcile') {
        const body = await json(req);
        if (body.tenantId && body.tenantId !== tenantId) throw Object.assign(new Error('tenantId cannot differ from x-tenant-id'), { statusCode: 403 });
        return send(res, 200, await ledger.reconcile({ tenantId, source: body.source, windowStart: body.windowStart, windowEnd: body.windowEnd, externalEvents: body.externalEvents || [] }));
      }
      if (req.method === 'POST' && path[0] === 'v1' && path[1] === 'usage' && path[2] === 'adjustments' && path[3] && path[4] === 'decision') {
        const body = await json(req);
        return send(res, 200, await ledger.decideAdjustment({ adjustmentId: path[3], approve: body.approve === true, actor: req.headers['x-actor-id'] || 'operator', note: body.note || '' }));
      }
      if (req.method === 'POST' && path[0] === 'v1' && path[1] === 'usage' && path[2] === 'adjustments') {
        const body = await json(req);
        return send(res, 201, await ledger.requestAdjustment({ ...body, tenantId, requestedBy: req.headers['x-actor-id'] || 'operator' }));
      }
      return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
    } catch (error) {
      logger.error?.(error);
      return send(res, error.statusCode || 400, { error: { code: error.code || 'INVALID_REQUEST', message: error.message } });
    }
  });
}
module.exports = { createUsageOperatorServer };
