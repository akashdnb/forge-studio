const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { authenticate, hasRole, applySecurityHeaders } = require('../security/http-security');
const { DurableEventDelivery, EVENT_SCHEMAS, verifyWebhookSignature } = require('./durable-delivery');

async function readJson(req, limit = 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request body exceeds 1 MiB'), { statusCode: 413 }); chunks.push(chunk); }
  if (!size) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('JSON body must be an object'); return value;
}
function send(res, status, body, requestId) { applySecurityHeaders(res); res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('x-request-id',requestId); res.writeHead(status); res.end(JSON.stringify(body)); }

function createDurableEventApi({ pool, authSecret = process.env.FORGE_AUTH_SIGNING_SECRET, apiToken = process.env.API_BEARER_TOKEN, staticActor = process.env.FORGE_STATIC_ACTOR_ID, staticTenant = process.env.FORGE_STATIC_TENANT_ID, logger = console } = {}) {
  const delivery = new DurableEventDelivery({ pool, logger });
  const server = http.createServer(async (req, res) => {
    const requestId = req.headers['x-request-id'] || randomUUID();
    try {
      const auth = authenticate(req, { apiToken, authSecret, staticActor, staticTenant });
      if (!auth) return send(res, 401, { error: { code: 'UNAUTHORIZED' } }, requestId);
      const url = new URL(req.url || '/', 'http://localhost'); const path = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok', component: 'event-delivery' }, requestId);
      if (req.method === 'GET' && url.pathname === '/v1/event-schemas') return send(res, 200, { schemas: EVENT_SCHEMAS }, requestId);
      if (req.method === 'GET' && url.pathname === '/v1/event-subscriptions') {
        const rows = await pool.query('SELECT id,tenant_id,project_id,endpoint_url,event_types,ordered,rate_limit_per_second,max_concurrency,active,created_by,created_at,updated_at FROM forge_event_subscriptions WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2) ORDER BY created_at DESC', [auth.tenantId, url.searchParams.get('projectId')]);
        return send(res, 200, { items: rows.rows }, requestId);
      }
      if (req.method === 'POST' && url.pathname === '/v1/event-subscriptions') {
        if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const body = await readJson(req); if (body.tenantId && body.tenantId !== auth.tenantId) return send(res, 403, { error: { code: 'TENANT_MISMATCH' } }, requestId);
        if (body.projectId) { const access = await pool.query('SELECT 1 FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$2 WHERE p.id=$1 AND p.tenant_id=$3 AND (m.actor_id IS NOT NULL OR p.created_by=$2)', [body.projectId, auth.actor, auth.tenantId]); if (!access.rows[0]) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId); }
        const item = await delivery.createSubscription({ ...body, tenantId: auth.tenantId, createdBy: auth.actor }); return send(res, 201, { item }, requestId);
      }
      if (path[0] === 'v1' && path[1] === 'event-subscriptions' && path[2]) {
        const id = decodeURIComponent(path[2]); const sub = (await pool.query('SELECT * FROM forge_event_subscriptions WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId])).rows[0]; if (!sub) return send(res, 404, { error: { code: 'NOT_FOUND' } }, requestId);
        if (req.method === 'PATCH') { if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId); const body = await readJson(req); const updated = await pool.query('UPDATE forge_event_subscriptions SET active=COALESCE($2,active),ordered=COALESCE($3,ordered),rate_limit_per_second=COALESCE($4,rate_limit_per_second),max_concurrency=COALESCE($5,max_concurrency),updated_at=now() WHERE id=$1 AND tenant_id=$6 RETURNING id,tenant_id,project_id,endpoint_url,event_types,ordered,rate_limit_per_second,max_concurrency,active,created_by,created_at,updated_at', [id, body.active, body.ordered, body.rateLimitPerSecond, body.maxConcurrency, auth.tenantId]); return send(res, 200, { item: updated.rows[0] }, requestId); }
        if (req.method === 'DELETE') { if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId); await pool.query('UPDATE forge_event_subscriptions SET active=false,updated_at=now() WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId]); await pool.query("UPDATE forge_event_deliveries SET status='CANCELLED',completed_at=now(),updated_at=now() WHERE subscription_id=$1 AND tenant_id=$2 AND status IN ('PENDING','RETRY')", [id, auth.tenantId]); return send(res, 204, {}, requestId); }
      }
      if (req.method === 'GET' && url.pathname === '/v1/event-deliveries') { const rows = await pool.query(`SELECT d.id,d.event_id,d.subscription_id,d.project_id,d.status,d.attempts,d.available_at,d.lease_until,d.last_error,d.last_response_status,d.completed_at,d.created_at,d.updated_at FROM forge_event_deliveries d WHERE d.tenant_id=$1 AND ($2::text IS NULL OR d.project_id=$2) AND ($3::text IS NULL OR d.status=$3) ORDER BY d.created_at DESC LIMIT $4`, [auth.tenantId,url.searchParams.get('projectId'),url.searchParams.get('status'),Math.min(200,Math.max(1,Number(url.searchParams.get('limit')||50)))]); return send(res,200,{items:rows.rows},requestId); }
      if (path[0] === 'v1' && path[1] === 'event-deliveries' && path[2]) {
        const id = decodeURIComponent(path[2]); const row = (await pool.query('SELECT * FROM forge_event_deliveries WHERE id=$1 AND tenant_id=$2',[id,auth.tenantId])).rows[0]; if (!row) return send(res,404,{error:{code:'NOT_FOUND'}},requestId);
        if (req.method === 'POST' && path[3] === 'cancel') { if (!hasRole(auth,'OWNER')) return send(res,403,{error:{code:'FORBIDDEN'}},requestId); return send(res,200,{item:await delivery.cancelDelivery(id,auth.actor)},requestId); }
        if (req.method === 'POST' && path[3] === 'replay') { if (!hasRole(auth,'OWNER')) return send(res,403,{error:{code:'FORBIDDEN'}},requestId); const updated=await pool.query("UPDATE forge_event_deliveries SET status='RETRY',available_at=now(),last_error=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status IN ('SUCCEEDED','FAILED','DEAD_LETTER','RETRY','PENDING') RETURNING *",[id,auth.tenantId]); return send(res,200,{item:updated.rows[0]},requestId); }
      }
      if (req.method === 'GET' && url.pathname === '/v1/event-delivery/metrics') { if (!hasRole(auth,'VIEWER')) return send(res,403,{error:{code:'FORBIDDEN'}},requestId); return send(res,200,{item:await delivery.metrics({tenantId:auth.tenantId})},requestId); }
      return send(res,404,{error:{code:'NOT_FOUND'}},requestId);
    } catch (error) { logger.error?.(JSON.stringify({requestId,component:'event-delivery-api',code:error.code||'REQUEST_FAILURE',message:error.message})); return send(res,error.statusCode||400,{error:{code:error.code||'INVALID_REQUEST',message:error.message}},requestId); }
  });
  return { server, delivery };
}

module.exports = { createDurableEventApi, readJson, send, verifyWebhookSignature };
