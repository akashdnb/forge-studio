'use strict';
const http = require('node:http');
const { URL } = require('node:url');
const { Pool } = require('pg');
const { authenticate, hasRole } = require('../security/http-security');
const { TenantResourceFairness } = require('./tenant-resource-fairness');

if (process.env.DATABASE_URL) {
  const marker = Symbol.for('forge.tenant.resource.fairness.http');
  if (!http.Server.prototype[marker]) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
    const service = new TenantResourceFairness({ pool });
    const originalOn = http.Server.prototype.on;
    http.Server.prototype.on = function on(event, listener) {
      if (event !== 'request' || typeof listener !== 'function') return originalOn.call(this, event, listener);
      return originalOn.call(this, event, async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/internal/resource-fairness')) return listener(req, res);
        const auth = authenticate(req, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
        if (!auth || !hasRole(auth, 'OWNER')) return json(res, 403, { error: { code: 'FORBIDDEN' } });
        try {
          if (req.method === 'GET' && url.pathname === '/internal/resource-fairness/diagnostics') return json(res, 200, await service.diagnostics({ tenantId: url.searchParams.get('tenantId'), projectId: url.searchParams.get('projectId') }));
          if (req.method === 'POST' && url.pathname === '/internal/resource-fairness/policies') {
            const body = await readJson(req); if (body.tenantId !== auth.tenantId) return json(res, 403, { error: { code: 'TENANT_ISOLATION' } });
            return json(res, 200, await service.upsertPolicy({ tenantId: body.tenantId, projectId: body.projectId || null, patch: body.patch || {}, actor: auth.actor, reason: body.reason || 'operator update' }));
          }
          if (req.method === 'POST' && url.pathname === '/internal/resource-fairness/recover') return json(res, 200, { recovered: await service.recoverStale() });
          if (req.method === 'GET' && url.pathname === '/internal/resource-fairness/reservations') {
            const values=[]; const where=[]; if(url.searchParams.get('tenantId')){values.push(url.searchParams.get('tenantId'));where.push(`tenant_id=$${values.length}`)} if(url.searchParams.get('projectId')){values.push(url.searchParams.get('projectId'));where.push(`project_id=$${values.length}`)}
            const rows=(await pool.query(`SELECT * FROM forge_resource_reservations ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY reserved_at DESC LIMIT 200`,values)).rows; return json(res,200,{reservations:rows});
          }
          return json(res, 404, { error: { code: 'NOT_FOUND' } });
        } catch (error) { return json(res, error.statusCode || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }); }
      });
    };
    http.Server.prototype[marker] = true;
  }
}
async function readJson(req) { let body=''; for await(const chunk of req) { body += chunk; if(body.length>262144) throw Object.assign(new Error('body too large'),{statusCode:413}); } return JSON.parse(body || '{}'); }
function json(res,status,payload){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(payload));}
