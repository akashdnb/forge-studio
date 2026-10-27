'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { authenticate, hasRole, applySecurityHeaders } = require('../security/http-security');
const { FencedOutboundWebhookReliability } = require('./fenced-outbound-webhook-reliability');
const { EVENT_SCHEMAS } = require('./durable-delivery');
const { EventSchemaRegistry } = require('./schema-registry');

async function readJson(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body exceeds 1 MiB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('JSON body must be an object');
  return value;
}

function send(res, status, body, requestId) {
  applySecurityHeaders(res);
  if (status !== 204) res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-request-id', requestId);
  res.writeHead(status);
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

async function assertGovernance(pool, auth, decisionId, action = 'webhook_manage') {
  if (process.env.FORGE_WEBHOOK_GOVERNANCE_REQUIRED === 'false') return;
  if (!decisionId) throw Object.assign(new Error('A signed governance decision is required'), { code: 'GOVERNANCE_REQUIRED', statusCode: 403 });
  const row = (await pool.query(`SELECT id FROM forge_policy_decisions WHERE id=$1 AND tenant_id=$2 AND action=$3 AND decision='ALLOW'`, [decisionId, auth.tenantId, action])).rows[0];
  if (!row) throw Object.assign(new Error('Governance decision is missing, denied, or cross-tenant'), { code: 'GOVERNANCE_DENIED', statusCode: 403 });
}

async function assertProjectAccess(pool, auth, projectId) {
  if (!projectId) return;
  const row = (await pool.query(`SELECT 1 FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.actor_id=$2
    WHERE p.id=$1 AND p.tenant_id=$3 AND (m.actor_id IS NOT NULL OR p.created_by=$2)`, [projectId, auth.actor, auth.tenantId])).rows[0];
  if (!row) throw Object.assign(new Error('Project is outside the authenticated tenant scope'), { code: 'FORBIDDEN', statusCode: 403 });
}

async function audit(pool, auth, action, targetType, targetId, projectId, details = {}) {
  await pool.query(`INSERT INTO security_audit_events(tenant_id,project_id,actor,action,target_type,target_id,outcome,details)
    VALUES($1,$2,$3,$4,$5,$6,'ALLOWED',$7::jsonb)`, [auth.tenantId, projectId || null, auth.actor, action, targetType, targetId, JSON.stringify(details)]);
}

function createDurableEventApi({
  pool,
  authSecret = process.env.FORGE_AUTH_SIGNING_SECRET,
  apiToken = process.env.API_BEARER_TOKEN,
  staticActor = process.env.FORGE_STATIC_ACTOR_ID,
  staticTenant = process.env.FORGE_STATIC_TENANT_ID,
  logger = console,
} = {}) {
  const delivery = new FencedOutboundWebhookReliability({ pool, logger });
  const registry = new EventSchemaRegistry({ pool, logger });
  const server = http.createServer(async (req, res) => {
    const requestId = req.headers['x-request-id'] || randomUUID();
    try {
      const auth = authenticate(req, { apiToken, authSecret, staticActor, staticTenant });
      if (!auth) return send(res, 401, { error: { code: 'UNAUTHORIZED' } }, requestId);
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        const metrics = await delivery.metrics({ tenantId: auth.tenantId });
        return send(res, 200, { status: metrics.staleLeases || metrics.circuits.some((x) => x.circuit_state === 'OPEN') ? 'degraded' : 'ok', component: 'outbound-webhook-delivery', metrics }, requestId);
      }
      if (req.method === 'GET' && url.pathname === '/v1/event-schemas') return send(res, 200, { schemas: EVENT_SCHEMAS }, requestId);

      if (req.method === 'GET' && url.pathname === '/v1/schema-registry/health') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        return send(res, 200, { item: await registry.health({ tenantId: auth.tenantId }) }, requestId);
      }
      if (req.method === 'GET' && url.pathname === '/v1/schema-registry/consumers') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        return send(res, 200, { items: await registry.inventory({ tenantId: auth.tenantId, eventFamily: url.searchParams.get('eventFamily') || null }) }, requestId);
      }
      if (req.method === 'GET' && url.pathname === '/v1/schema-registry/family') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const family = await registry.getFamily(url.searchParams.get('eventFamily'), auth.tenantId);
        if (!family) return send(res, 404, { error: { code: 'SCHEMA_FAMILY_NOT_FOUND' } }, requestId);
        const versions = (await pool.query(`SELECT id,version,fingerprint,status,effective_at,deprecated_at,producer_owner,consumer_owners,migration_metadata,created_by,created_at,updated_at FROM forge_event_schemas WHERE family_id=$1 ORDER BY version DESC`, [family.id])).rows;
        return send(res, 200, { family, versions }, requestId);
      }
      if (req.method === 'GET' && url.pathname === '/v1/schema-registry/quarantine') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
        const rows = await pool.query(`SELECT id,project_id,event_family,event_version,payload_fingerprint,reason_code,reason,source,source_id,replay_of,released_at,released_by,created_at FROM forge_event_schema_quarantine WHERE tenant_id=$1 AND ($2::text IS NULL OR event_family=$2) ORDER BY created_at DESC LIMIT $3`, [auth.tenantId, url.searchParams.get('eventFamily'), limit]);
        return send(res, 200, { items: rows.rows }, requestId);
      }
      if (req.method === 'POST' && url.pathname === '/v1/schema-registry/schemas') {
        if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const body = await readJson(req);
        if (body.tenantId && body.tenantId !== auth.tenantId) return send(res, 403, { error: { code: 'TENANT_MISMATCH' } }, requestId);
        const item = await registry.register({ ...body, tenantId: auth.tenantId, actor: auth.actor, producerOwner: body.producerOwner || auth.actor });
        await audit(pool, auth, 'schema.registered', 'event_schema', item.id, null, { eventFamily: body.eventFamily, version: body.version, fingerprint: item.fingerprint });
        return send(res, 201, { item }, requestId);
      }
      if (req.method === 'POST' && url.pathname === '/v1/schema-registry/activate') {
        if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const body = await readJson(req);
        const item = await registry.activate({ eventFamily: body.eventFamily, version: body.version, tenantId: auth.tenantId, actor: auth.actor });
        await audit(pool, auth, 'schema.activated', 'event_schema', item.id, null, { eventFamily: body.eventFamily, version: body.version });
        return send(res, 200, { item }, requestId);
      }
      if (req.method === 'POST' && url.pathname === '/v1/schema-registry/deprecate') {
        if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const body = await readJson(req);
        const item = await registry.deprecate({ eventFamily: body.eventFamily, version: body.version, tenantId: auth.tenantId, actor: auth.actor, reason: body.reason });
        await audit(pool, auth, 'schema.deprecated', 'event_schema', item.id, null, { eventFamily: body.eventFamily, version: body.version, reason: body.reason });
        return send(res, 200, { item }, requestId);
      }
      if (req.method === 'POST' && url.pathname === '/v1/schema-registry/compatibility') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        return send(res, 200, { item: await registry.diff({ eventFamily: (await readJson(req)).eventFamily, fromVersion: (await readJson(req)).fromVersion, toVersion: (await readJson(req)).toVersion, tenantId: auth.tenantId }) }, requestId);
      }
      if (req.method === 'POST' && url.pathname === '/v1/schema-registry/verify') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const body = await readJson(req);
        return send(res, 200, { item: await registry.verify({ eventFamily: body.eventFamily, version: body.version, schema: body.schema, tenantId: auth.tenantId }) }, requestId);
      }
      if (req.method === 'POST' && url.pathname === '/v1/schema-registry/negotiate') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const body = await readJson(req);
        return send(res, 200, { item: await registry.negotiate({ eventFamily: body.eventFamily, tenantId: auth.tenantId, consumerId: body.consumerId, supportedVersions: body.supportedVersions }) }, requestId);
      }

      if (req.method === 'GET' && url.pathname === '/v1/event-subscriptions') {
        const rows = await pool.query(`SELECT id,tenant_id,project_id,endpoint_url,event_types,ordered,rate_limit_per_second,max_concurrency,active,
          endpoint_config_ref,delivery_epoch,active_key_id,circuit_state,circuit_failures,circuit_opened_until,max_attempts,governance_decision_id,created_by,created_at,updated_at
          FROM forge_event_subscriptions WHERE tenant_id=$1 AND ($2::text IS NULL OR project_id=$2) ORDER BY created_at DESC`, [auth.tenantId, url.searchParams.get('projectId')]);
        return send(res, 200, { items: rows.rows }, requestId);
      }

      if (req.method === 'POST' && url.pathname === '/v1/event-subscriptions') {
        if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        const body = await readJson(req);
        if (body.tenantId && body.tenantId !== auth.tenantId) return send(res, 403, { error: { code: 'TENANT_MISMATCH' } }, requestId);
        await assertProjectAccess(pool, auth, body.projectId);
        await assertGovernance(pool, auth, body.governanceDecisionId);
        const item = await delivery.createSubscription({ ...body, tenantId: auth.tenantId, createdBy: auth.actor });
        await audit(pool, auth, 'delivery.endpoint_created', 'event_subscription', item.id, item.project_id, { endpointConfigRef: item.endpoint_config_ref, deliveryEpoch: item.delivery_epoch });
        return send(res, 201, { item }, requestId);
      }

      if (req.method === 'GET' && url.pathname === '/v1/event-diagnostics') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        return send(res, 200, { items: await delivery.diagnostics({ tenantId: auth.tenantId, orderingKey: url.searchParams.get('orderingKey') || null }) }, requestId);
      }

      if (req.method === 'GET' && url.pathname === '/v1/event-delivery/metrics') {
        if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
        return send(res, 200, { item: await delivery.metrics({ tenantId: auth.tenantId }) }, requestId);
      }

      if (req.method === 'GET' && url.pathname === '/v1/event-deliveries') {
        const rows = await pool.query(`SELECT d.id,d.event_id,d.subscription_id,d.project_id,d.status,d.attempts,d.delivery_epoch,d.key_id,d.endpoint_config_ref_snapshot,
          d.payload_hash,d.schema_name,d.schema_version,d.idempotency_key,d.replay_of,d.available_at,d.lease_until,d.ordering_key,d.ordering_sequence,
          d.acked_at,d.acked_by,d.last_error,d.last_response_status,d.completed_at,d.created_at,d.updated_at
          FROM forge_event_deliveries d WHERE d.tenant_id=$1 AND ($2::text IS NULL OR d.project_id=$2) AND ($3::text IS NULL OR d.status=$3)
          ORDER BY d.created_at DESC LIMIT $4`, [auth.tenantId, url.searchParams.get('projectId'), url.searchParams.get('status'), Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)))]);
        return send(res, 200, { items: rows.rows }, requestId);
      }

      if (path[0] === 'v1' && path[1] === 'event-subscriptions' && path[2]) {
        const id = decodeURIComponent(path[2]);
        const sub = (await pool.query('SELECT * FROM forge_event_subscriptions WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId])).rows[0];
        if (!sub) return send(res, 404, { error: { code: 'NOT_FOUND' } }, requestId);

        if (req.method === 'GET' && path[3] === 'inspect') {
          if (!hasRole(auth, 'VIEWER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          return send(res, 200, { item: await delivery.inspectEndpoint(id, auth.tenantId) }, requestId);
        }
        if (req.method === 'POST' && path[3] === 'rotate-secret') {
          if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const body = await readJson(req);
          await assertGovernance(pool, auth, body.governanceDecisionId);
          if (typeof body.secret !== 'string') throw Object.assign(new Error('secret is required'), { code: 'INVALID_SECRET' });
          const result = await delivery.rotateSecret(id, auth.tenantId, body.secret, auth.actor);
          await audit(pool, auth, 'delivery.secret_rotated', 'event_subscription', id, sub.project_id, { keyId: result.keyId, deliveryEpoch: result.deliveryEpoch });
          return send(res, 200, { item: result }, requestId);
        }
        if (req.method === 'POST' && path[3] === 'circuit-reset') {
          if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const body = await readJson(req);
          await assertGovernance(pool, auth, body.governanceDecisionId);
          const result = await delivery.resetCircuit(id, auth.tenantId, auth.actor);
          return send(res, 200, { item: result }, requestId);
        }
        if (req.method === 'PATCH') {
          if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const body = await readJson(req);
          await assertGovernance(pool, auth, body.governanceDecisionId);
          await assertProjectAccess(pool, auth, body.projectId ?? sub.project_id);
          let endpointUrl = sub.endpoint_url;
          let fingerprint = sub.endpoint_fingerprint;
          let epoch = Number(sub.delivery_epoch);
          if (body.endpointUrl !== undefined) {
            endpointUrl = delivery.constructor.prototype.constructor === FencedOutboundWebhookReliability ? require('./durable-delivery').validateDestination(body.endpointUrl) : body.endpointUrl;
            await delivery.dnsResolver(endpointUrl);
            fingerprint = createHash('sha256').update(endpointUrl).digest('hex');
            epoch += 1;
          }
          const result = await pool.query(`UPDATE forge_event_subscriptions SET endpoint_url=$2,endpoint_fingerprint=$3,delivery_epoch=$4,
            active=COALESCE($5,active),ordered=COALESCE($6,ordered),rate_limit_per_second=COALESCE($7,rate_limit_per_second),max_concurrency=COALESCE($8,max_concurrency),
            endpoint_config_ref=COALESCE($9,endpoint_config_ref),governance_decision_id=$10,governance_policy_hash=COALESCE($11,governance_policy_hash),updated_by=$12,updated_at=now()
            WHERE id=$1 AND tenant_id=$13 RETURNING id,tenant_id,project_id,endpoint_url,event_types,ordered,rate_limit_per_second,max_concurrency,active,endpoint_config_ref,delivery_epoch,circuit_state,circuit_failures,circuit_opened_until,governance_decision_id,governance_policy_hash,updated_at`,
          [id,endpointUrl,fingerprint,epoch,body.active,body.ordered,body.rateLimitPerSecond,body.maxConcurrency,body.configurationRef,body.governanceDecisionId,body.governancePolicyHash,auth.actor,auth.tenantId]);
          if (body.active === false) await pool.query(`UPDATE forge_event_deliveries SET status='CANCELLED',completed_at=now(),updated_at=now() WHERE subscription_id=$1 AND tenant_id=$2 AND status IN ('PENDING','RETRY')`, [id, auth.tenantId]);
          await audit(pool, auth, 'delivery.endpoint_updated', 'event_subscription', id, sub.project_id, { endpointChanged: body.endpointUrl !== undefined, deliveryEpoch: epoch });
          return send(res, 200, { item: result.rows[0] }, requestId);
        }
        if (req.method === 'DELETE') {
          if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const body = await readJson(req);
          await assertGovernance(pool, auth, body.governanceDecisionId);
          await pool.query(`UPDATE forge_event_subscriptions SET active=false,updated_by=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2`, [id, auth.tenantId, auth.actor]);
          await pool.query(`UPDATE forge_event_deliveries SET status='CANCELLED',completed_at=now(),updated_at=now() WHERE subscription_id=$1 AND tenant_id=$2 AND status IN ('PENDING','RETRY')`, [id, auth.tenantId]);
          await audit(pool, auth, 'delivery.endpoint_deleted', 'event_subscription', id, sub.project_id);
          return send(res, 204, null, requestId);
        }
      }

      if (path[0] === 'v1' && path[1] === 'event-deliveries' && path[2]) {
        const id = decodeURIComponent(path[2]);
        const row = (await pool.query('SELECT * FROM forge_event_deliveries WHERE id=$1 AND tenant_id=$2', [id, auth.tenantId])).rows[0];
        if (!row) return send(res, 404, { error: { code: 'NOT_FOUND' } }, requestId);
        if (req.method === 'POST' && path[3] === 'cancel') {
          if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const body = await readJson(req);
          await assertGovernance(pool, auth, body.governanceDecisionId);
          const result = await delivery.cancelDelivery(id, auth.actor);
          await audit(pool, auth, 'delivery.cancelled', 'event_delivery', id, row.project_id);
          return send(res, 200, { item: result }, requestId);
        }
        if (req.method === 'POST' && path[3] === 'replay') {
          if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const body = await readJson(req);
          await assertGovernance(pool, auth, body.governanceDecisionId);
          return send(res, 200, { item: await delivery.replayDelivery(id, auth.tenantId, auth.actor) }, requestId);
        }
        if (req.method === 'POST' && path[3] === 'quarantine-release') {
          if (!hasRole(auth, 'OWNER')) return send(res, 403, { error: { code: 'FORBIDDEN' } }, requestId);
          const body = await readJson(req);
          await assertGovernance(pool, auth, body.governanceDecisionId);
          return send(res, 200, { item: await delivery.releaseQuarantine(id, auth.tenantId, auth.actor) }, requestId);
        }
      }

      return send(res, 404, { error: { code: 'NOT_FOUND' } }, requestId);
    } catch (error) {
      logger.error?.(JSON.stringify({ requestId, component: 'event-delivery-api', code: error.code || 'REQUEST_FAILURE', message: error.message }));
      return send(res, error.statusCode || 400, { error: { code: error.code || 'INVALID_REQUEST', message: error.message } }, requestId);
    }
  });
  return { server, delivery, registry };
}

module.exports = { createDurableEventApi, readJson, send };