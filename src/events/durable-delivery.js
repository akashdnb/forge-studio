const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

const DEFAULTS = Object.freeze({ maxAttempts: 8, leaseSeconds: 60, timeoutMs: 10_000, replayWindowSeconds: 300, baseDelayMs: 1000, maxDelayMs: 300_000 });
const RETRYABLE_4XX = new Set([408, 409, 425, 429]);

const EVENT_SCHEMAS = Object.freeze({
  'episode.state.changed': { version: 1, required: ['episodeId', 'projectId', 'state', 'revision'] },
  'job.state.changed': { version: 1, required: ['jobId', 'projectId', 'kind', 'status'] },
  'provider_run.state.changed': { version: 1, required: ['providerRunId', 'episodeId', 'status'] },
  'publish.state.changed': { version: 1, required: ['publishRunId', 'episodeId', 'status'] },
  'approval.created': { version: 1, required: ['approvalId', 'episodeId', 'stage', 'decision'] },
  'qa.result.recorded': { version: 1, required: ['qaResultId', 'episodeId', 'status'] },
  'security.audit.recorded': { version: 1, required: ['auditEventId', 'tenantId', 'action', 'outcome'] },
});

function hmac(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function deterministicDeliveryId(eventId, subscriptionId) { return crypto.createHash('sha256').update(`${eventId}:${subscriptionId}`).digest('hex').slice(0, 40); }
function computeBackoff(attempt, { baseDelayMs = DEFAULTS.baseDelayMs, maxDelayMs = DEFAULTS.maxDelayMs } = {}) {
  const cap = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  return Math.max(1, Math.floor(cap / 2 + Math.random() * cap / 2));
}
function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400_000, Math.floor(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(86_400_000, Math.max(0, date - now)) : null;
}
function classifyResponse(status, retryAfter) {
  if (status >= 200 && status < 300) return { outcome: 'SUCCEEDED', retry: false };
  const retry = status >= 500 || RETRYABLE_4XX.has(status);
  return { outcome: retry ? 'RETRYING' : 'FAILED', retry, retryAfterMs: retry ? parseRetryAfter(retryAfter) : null };
}
function encryptSecret(secret, keyMaterial = process.env.FORGE_EVENT_SECRET_KEY) {
  if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('Webhook secret must be at least 16 characters');
  if (!keyMaterial) throw new Error('FORGE_EVENT_SECRET_KEY is required for webhook subscriptions');
  const key = crypto.createHash('sha256').update(keyMaterial).digest();
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}
function decryptSecret(encoded, keyMaterial = process.env.FORGE_EVENT_SECRET_KEY) {
  if (!keyMaterial) throw new Error('FORGE_EVENT_SECRET_KEY is required to deliver webhooks');
  const [iv64, tag64, data64] = String(encoded).split('.'); if (!iv64 || !tag64 || !data64) throw new Error('Invalid webhook secret ciphertext');
  const key = crypto.createHash('sha256').update(keyMaterial).digest(); const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv64, 'base64url')); decipher.setAuthTag(Buffer.from(tag64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data64, 'base64url')), decipher.final()]).toString('utf8');
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const [a,b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  const normalized = ip.toLowerCase(); return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}
function validateDestination(value) {
  let url; try { url = new URL(value); } catch { throw new TypeError('Webhook URL must be a valid URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('Webhook URL must use http or https');
  if (url.username || url.password) throw new TypeError('Webhook URL must not contain credentials');
  const host = url.hostname.toLowerCase(); if (!host || host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') throw new TypeError('Webhook URL host is not allowed');
  if (net.isIP(host) && isPrivateIp(host)) throw new TypeError('Webhook URL must not target a private address');
  return url.toString();
}
async function assertPublicDestination(url) {
  const parsed = new URL(url); if (net.isIP(parsed.hostname)) { if (isPrivateIp(parsed.hostname)) throw new Error('Webhook destination resolves to a private address'); return; }
  const records = await dns.lookup(parsed.hostname, { all: true }); if (!records.length || records.some((record) => isPrivateIp(record.address))) throw new Error('Webhook destination resolves to a private address');
}

class DurableEventDelivery {
  constructor({ pool, fetchImpl = globalThis.fetch, logger = console, now = () => Date.now(), config = {} } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
    this.pool = pool; this.fetch = fetchImpl; this.logger = logger; this.now = now; this.config = { ...DEFAULTS, ...config };
  }
  async createSubscription({ tenantId, projectId = null, endpointUrl, eventTypes = [], secret, ordered = false, rateLimitPerSecond = 10, maxConcurrency = 4, createdBy }) {
    const endpoint = validateDestination(endpointUrl); if (!tenantId || !createdBy) throw new TypeError('tenantId and createdBy are required');
    if (!Number.isInteger(rateLimitPerSecond) || rateLimitPerSecond < 1 || rateLimitPerSecond > 1000) throw new TypeError('rateLimitPerSecond must be between 1 and 1000');
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 100) throw new TypeError('maxConcurrency must be between 1 and 100');
    for (const type of eventTypes) if (!EVENT_SCHEMAS[type]) throw new TypeError(`Unknown event type: ${type}`);
    const encrypted = encryptSecret(secret);
    const result = await this.pool.query(`INSERT INTO forge_event_subscriptions(id,tenant_id,project_id,endpoint_url,secret_ciphertext,event_types,ordered,rate_limit_per_second,max_concurrency,created_by) VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10) RETURNING id,tenant_id,project_id,endpoint_url,event_types,ordered,rate_limit_per_second,max_concurrency,active,created_by,created_at,updated_at`, [crypto.randomUUID(), tenantId, projectId, endpoint, encrypted, eventTypes, ordered, rateLimitPerSecond, maxConcurrency, createdBy]);
    return result.rows[0];
  }
  async publish({ client = this.pool, tenantId, projectId = null, episodeId = null, type, payload, aggregateType = 'event', aggregateId = null, provenance = {} }) {
    const schema = EVENT_SCHEMAS[type]; if (!schema) throw new TypeError(`Unknown event type: ${type}`); if (!tenantId || !projectId) throw new TypeError('tenantId and projectId are required');
    const body = { ...payload }; for (const key of schema.required) if (body[key] === undefined || body[key] === null) throw new TypeError(`Event payload missing ${key}`);
    const result = await client.query(`INSERT INTO forge_events(id,tenant_id,project_id,episode_id,type,version,schema,payload,aggregate_type,aggregate_id,provenance) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb) RETURNING *`, [crypto.randomUUID(), tenantId, projectId, episodeId, type, schema.version, JSON.stringify(schema), JSON.stringify(body), aggregateType, aggregateId, JSON.stringify(provenance)]);
    const event = result.rows[0]; await client.query('INSERT INTO forge_outbox(topic,aggregate_type,aggregate_id,payload) VALUES($1,$2,$3,$4::jsonb)', ['event.created', 'forge_event', event.id, JSON.stringify({ eventId: event.id })]); return event;
  }
  async fanout(limit = 100) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const rows = (await client.query(`SELECT * FROM forge_outbox WHERE published_at IS NULL AND available_at <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit])).rows;
      for (const outbox of rows) { try { const eventId = outbox.payload?.eventId; if (!eventId) throw new Error('outbox eventId missing'); const event = (await client.query('SELECT * FROM forge_events WHERE id=$1', [eventId])).rows[0]; if (!event) throw new Error('event missing');
          const subscriptions = (await client.query(`SELECT * FROM forge_event_subscriptions WHERE active AND tenant_id=$1 AND (project_id IS NULL OR project_id=$2) AND (cardinality(event_types)=0 OR $3=ANY(event_types))`, [event.tenant_id, event.project_id, event.type])).rows;
          for (const sub of subscriptions) { const deliveryId = deterministicDeliveryId(event.id, sub.id); await client.query(`INSERT INTO forge_event_deliveries(id,event_id,subscription_id,tenant_id,project_id,sequence_no,status,available_at) VALUES($1,$2,$3,$4,$5,$6,'PENDING',now()) ON CONFLICT (id) DO NOTHING`, [deliveryId, event.id, sub.id, event.tenant_id, event.project_id, event.sequence_no]); }
          await client.query('UPDATE forge_outbox SET published_at=now(),last_error=NULL WHERE id=$1', [outbox.id]);
        } catch (error) { await client.query(`UPDATE forge_outbox SET attempts=attempts+1,last_error=$2,available_at=now()+interval '30 seconds' WHERE id=$1`, [outbox.id, error.message]); }
      }
      await client.query('COMMIT'); return rows.length;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async claim({ workerId, limit = 10 } = {}) {
    const client = await this.pool.connect(); try { await client.query('BEGIN');
      const rows = (await client.query(`SELECT d.*,s.endpoint_url,s.secret_ciphertext,s.event_types,s.ordered,s.rate_limit_per_second,s.max_concurrency,e.type,e.version,e.payload,e.created_at,e.sequence_no FROM forge_event_deliveries d JOIN forge_event_subscriptions s ON s.id=d.subscription_id JOIN forge_events e ON e.id=d.event_id WHERE d.status IN ('PENDING','RETRY') AND d.available_at <= now() AND s.active AND (NOT s.ordered OR NOT EXISTS (SELECT 1 FROM forge_event_deliveries prior WHERE prior.subscription_id=d.subscription_id AND prior.sequence_no < d.sequence_no AND prior.status NOT IN ('SUCCEEDED','CANCELLED','DEAD_LETTER'))) AND (SELECT count(*) FROM forge_event_deliveries active WHERE active.subscription_id=d.subscription_id AND active.status='IN_FLIGHT' AND active.lease_until > now()) < s.max_concurrency AND (SELECT count(*) FROM forge_event_delivery_attempts a WHERE a.subscription_id=d.subscription_id AND a.started_at > now()-interval '1 second') < s.rate_limit_per_second ORDER BY d.sequence_no,d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT $1`, [limit])).rows;
      const claimed = []; for (const row of rows) { const token = crypto.randomUUID(); const updated = await client.query(`UPDATE forge_event_deliveries SET status='IN_FLIGHT',lease_token=$2,lease_until=now()+($3::text||' seconds')::interval,worker_id=$4,attempts=attempts+1,updated_at=now() WHERE id=$1 AND status IN ('PENDING','RETRY') RETURNING *`, [row.id, token, this.config.leaseSeconds, workerId]); if (updated.rows[0]) claimed.push({ ...row, ...updated.rows[0] }); }
      await client.query('COMMIT'); return claimed;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }
  async deliver(delivery) {
    const started = this.now(); let response = null; let error = null; let outcome = null; let retryAfterMs = null;
    const body = JSON.stringify({ id: delivery.event_id, type: delivery.type, version: delivery.version, occurredAt: delivery.created_at, tenantId: delivery.tenant_id, projectId: delivery.project_id, data: delivery.payload });
    const timestamp = Math.floor(started / 1000); const secret = decryptSecret(delivery.secret_ciphertext); const signature = hmac(secret, `${timestamp}.${body}`);
    try { await assertPublicDestination(delivery.endpoint_url); response = await this.fetch(delivery.endpoint_url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Forge-Studio-Events/1', 'x-forge-event-id': delivery.event_id, 'x-forge-delivery-id': delivery.id, 'x-forge-event-type': delivery.type, 'x-forge-event-version': String(delivery.version), 'x-forge-timestamp': String(timestamp), 'x-forge-signature': `v1=${signature}` }, body, signal: AbortSignal.timeout(this.config.timeoutMs) }); const classified = classifyResponse(response.status, response.headers.get('retry-after')); outcome = classified.outcome; retryAfterMs = classified.retryAfterMs;
    } catch (err) { error = err; outcome = 'RETRYING'; }
    const latencyMs = Math.max(0, this.now() - started); return this.finishDelivery(delivery, { outcome, retryAfterMs, error, response, latencyMs });
  }
  async finishDelivery(delivery, { outcome, retryAfterMs = null, error = null, response = null, latencyMs }) {
    const status = response?.status || null; let nextStatus = outcome; if (outcome === 'RETRYING' && delivery.attempts >= this.config.maxAttempts) nextStatus = 'DEAD_LETTER';
    const delayMs = retryAfterMs ?? computeBackoff(delivery.attempts, this.config); const nextAt = new Date(this.now() + delayMs); const client = await this.pool.connect();
    try { await client.query('BEGIN');
      await client.query(`INSERT INTO forge_event_delivery_attempts(id,delivery_id,subscription_id,attempt,status,response_status,error_code,latency_ms,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()-($9::text||' milliseconds')::interval,now())`, [crypto.randomUUID(), delivery.id, delivery.subscription_id, delivery.attempts, nextStatus, status, error?.code || null, latencyMs, latencyMs]);
      await client.query(`UPDATE forge_event_deliveries SET status=$2,available_at=$3,last_error=$4,last_response_status=$5,lease_token=NULL,lease_until=NULL,worker_id=NULL,updated_at=now(),completed_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED','DEAD_LETTER','CANCELLED') THEN now() ELSE completed_at END WHERE id=$1 AND lease_token=$6`, [delivery.id, nextStatus, nextStatus === 'RETRYING' ? nextAt : new Date(this.now()), error ? error.message.slice(0, 500) : null, status, delivery.lease_token]);
      if (nextStatus === 'DEAD_LETTER') await client.query(`INSERT INTO forge_event_dlq(delivery_id,reason,quarantined_at) VALUES($1,$2,now()) ON CONFLICT (delivery_id) DO UPDATE SET reason=EXCLUDED.reason`, [delivery.id, error?.message || `HTTP ${status}`]);
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; } finally { client.release(); }
    return { status: nextStatus, latencyMs, responseStatus: status };
  }
  async recoverExpiredLeases() { const result = await this.pool.query(`UPDATE forge_event_deliveries SET status='RETRY',available_at=now(),lease_token=NULL,lease_until=NULL,worker_id=NULL,updated_at=now(),last_error='delivery lease expired; recovered' WHERE status='IN_FLIGHT' AND lease_until < now() RETURNING id`); return result.rows.length; }
  async cancelDelivery(id, actor) {
    const result = await this.pool.query(`UPDATE forge_event_deliveries SET status='CANCELLED',lease_token=NULL,lease_until=NULL,worker_id=NULL,completed_at=now(),updated_at=now() WHERE id=$1 AND status NOT IN ('SUCCEEDED','DEAD_LETTER','CANCELLED') RETURNING *`, [id]);
    if (!result.rows[0]) throw Object.assign(new Error('Delivery not found or already terminal'), { code: 'NOT_FOUND' });
    await this.pool.query('INSERT INTO security_audit_events(tenant_id,project_id,actor,action,target_type,target_id,outcome,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [result.rows[0].tenant_id, result.rows[0].project_id, actor, 'delivery.cancelled', 'event_delivery', id, 'ALLOWED', JSON.stringify({ deliveryId: id })]);
    return result.rows[0];
  }
  async metrics({ tenantId = null } = {}) {
    const args = tenantId ? [tenantId] : []; const where = tenantId ? 'WHERE tenant_id=$1' : '';
    const counts = await this.pool.query(`SELECT status,count(*)::int count FROM forge_event_deliveries ${where} GROUP BY status ORDER BY status`, args);
    const backlog = await this.pool.query(`SELECT count(*)::int count FROM forge_event_deliveries ${where ? `${where} AND` : 'WHERE'} status IN ('PENDING','RETRY','IN_FLIGHT')`, args);
    const dlq = await this.pool.query(`SELECT count(*)::int count FROM forge_event_dlq ${tenantId ? 'WHERE delivery_id IN (SELECT id FROM forge_event_deliveries WHERE tenant_id=$1)' : ''}`, args);
    return { statuses: counts.rows, backlog: backlog.rows[0]?.count || 0, deadLetter: dlq.rows[0]?.count || 0 };
  }
}

function verifyWebhookSignature({ secret, timestamp, body, signature, now = Date.now(), toleranceSeconds = DEFAULTS.replayWindowSeconds }) {
  const ts = Number(timestamp); if (!Number.isInteger(ts)) return { valid: false, reason: 'INVALID_TIMESTAMP' };
  if (Math.abs(Math.floor(now / 1000) - ts) > toleranceSeconds) return { valid: false, reason: 'REPLAY_WINDOW_EXCEEDED' };
  const expected = `v1=${hmac(secret, `${ts}.${body}`)}`; const a = Buffer.from(expected); const b = Buffer.from(signature || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'INVALID_SIGNATURE' };
}

module.exports = { DurableEventDelivery, EVENT_SCHEMAS, deterministicDeliveryId, computeBackoff, classifyResponse, encryptSecret, decryptSecret, validateDestination, verifyWebhookSignature, isPrivateIp };
