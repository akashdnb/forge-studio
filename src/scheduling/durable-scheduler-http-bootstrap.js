'use strict';

const { DurableScheduler } = require('./durable-scheduler');
const { authenticate, applySecurityHeaders, safeError, hasRole } = require('../security/http-security');

const INSTALLED = Symbol.for('forge.durable.scheduler.http.installed');
if (!globalThis[INSTALLED]) {
  const extended = require('../extended-http-api');
  const original = extended.createExtendedApiServer;
  extended.createExtendedApiServer = function durableSchedulerApi(options = {}) {
    const result = original(options);
    if (!result?.server || !options.repository?.db?.pool) return result;
    const pool = options.repository.db.pool;
    const scheduler = new DurableScheduler({ pool, schedulerId: `${process.env.FORGE_SCHEDULER_ID || 'forge-durable-scheduler'}:operator:${process.pid}` });
    const originalListeners = result.server.listeners.bind(result.server);
    result.server.listeners = function durableSchedulerListeners(eventName) {
      const listeners = originalListeners(eventName);
      if (eventName !== 'request' || !listeners.length) return listeners;
      const base = listeners[0];
      const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const readBody = async (req) => new Promise((resolve, reject) => { let data = ''; req.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) reject(Object.assign(new Error('request body too large'), { statusCode: 413, code: 'BODY_TOO_LARGE' })); }); req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error('invalid JSON'), { statusCode: 400, code: 'INVALID_JSON' })); } }); req.on('error', reject); });
      const handler = async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!(url.pathname === '/v1/schedules' || url.pathname.startsWith('/v1/schedules/') || url.pathname === '/internal/scheduler/health')) return base(req, res);
        applySecurityHeaders(res);
        const requestId = req.headers['x-request-id'] || require('node:crypto').randomUUID(); res.setHeader('x-request-id', requestId);
        const auth = req._auth || authenticate(req, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
        if (!auth) return safeError(res, 401, 'UNAUTHORIZED', requestId);
        const operator = hasRole(auth, 'operator') || hasRole(auth, 'admin');
        const segments = url.pathname.split('/').filter(Boolean);
        try {
          if (url.pathname === '/internal/scheduler/health') { if (!operator) return safeError(res, 403, 'FORBIDDEN', requestId); await scheduler.heartbeat(); return json(res, 200, await scheduler.health()); }
          if (segments.length === 2 && req.method === 'GET') return json(res, 200, { schedules: await scheduler.list({ tenantId: auth.tenantId, projectId: url.searchParams.get('projectId'), limit: url.searchParams.get('limit') || 100 }) });
          if (segments.length === 2 && req.method === 'POST') { if (!operator) return safeError(res, 403, 'FORBIDDEN', requestId); const body = await readBody(req); return json(res, 201, await scheduler.create({ ...body, tenantId: auth.tenantId, createdBy: auth.actor, requestId })); }
          const id = segments[2]; if (!id) return base(req, res);
          if (segments.length === 3 && req.method === 'GET') return json(res, 200, await scheduler.get(id, auth.tenantId, url.searchParams.get('projectId')));
          if (segments.length === 4 && req.method === 'POST') {
            if (!operator) return safeError(res, 403, 'FORBIDDEN', requestId);
            const projectId = url.searchParams.get('projectId');
            if (segments[3] === 'pause' || segments[3] === 'resume') return json(res, 200, await scheduler.setPaused({ id, tenantId: auth.tenantId, projectId, paused: segments[3] === 'pause', actor: auth.actor, requestId }));
            if (segments[3] === 'fire') return json(res, 202, await scheduler.manualFire({ id, tenantId: auth.tenantId, projectId, actor: auth.actor, requestId }));
            if (segments[3] === 'preview') return json(res, 200, await scheduler.preview({ id, tenantId: auth.tenantId, projectId, after: url.searchParams.get('after') ? new Date(url.searchParams.get('after')) : new Date() }));
            if (segments[3] === 'misfires') return json(res, 200, { misfires: await scheduler.misfires({ tenantId: auth.tenantId, projectId }) });
            if (segments[3] === 'recover-lease') { const recovered = await scheduler.recoverStaleLeases(); return json(res, 200, { recovered }); }
          }
          return base(req, res);
        } catch (error) { return safeError(res, error.statusCode || 500, error.code || 'INTERNAL_ERROR', requestId); }
      };
      return [handler, ...listeners.slice(1)];
    };
    return result;
  };
  globalThis[INSTALLED] = true;
}

module.exports = true;
