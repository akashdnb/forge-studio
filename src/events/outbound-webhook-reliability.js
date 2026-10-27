'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { TransactionalOutboxDelivery } = require('./transactional-outbox');
const {
  EVENT_SCHEMAS,
  deterministicDeliveryId,
  computeBackoff,
  encryptSecret,
  decryptSecret,
  validateDestination,
} = require('./durable-delivery');

const RETRYABLE_4XX = new Set([408, 409, 425, 429]);
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER']);
const DEFAULTS = Object.freeze({
  maxAttempts: 8,
  timeoutMs: 10000,
  maxResponseBytes: 65536,
  replayWindowSeconds: 300,
  circuitFailureThreshold: 5,
  circuitCooldownSeconds: 60,
  maxConcurrency: 4,
  rateLimitPerSecond: 10,
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function schemaHash(schema) {
  return sha256(JSON.stringify(schema, Object.keys(schema).sort()));
}

function classifyOutboundResponse(status, retryAfter) {
  if (status >= 200 && status < 300) return { status: 'SUCCEEDED', retry: false, retryAfterMs: null };
  if (status >= 500 || RETRYABLE_4XX.has(status)) {
    let retryAfterMs = null;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = Math.min(86400000, Math.floor(seconds * 1000));
      else {
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) retryAfterMs = Math.min(86400000, Math.max(0, date - Date.now()));
      }
    }
    return { status: 'RETRY', retry: true, retryAfterMs };
  }
  return { status: 'FAILED', retry: false, retryAfterMs: null };
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || (b === 0 && c === 0))) return true;
    if (a === 192 && b === 0 && c >= 0 && c <= 255) return true;
    if (a === 198 && b >= 18 && b <= 19) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const n = ip.toLowerCase();
  if (n.startsWith('::ffff:')) return isPrivateIp(n.slice(7));
  return n === '::1' || n === '::' || n.startsWith('fc') || n.startsWith('fd') || n.startsWith('fe80:') || n.startsWith('ff');
}

async function resolvePublicDestination(endpointUrl) {
  const url = new URL(endpointUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw Object.assign(new Error('Webhook destination targets a private address'), { code: 'SSRF_BLOCKED' });
    return { host, address: host, family: net.isIP(host) };
  }
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw Object.assign(new Error('Webhook destination resolves to a private or mixed address set'), { code: 'SSRF_BLOCKED' });
  }
  const selected = addresses.find((entry) => !isPrivateIp(entry.address));
  if (!selected) throw Object.assign(new Error('Webhook destination has no public address'), { code: 'SSRF_BLOCKED' });
  return { host, address: selected.address, family: selected.family };
}

function requestPinned(endpointUrl, body, headers, { timeoutMs, maxResponseBytes, dnsResolver = resolvePublicDestination } = {}) {
  return dnsResolver(endpointUrl).then(({ host, address, family }) => new Promise((resolve, reject) => {
    const url = new URL(endpointUrl);
    const transport = url.protocol === 'https:' ? https : http;
    let responseBytes = 0;
    let responseBody = '';
    let settled = false;
    const request = transport.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { ...headers, host: url.host, 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
      servername: host,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes <= maxResponseBytes) responseBody += chunk;
        else if (!settled) {
          settled = true;
          request.destroy(Object.assign(new Error('Webhook response exceeds configured limit'), { code: 'RESPONSE_TOO_LARGE' }));
        }
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode || 0, headers: response.headers, body: responseBody });
      });
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('Webhook request timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    request.end(body);
  }));
}

function signOutbound(secret, timestamp, nonce, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${nonce}.${body}`).digest('hex');
}

function verifyOutboundSignature({ secret, timestamp, nonce, body, signature, now = Date.now(), toleranceSeconds = DEFAULTS.replayWindowSeconds }) {
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || !nonce) return { valid: false, reason: 'INVALID_TIMESTAMP_OR_NONCE' };
  if (Math.abs(Math.floor(now / 1000) - ts) > toleranceSeconds) return { valid: false, reason: 'REPLAY_WINDOW_EXCEEDED' };
  const expected = `v1=${signOutbound(secret, ts, nonce, body)}`;
  const actual = Buffer.from(String(signature || ''));
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) return { valid: false, reason: 'INVALID_SIGNATURE' };
  return { valid: true };
}

class OutboundWebhookReliability extends TransactionalOutboxDelivery {
  constructor(options = {}) {
    super(options);
    this.config = {
      ...DEFAULTS,
      ...this.config,
      maxAttempts: Number(options.config?.maxAttempts || process.env.FORGE_EVENT_MAX_ATTEMPTS || DEFAULTS.maxAttempts),
    };
    this.requestImpl = options.requestImpl || requestPinned;
    this.dnsResolver = options.dnsResolver || resolvePublicDestination;
  }

  async createSubscription(args = {}) {
    const endpointUrl = validateDestination(args.endpointUrl);
    await this.dnsResolver(endpointUrl);
    if (!args.tenantId || !args.createdBy) throw new TypeError('tenantId and createdBy are required');
    const secretCiphertext = encryptSecret(args.secret);
    const id = crypto.randomUUID();
    const keyId = `key:${id}:1`;
    const configurationRef = args.configurationRef || `endpoint:${id}`;
    const eventTypes = args.eventTypes || [];
    for (const type of eventTypes) if (!EVENT_SCHEMAS[type]) throw new TypeError(`Unknown event type: ${type}`);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO forge_event_subscriptions
        (id,tenant_id,project_id,endpoint_url,secret_ciphertext,event_types,ordered,rate_limit_per_second,max_concurrency,created_by,
         endpoint_config_ref,endpoint_fingerprint,delivery_epoch,active_key_id,circuit_failure_threshold,circuit_cooldown_seconds,max_attempts,
         governance_decision_id,governance_policy_hash,updated_by)
        VALUES($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12,1,$13,$14,$15,$16,$17,$18,$10)`,
      [id,args.tenantId,args.projectId || null,endpointUrl,secretCiphertext,eventTypes,Boolean(args.ordered),args.rateLimitPerSecond || DEFAULTS.rateLimitPerSecond,args.maxConcurrency || DEFAULTS.maxConcurrency,args.createdBy,
        configurationRef,sha256(endpointUrl),keyId,args.circuitFailureThreshold || DEFAULTS.circuitFailureThreshold,args.circuitCooldownSeconds || DEFAULTS.circuitCooldownSeconds,args.maxAttempts || this.config.maxAttempts,args.governanceDecisionId || null,args.governancePolicyHash || null]);
      await c.query(`INSERT INTO forge_event_subscription_keys(id,subscription_id,tenant_id,key_epoch,secret_ciphertext,status,created_by)
        VALUES($1,$2,$3,1,$4,'ACTIVE',$5)`, [keyId,id,args.tenantId,secretCiphertext,args.createdBy]);
      await c.query('COMMIT');
      return (await this.pool.query(`SELECT id,tenant_id,project_id,endpoint_url,event_types,ordered,rate_limit_per_second,max_concurrency,active,endpoint_config_ref,delivery_epoch,active_key_id,circuit_state,circuit_failures,circuit_opened_until,governance_decision_id,governance_policy_hash,created_by,created_at,updated_at FROM forge_event_subscriptions WHERE id=$1`, [id])).rows[0];
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async fanout(limit = 100, workerId = `outbox:${crypto.randomUUID()}`) {
    const claim = await this.pool.connect();
    let rows;
    try {
      await claim.query('BEGIN');
      rows = (await claim.query(`SELECT * FROM forge_outbox WHERE published_at IS NULL AND dead_letter_at IS NULL AND available_at <= now()
        AND (lease_until IS NULL OR lease_until < now()) ORDER BY ordering_key NULLS LAST,ordering_sequence NULLS LAST,id
        FOR UPDATE SKIP LOCKED LIMIT $1`, [limit])).rows;
      for (const row of rows) {
        const token = crypto.randomUUID();
        const updated = await claim.query(`UPDATE forge_outbox SET lease_token=$2,lease_until=now()+($3::text||' seconds')::interval,worker_id=$4,attempts=attempts+1
          WHERE id=$1 AND published_at IS NULL AND dead_letter_at IS NULL AND (lease_until IS NULL OR lease_until < now()) RETURNING attempts`, [row.id,token,this.config.leaseSeconds,workerId]);
        if (!updated.rows[0]) continue;
        row.lease_token = token;
        row.attempts = Number(updated.rows[0].attempts);
      }
      await claim.query('COMMIT');
    } catch (error) { await claim.query('ROLLBACK').catch(() => {}); throw error; } finally { claim.release(); }

    for (const row of rows) {
      if (!row.lease_token) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const eventId = row.event_id || row.payload?.eventId;
        const event = (await client.query('SELECT * FROM forge_events WHERE id=$1 FOR SHARE', [eventId])).rows[0];
        if (!event) throw Object.assign(new Error('event missing'), { code: 'EVENT_MISSING' });
        const subscriptions = (await client.query(`SELECT * FROM forge_event_subscriptions WHERE active AND tenant_id=$1
          AND (project_id IS NULL OR project_id=$2) AND (cardinality(event_types)=0 OR $3=ANY(event_types))`, [event.tenant_id,event.project_id,event.type])).rows;
        for (const subscription of subscriptions) {
          const deliveryId = deterministicDeliveryId(`${event.id}:${subscription.id}`, subscription.delivery_epoch);
          await client.query(`INSERT INTO forge_event_deliveries
            (id,event_id,subscription_id,tenant_id,project_id,sequence_no,ordering_key,ordering_sequence,delivery_epoch,key_id,endpoint_url_snapshot,
             endpoint_config_ref_snapshot,endpoint_fingerprint,payload_hash,schema_name,schema_version,schema_hash,idempotency_key,status,available_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'PENDING',now())
            ON CONFLICT(event_id,subscription_id,delivery_epoch) DO NOTHING`,
          [deliveryId,event.id,subscription.id,event.tenant_id,event.project_id,event.sequence_no,event.ordering_key,event.aggregate_sequence,subscription.delivery_epoch,subscription.active_key_id,
            subscription.endpoint_url,subscription.endpoint_config_ref,subscription.endpoint_fingerprint,event.payload_hash,event.schema_name,event.schema_version,schemaHash(event.schema),deliveryId]);
        }
        const fenced = await client.query(`UPDATE forge_outbox SET published_at=now(),last_error=NULL,last_error_code=NULL,lease_token=NULL,lease_until=NULL,worker_id=NULL
          WHERE id=$1 AND lease_token=$2 AND published_at IS NULL RETURNING id`, [row.id,row.lease_token]);
        if (!fenced.rows[0]) throw Object.assign(new Error('outbox fencing token lost'), { code: 'OUTBOX_FENCED' });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const terminal = row.attempts >= this.config.maxOutboxAttempts;
        await this.pool.query(`UPDATE forge_outbox SET last_error=$2,last_error_code=$3,available_at=CASE WHEN $5 THEN now() ELSE now()+($4::text||' milliseconds')::interval END,
          lease_token=NULL,lease_until=NULL,worker_id=NULL,dead_letter_at=CASE WHEN $5 THEN now() ELSE dead_letter_at END,quarantine_reason=CASE WHEN $5 THEN $2 ELSE quarantine_reason END
          WHERE id=$1 AND lease_token=$6`, [row.id,error.message.slice(0,500),error.code || 'OUTBOX_FAILURE',computeBackoff(row.attempts,this.config),terminal,row.lease_token]);
      } finally { client.release(); }
    }
    return rows.length;
  }

  async claim({ workerId, limit = 10 } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE forge_event_subscriptions SET circuit_state='HALF_OPEN',updated_at=now()
        WHERE active AND circuit_state='OPEN' AND circuit_opened_until IS NOT NULL AND circuit_opened_until <= now()`);
      const rows = (await client.query(`SELECT d.*,s.secret_ciphertext AS legacy_secret_ciphertext,s.circuit_state,s.circuit_opened_until,s.max_attempts,
          e.type,e.version,e.payload,e.redacted_payload,e.created_at,e.sequence_no,e.ordering_key,e.aggregate_sequence,e.schema_name,e.schema_version,
          e.causation_id,e.correlation_id,k.secret_ciphertext,k.status AS key_status
        FROM forge_event_deliveries d
        JOIN forge_event_subscriptions s ON s.id=d.subscription_id
        JOIN forge_event_subscription_keys k ON k.id=d.key_id
        JOIN forge_events e ON e.id=d.event_id
        LEFT JOIN forge_event_consumer_cursors cursor ON cursor.subscription_id=d.subscription_id AND cursor.ordering_key=d.ordering_key
        WHERE d.status IN ('PENDING','RETRY') AND d.available_at <= now() AND s.active
          AND (s.circuit_state <> 'OPEN')
          AND (s.circuit_state <> 'HALF_OPEN' OR NOT EXISTS(SELECT 1 FROM forge_event_deliveries probe WHERE probe.subscription_id=d.subscription_id AND probe.status='IN_FLIGHT' AND probe.lease_until>now()))
          AND (d.replay_of IS NOT NULL OR cursor.last_acked_sequence IS NULL OR d.ordering_sequence > cursor.last_acked_sequence)
          AND (NOT s.ordered OR d.replay_of IS NOT NULL OR NOT EXISTS(
            SELECT 1 FROM forge_event_deliveries prior WHERE prior.subscription_id=d.subscription_id AND prior.ordering_key=d.ordering_key
              AND prior.ordering_sequence<d.ordering_sequence AND prior.status NOT IN ('SUCCEEDED','CANCELLED','DEAD_LETTER') AND prior.replay_of IS NULL))
          AND (SELECT count(*) FROM forge_event_deliveries active WHERE active.subscription_id=d.subscription_id AND active.status='IN_FLIGHT' AND active.lease_until>now()) < s.max_concurrency
          AND (SELECT count(*) FROM forge_event_delivery_attempts a WHERE a.subscription_id=d.subscription_id AND a.started_at>now()-interval '1 second') < s.rate_limit_per_second
        ORDER BY d.ordering_key,d.ordering_sequence,d.created_at,d.id
        FOR UPDATE OF d SKIP LOCKED LIMIT $1`, [limit])).rows;
      const claimed = [];
      const halfOpenSeen = new Set();
      for (const row of rows) {
        if (row.circuit_state === 'HALF_OPEN' && halfOpenSeen.has(row.subscription_id)) continue;
        const token = crypto.randomUUID();
        const updated = await client.query(`UPDATE forge_event_deliveries SET status='IN_FLIGHT',lease_token=$2,lease_until=now()+($3::text||' seconds')::interval,
          worker_id=$4,attempts=attempts+1,updated_at=now() WHERE id=$1 AND status IN ('PENDING','RETRY') AND (lease_until IS NULL OR lease_until<now()) RETURNING *`, [row.id,token,this.config.leaseSeconds,workerId]);
        if (updated.rows[0]) { claimed.push({ ...row, ...updated.rows[0] }); if (row.circuit_state === 'HALF_OPEN') halfOpenSeen.add(row.subscription_id); }
      }
      await client.query('COMMIT');
      return claimed;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  async deliver(delivery) {
    const state = (await this.pool.query(`SELECT s.active,s.delivery_epoch,s.active_key_id,s.circuit_state FROM forge_event_subscriptions s WHERE s.id=$1 AND s.tenant_id=$2`, [delivery.subscription_id,delivery.tenant_id])).rows[0];
    if (!state?.active) return this.finishDelivery(delivery,{ outcome:'CANCELLED',response:null,error:Object.assign(new Error('endpoint is inactive'),{code:'ENDPOINT_INACTIVE'}),latencyMs:0 });
    const body = JSON.stringify({ id:delivery.event_id,type:delivery.type,version:delivery.schema_version || delivery.version,occurredAt:delivery.created_at,tenantId:delivery.tenant_id,projectId:delivery.project_id,data:delivery.redacted_payload || delivery.payload });
    const timestamp = Math.floor(Date.now()/1000);
    const nonce = crypto.randomUUID();
    const secret = decryptSecret(delivery.secret_ciphertext || delivery.legacy_secret_ciphertext);
    const signature = signOutbound(secret,timestamp,nonce,body);
    const headers = {
      'content-type':'application/json','user-agent':'Forge-Studio-Events/2','x-forge-event-id':delivery.event_id,'x-forge-delivery-id':delivery.id,
      'x-forge-idempotency-key':delivery.idempotency_key || delivery.id,'x-forge-event-type':delivery.type,'x-forge-event-version':String(delivery.schema_version || delivery.version),
      'x-forge-payload-sha256':delivery.payload_hash,'x-forge-schema-hash':delivery.schema_hash,'x-forge-delivery-epoch':String(delivery.delivery_epoch),
      'x-forge-timestamp':String(timestamp),'x-forge-nonce':nonce,'x-forge-key-id':delivery.key_id,'x-forge-signature-version':'v1','x-forge-signature':`v1=${signature}`,
    };
    const started = Date.now();
    try {
      const response = await this.requestImpl(delivery.endpoint_url_snapshot,body,headers,{timeoutMs:this.config.timeoutMs,maxResponseBytes:this.config.maxResponseBytes,dnsResolver:this.dnsResolver});
      const classified = classifyOutboundResponse(response.status,response.headers?.['retry-after'] || response.headers?.get?.('retry-after'));
      return this.finishDelivery(delivery,{ outcome:classified.status,retryAfterMs:classified.retryAfterMs,response,error:null,latencyMs:Date.now()-started,nonce,timestamp,responseBody:response.body });
    } catch (error) {
      return this.finishDelivery(delivery,{ outcome:'RETRY',retryAfterMs:null,response:null,error,latencyMs:Date.now()-started,nonce,timestamp,responseBody:'' });
    }
  }

  async finishDelivery(delivery, options = {}) {
    const statusCode = options.response?.status || null;
    let next = options.outcome;
    const maxAttempts = Number(delivery.max_attempts || this.config.maxAttempts);
    if (next === 'RETRY' && Number(delivery.attempts) >= maxAttempts) next = 'DEAD_LETTER';
    const delay = options.retryAfterMs ?? computeBackoff(Number(delivery.attempts), this.config);
    const availableAt = new Date(Date.now() + delay);
    const responseBodyHash = options.responseBody ? sha256(options.responseBody) : null;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO forge_event_delivery_attempts
        (id,delivery_id,subscription_id,attempt,status,response_status,error_code,latency_ms,started_at,finished_at,nonce,request_timestamp,key_id,idempotency_key,response_body_hash,retry_after_ms,error_class)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()-($9::text||' milliseconds')::interval,now(),$10,$11,$12,$13,$14,$15,$16)`,
      [crypto.randomUUID(),delivery.id,delivery.subscription_id,delivery.attempts,next,statusCode,options.error?.code || null,options.latencyMs || 0,options.latencyMs || 0,options.nonce || null,options.timestamp || null,delivery.key_id,delivery.idempotency_key || delivery.id,responseBodyHash,options.retryAfterMs || null,options.error?.name || null]);

      let circuitState = 'CLOSED';
      if (next === 'SUCCEEDED') {
        await c.query(`UPDATE forge_event_subscriptions SET circuit_state='CLOSED',circuit_failures=0,circuit_opened_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2`, [delivery.subscription_id,delivery.tenant_id]);
      } else if (next !== 'CANCELLED') {
        const s = (await c.query(`SELECT circuit_failures,circuit_failure_threshold,circuit_cooldown_seconds,circuit_state FROM forge_event_subscriptions WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [delivery.subscription_id,delivery.tenant_id])).rows[0];
        const failures = Number(s?.circuit_failures || 0) + 1;
        circuitState = failures >= Number(s?.circuit_failure_threshold || DEFAULTS.circuitFailureThreshold) ? 'OPEN' : (s?.circuit_state === 'HALF_OPEN' ? 'HALF_OPEN' : 'CLOSED');
        await c.query(`UPDATE forge_event_subscriptions SET circuit_failures=$2,circuit_state=$3,circuit_opened_until=CASE WHEN $3='OPEN' THEN now()+($4::text||' seconds')::interval ELSE circuit_opened_until END,updated_at=now() WHERE id=$1 AND tenant_id=$5`, [delivery.subscription_id,failures,circuitState,Number(s?.circuit_cooldown_seconds || DEFAULTS.circuitCooldownSeconds),delivery.tenant_id]);
      }

      await c.query(`UPDATE forge_event_deliveries SET status=$2,available_at=$3,last_error=$4,last_response_status=$5,lease_token=NULL,lease_until=NULL,worker_id=NULL,
        updated_at=now(),completed_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED','DEAD_LETTER','CANCELLED') THEN now() ELSE completed_at END
        WHERE id=$1 AND lease_token=$6`, [delivery.id,next,next==='RETRY'?availableAt:new Date(),options.error?.message?.slice(0,500) || null,statusCode,delivery.lease_token]);
      if (next === 'SUCCEEDED' && delivery.replay_of == null) {
        await c.query(`INSERT INTO forge_event_consumer_cursors(subscription_id,tenant_id,ordering_key,last_acked_sequence,last_event_id,updated_at)
          VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(subscription_id,ordering_key) DO UPDATE SET
          last_acked_sequence=GREATEST(forge_event_consumer_cursors.last_acked_sequence,EXCLUDED.last_acked_sequence),
          last_event_id=CASE WHEN EXCLUDED.last_acked_sequence>=forge_event_consumer_cursors.last_acked_sequence THEN EXCLUDED.last_event_id ELSE forge_event_consumer_cursors.last_event_id END,updated_at=now()`,
        [delivery.subscription_id,delivery.tenant_id,delivery.ordering_key,delivery.ordering_sequence,delivery.event_id]);
        await c.query(`UPDATE forge_event_deliveries SET acked_at=now(),acked_by=$2 WHERE id=$1 AND status='SUCCEEDED'`, [delivery.id,delivery.worker_id || 'event-worker']);
      }
      if (next === 'DEAD_LETTER') await c.query(`INSERT INTO forge_event_dlq(delivery_id,reason,quarantined_at) VALUES($1,$2,now()) ON CONFLICT(delivery_id) DO UPDATE SET reason=EXCLUDED.reason,quarantined_at=now()`, [delivery.id,options.error?.message || `HTTP ${statusCode || 0}`]);
      await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
    return { status:next, latencyMs:options.latencyMs || 0, responseStatus:statusCode, circuitState };
  }

  async recoverExpiredLeases() {
    const r = await this.pool.query(`UPDATE forge_event_deliveries SET status='RETRY',available_at=now(),lease_token=NULL,lease_until=NULL,worker_id=NULL,updated_at=now(),last_error='delivery lease expired; recovered'
      WHERE status='IN_FLIGHT' AND lease_until<now() RETURNING id`, []);
    return { deliveries:r.rows.length, ids:r.rows.map((row) => row.id) };
  }

  async replayDelivery(id, tenantId, actor = 'operator') {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const original = (await c.query(`SELECT d.*,s.active,s.delivery_epoch AS current_epoch,s.active_key_id,s.endpoint_url,s.endpoint_config_ref,s.endpoint_fingerprint,s.max_attempts,s.tenant_id AS subscription_tenant
        FROM forge_event_deliveries d JOIN forge_event_subscriptions s ON s.id=d.subscription_id WHERE d.id=$1 AND d.tenant_id=$2 FOR UPDATE`, [id,tenantId])).rows[0];
      if (!original) throw Object.assign(new Error('Delivery not found'),{code:'NOT_FOUND',statusCode:404});
      if (!TERMINAL.has(original.status)) throw Object.assign(new Error('Only terminal deliveries may be replayed'),{code:'DELIVERY_NOT_TERMINAL',statusCode:409});
      if (!original.active) throw Object.assign(new Error('Endpoint is inactive'),{code:'ENDPOINT_INACTIVE',statusCode:409});
      const nextEpoch = Number((await c.query(`SELECT COALESCE(max(delivery_epoch),0)+1 AS epoch FROM forge_event_deliveries WHERE event_id=$1 AND subscription_id=$2`, [original.event_id,original.subscription_id])).rows[0].epoch);
      const newId = deterministicDeliveryId(`${original.event_id}:${original.subscription_id}`,nextEpoch);
      const event = (await c.query('SELECT * FROM forge_events WHERE id=$1',[original.event_id])).rows[0];
      await c.query(`INSERT INTO forge_event_deliveries
        (id,event_id,subscription_id,tenant_id,project_id,sequence_no,ordering_key,ordering_sequence,delivery_epoch,key_id,endpoint_url_snapshot,endpoint_config_ref_snapshot,endpoint_fingerprint,
         payload_hash,schema_name,schema_version,schema_hash,idempotency_key,replay_of,status,available_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'PENDING',now()) ON CONFLICT DO NOTHING`,
      [newId,event.id,original.subscription_id,event.tenant_id,event.project_id,event.sequence_no,event.ordering_key,event.ordering_sequence,nextEpoch,original.active_key_id,original.endpoint_url,original.endpoint_config_ref,original.endpoint_fingerprint,event.payload_hash,event.schema_name,event.schema_version,schemaHash(event.schema),newId,id]);
      await c.query(`INSERT INTO security_audit_events(tenant_id,project_id,actor,action,target_type,target_id,outcome,details)
        VALUES($1,$2,$3,'delivery.replayed','event_delivery',$4,'ALLOWED',$5::jsonb)`, [tenantId,original.project_id,actor,id,JSON.stringify({deliveryId:id,replayDeliveryId:newId,deliveryEpoch:nextEpoch})]);
      await c.query('COMMIT');
      return (await this.pool.query('SELECT * FROM forge_event_deliveries WHERE id=$1',[newId])).rows[0];
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async rotateSecret(id, tenantId, secret, actor) {
    const encrypted = encryptSecret(secret);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const sub = (await c.query('SELECT * FROM forge_event_subscriptions WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[id,tenantId])).rows[0];
      if (!sub) throw Object.assign(new Error('Endpoint not found'),{code:'NOT_FOUND',statusCode:404});
      const epoch = Number(sub.delivery_epoch) + 1;
      const keyId = `key:${id}:${epoch}`;
      await c.query(`INSERT INTO forge_event_subscription_keys(id,subscription_id,tenant_id,key_epoch,secret_ciphertext,status,created_by) VALUES($1,$2,$3,$4,$5,'ACTIVE',$6)`,[keyId,id,tenantId,epoch,encrypted,actor]);
      await c.query(`UPDATE forge_event_subscription_keys SET status='RETIRED',retired_at=now() WHERE subscription_id=$1 AND id<>$2 AND status='ACTIVE'`,[id,keyId]);
      await c.query(`UPDATE forge_event_subscriptions SET secret_ciphertext=$2,active_key_id=$3,delivery_epoch=$4,updated_by=$5,updated_at=now() WHERE id=$1`,[id,encrypted,keyId,epoch,actor]);
      await c.query(`INSERT INTO security_audit_events(tenant_id,project_id,actor,action,target_type,target_id,outcome,details) VALUES($1,$2,$3,'delivery.secret_rotated','event_subscription',$4,'ALLOWED',$5::jsonb)`,[tenantId,sub.project_id,actor,id,JSON.stringify({keyId,deliveryEpoch:epoch})]);
      await c.query('COMMIT');
      return { id,keyId,deliveryEpoch:epoch };
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async resetCircuit(id, tenantId, actor) {
    const r = await this.pool.query(`UPDATE forge_event_subscriptions SET circuit_state='CLOSED',circuit_failures=0,circuit_opened_until=NULL,updated_by=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING id,circuit_state,circuit_failures`,[id,tenantId,actor]);
    if (!r.rows[0]) throw Object.assign(new Error('Endpoint not found'),{code:'NOT_FOUND',statusCode:404});
    await this.pool.query(`INSERT INTO security_audit_events(tenant_id,project_id,actor,action,target_type,target_id,outcome,details) SELECT tenant_id,project_id,$3,'delivery.circuit_reset','event_subscription',$1,'ALLOWED',$4::jsonb FROM forge_event_subscriptions WHERE id=$1`,[id,tenantId,actor,JSON.stringify({id})]);
    return r.rows[0];
  }

  async releaseQuarantine(id, tenantId, actor) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const row = (await c.query(`SELECT d.*,s.active,s.delivery_epoch,s.active_key_id,s.endpoint_url,s.endpoint_config_ref,s.endpoint_fingerprint FROM forge_event_deliveries d JOIN forge_event_subscriptions s ON s.id=d.subscription_id WHERE d.id=$1 AND d.tenant_id=$2 FOR UPDATE`,[id,tenantId])).rows[0];
      if (!row) throw Object.assign(new Error('Delivery not found'),{code:'NOT_FOUND',statusCode:404});
      if (row.status !== 'DEAD_LETTER') throw Object.assign(new Error('Delivery is not quarantined'),{code:'DELIVERY_NOT_QUARANTINED',statusCode:409});
      await c.query(`UPDATE forge_event_deliveries SET status='RETRY',available_at=now(),completed_at=NULL,last_error=NULL,lease_token=NULL,lease_until=NULL,worker_id=NULL,updated_at=now() WHERE id=$1`,[id]);
      await c.query(`UPDATE forge_event_dlq SET released_at=now(),release_reason=$2 WHERE delivery_id=$1`,[id,`released by ${actor}`]);
      await c.query(`INSERT INTO security_audit_events(tenant_id,project_id,actor,action,target_type,target_id,outcome,details) VALUES($1,$2,$3,'delivery.quarantine_released','event_delivery',$4,'ALLOWED',$5::jsonb)`,[tenantId,row.project_id,actor,id,JSON.stringify({deliveryId:id})]);
      await c.query('COMMIT');
      return (await this.pool.query('SELECT * FROM forge_event_deliveries WHERE id=$1',[id])).rows[0];
    } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }

  async inspectEndpoint(id, tenantId) {
    const endpoint = (await this.pool.query(`SELECT id,tenant_id,project_id,endpoint_url,event_types,ordered,rate_limit_per_second,max_concurrency,active,endpoint_config_ref,endpoint_fingerprint,delivery_epoch,active_key_id,circuit_state,circuit_failures,circuit_opened_until,circuit_failure_threshold,circuit_cooldown_seconds,max_attempts,governance_decision_id,governance_policy_hash,created_by,created_at,updated_at FROM forge_event_subscriptions WHERE id=$1 AND tenant_id=$2`,[id,tenantId])).rows[0];
    if (!endpoint) throw Object.assign(new Error('Endpoint not found'),{code:'NOT_FOUND',statusCode:404});
    const deliveries = (await this.pool.query(`SELECT status,count(*)::int count FROM forge_event_deliveries WHERE subscription_id=$1 GROUP BY status ORDER BY status`,[id])).rows;
    const attempts = (await this.pool.query(`SELECT count(*)::int attempts,coalesce(avg(latency_ms),0)::int avg_latency_ms FROM forge_event_delivery_attempts WHERE subscription_id=$1 AND started_at>now()-interval '24 hours'`,[id])).rows[0];
    return { endpoint, deliveries, attempts };
  }

  async metrics({tenantId = null} = {}) {
    const args = tenantId ? [tenantId] : [];
    const where = tenantId ? 'WHERE tenant_id=$1' : '';
    const statuses = (await this.pool.query(`SELECT status,count(*)::int count FROM forge_event_deliveries ${where} GROUP BY status ORDER BY status`,args)).rows;
    const backlog = (await this.pool.query(`SELECT count(*)::int count FROM forge_event_deliveries ${where ? `${where} AND` : 'WHERE'} status IN ('PENDING','RETRY','IN_FLIGHT')`,args)).rows[0]?.count || 0;
    const staleLeases = (await this.pool.query(`SELECT count(*)::int count FROM forge_event_deliveries ${where ? `${where} AND` : 'WHERE'} status='IN_FLIGHT' AND lease_until<now()`,args)).rows[0]?.count || 0;
    const circuits = (await this.pool.query(`SELECT circuit_state,count(*)::int count FROM forge_event_subscriptions ${where} GROUP BY circuit_state`,args)).rows;
    const deadLetter = (await this.pool.query(`SELECT count(*)::int count FROM forge_event_dlq WHERE released_at IS NULL ${tenantId ? 'AND delivery_id IN (SELECT id FROM forge_event_deliveries WHERE tenant_id=$1)' : ''}`,args)).rows[0]?.count || 0;
    return { statuses, backlog, staleLeases, deadLetter, circuits };
  }
}

module.exports = {
  OutboundWebhookReliability,
  classifyOutboundResponse,
  resolvePublicDestination,
  isPrivateIp,
  signOutbound,
  verifyOutboundSignature,
  requestPinned,
};
