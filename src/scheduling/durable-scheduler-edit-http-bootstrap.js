'use strict';

require('./durable-scheduler-edit');
const { DurableScheduler } = require('./durable-scheduler');
const { authenticate, applySecurityHeaders, safeError, hasRole } = require('../security/http-security');

const INSTALLED = Symbol.for('forge.durable.scheduler.edit.http.installed');
if (!globalThis[INSTALLED]) {
  const extended = require('../extended-http-api');
  const original = extended.createExtendedApiServer;
  extended.createExtendedApiServer = function durableSchedulerEditApi(options = {}) {
    const result = original(options);
    if (!result?.server || !options.repository?.db?.pool) return result;
    const scheduler = new DurableScheduler({ pool: options.repository.db.pool, schedulerId: `${process.env.FORGE_SCHEDULER_ID || 'forge-durable-scheduler'}:operator:${process.pid}` });
    const originalListeners = result.server.listeners.bind(result.server);
    result.server.listeners = function durableSchedulerEditListeners(eventName) {
      const listeners = originalListeners(eventName);
      if (eventName !== 'request' || !listeners.length) return listeners;
      const base = listeners[0];
      const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      const body = req => new Promise((resolve, reject) => { let data = ''; req.on('data', c => { data += c; if (data.length > 1024 * 1024) reject(Object.assign(new Error('request body too large'), { statusCode: 413, code: 'BODY_TOO_LARGE' })); }); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { statusCode: 400, code: 'INVALID_JSON' })); } }); req.on('error', reject); });
      const handler = async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const match = url.pathname.match(/^\/v1\/schedules\/([^/]+)$/);
        if (!match || req.method !== 'PATCH') return base(req, res);
        applySecurityHeaders(res); const requestId = req.headers['x-request-id'] || require('node:crypto').randomUUID(); res.setHeader('x-request-id', requestId);
        const auth = req._auth || authenticate(req, { apiToken: process.env.API_BEARER_TOKEN || null, authSecret: process.env.FORGE_AUTH_SIGNING_SECRET || null, staticActor: process.env.FORGE_STATIC_ACTOR_ID || null, staticTenant: process.env.FORGE_STATIC_TENANT_ID || null });
        if (!auth) return safeError(res, 401, 'UNAUTHORIZED', requestId); if (!(hasRole(auth, 'operator') || hasRole(auth, 'admin'))) return safeError(res, 403, 'FORBIDDEN', requestId);
        try { const input = await body(req); const row = await scheduler.updateSchedule({ id: match[1], tenantId: auth.tenantId, projectId: input.projectId || url.searchParams.get('projectId'), actor: auth.actor, requestId, expectedVersion: input.expectedVersion, patch: input.patch || input }); return json(res, 200, row); }
        catch (error) { return safeError(res, error.statusCode || 500, error.code || 'INTERNAL_ERROR', requestId); }
      };
      return [handler, ...listeners.slice(1)];
    };
    return result;
  };
  globalThis[INSTALLED] = true;
}
module.exports = true;
