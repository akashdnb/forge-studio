const { URL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { InboundWebhookService } = require('./inbound-webhook');
const { installInboundEventHardening } = require('./inbound-event-hardening');
const { authenticate, hasRole } = require('../security/http-security');

installInboundEventHardening({ InboundWebhookService });

const inboundHttp = require('./inbound-http');
if (!inboundHttp.__eventHardeningApiInstalled) {
  const originalFactory = inboundHttp.createInboundWebhookApi;
  const send = inboundHttp.send;
  inboundHttp.createInboundWebhookApi = function hardenedInboundWebhookApi(options = {}) {
    const api = originalFactory(options);
    const originalListener = api.server.listeners('request')[0];
    api.server.removeListener('request', originalListener);
    api.server.on('request', async (req, res) => {
      const requestId = req.headers['x-request-id'] || randomUUID();
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        const parts = url.pathname.split('/').filter(Boolean);
        const authOptions = { apiToken: options.apiToken || process.env.API_BEARER_TOKEN, authSecret: options.authSecret || process.env.FORGE_AUTH_SIGNING_SECRET, staticActor: options.staticActor || process.env.FORGE_STATIC_ACTOR_ID, staticTenant: options.staticTenant || process.env.FORGE_STATIC_TENANT_ID };
        if (parts[0] === 'v1' && parts[1] === 'inbound-intake' && parts[2] === 'metrics' && req.method === 'GET') {
          const auth = authenticate(req, authOptions);
          if (!auth || !hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const counts = await options.pool.query(`SELECT processing_state,count(*)::int AS count FROM forge_event_intake WHERE tenant_id=$1 GROUP BY processing_state`, [auth.tenantId]);
          const lag = await options.pool.query(`SELECT COALESCE(EXTRACT(EPOCH FROM (now()-min(received_at))),0)::int AS oldest_seconds FROM forge_event_intake WHERE tenant_id=$1 AND processing_state IN('RECEIVED','PROCESSING','REPLAYING')`, [auth.tenantId]);
          const gaps = await options.pool.query(`SELECT count(*)::int AS count FROM forge_event_order_watermarks WHERE endpoint_id IN(SELECT id FROM forge_inbound_webhook_endpoints WHERE tenant_id=$1) AND gap_detected`, [auth.tenantId]);
          return send(res, 200, { states: counts.rows, oldestPendingSeconds: lag.rows[0]?.oldest_seconds || 0, orderingGaps: gaps.rows[0]?.count || 0 }, requestId);
        }
        if (parts[0] === 'v1' && parts[1] === 'inbound-intake' && parts[2] && parts[3] && parts[4] === 'replay' && req.method === 'POST') {
          const auth = authenticate(req, authOptions);
          if (!auth || !hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const eventId = decodeURIComponent(parts[2]);
          const routeKind = decodeURIComponent(parts[3]);
          const service = api.service;
          const claim = await service.claimReplay({ eventId, routeKind, operatorId: auth.actor, tenantId: auth.tenantId, reason: 'authenticated operator replay' });
          const event = (await options.pool.query(`SELECT envelope,project_id,event_type,version FROM forge_inbound_events WHERE id=$1 AND tenant_id=$2`, [eventId, auth.tenantId])).rows[0];
          if (!event) {
            await service.releaseReplay({ eventId, routeKind, claimEpoch: claim.claimEpoch });
            return send(res, 404, { error: { code: 'NOT_FOUND' } }, requestId);
          }
          try {
            const jobId = `injob_replay_${randomUUID().replace(/-/g, '')}`;
            await service.queue.enqueue({ id: jobId, projectId: event.project_id, episodeId: event.envelope?.data?.episodeId || null, kind: `inbound:${routeKind}`, payload: { eventId, routeKind, eventType: event.event_type, version: event.version, payload: event.envelope?.data || {} }, priority: 10, maxAttempts: 6, idempotencyKey: `inbound:replay:${eventId}:${routeKind}:${claim.claimEpoch}`, createdBy: auth.actor, correlationId: event.envelope?.correlationId || null });
          } catch (enqueueError) {
            await service.releaseReplay({ eventId, routeKind, claimEpoch: claim.claimEpoch });
            throw enqueueError;
          }
          return send(res, 202, { status: 'REPLAY_QUEUED', eventId, routeKind, claimEpoch: claim.claimEpoch }, requestId);
        }
        return originalListener(req, res);
      } catch (error) {
        options.logger?.error?.(JSON.stringify({ component: 'inbound-event-hardening-api', requestId, code: error.code || 'REQUEST_FAILURE', message: error.message }));
        return send(res, error.statusCode || 400, { error: { code: error.code || 'INVALID_REQUEST', message: error.message } }, requestId);
      }
    });
    return api;
  };
  inboundHttp.__eventHardeningApiInstalled = true;
}
