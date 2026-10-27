'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const { DistributedRateLimiter } = require('../rate-limit/distributed-rate-limiter');
const { TenantPlanEntitlements } = require('../entitlements/tenant-plan-entitlements');
const { ProviderCircuitBreaker } = require('../providers/provider-circuit-breaker-runtime');

const CHANNELS = Object.freeze(['webhook','email','push','sms','voice']);
const RETRYABLE = new Set(['RATE_LIMITED','PROVIDER_TIMEOUT','PROVIDER_FAILED','NETWORK_FAILURE','CIRCUIT_OPEN','CHANNEL_UNAVAILABLE']);
const TERMINAL_SOURCE = new Set(['job','approval','incident','publish','provider_outage']);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = prefix => `${prefix}:${crypto.randomUUID()}`;
const sleepMs = attempt => Math.min(15 * 60_000, Math.max(1_000, 1_000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 750));

function json(value, fallback = {}) { return value && typeof value === 'object' ? value : fallback; }
function channelAddress(recipient, channel) { return json(recipient.address)[channel] ?? json(recipient.address).endpoint ?? null; }
function validChannel(channel) { return CHANNELS.includes(String(channel)); }
function safeError(error) { return { code: error?.code || 'DELIVERY_FAILED', message: String(error?.message || error), retryable: error?.retryable !== false }; }

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(date);
  const out = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return out;
}

function inQuietHours(parts, quiet) {
  if (!quiet || quiet.enabled === false || quiet.start == null || quiet.end == null) return false;
  const minute = parts.hour * 60 + parts.minute;
  const start = Number(quiet.start), end = Number(quiet.end);
  if (![start,end].every(Number.isFinite)) return false;
  return start === end ? true : start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function nextAllowedAt(from, timeZone, quiet) {
  if (!inQuietHours(localParts(from, timeZone), quiet)) return from;
  let cursor = new Date(from.getTime());
  for (let i = 0; i < 2880; i += 1) {
    cursor = new Date(cursor.getTime() + 60_000);
    if (!inQuietHours(localParts(cursor, timeZone), quiet)) return cursor;
  }
  return new Date(from.getTime() + 48 * 3600_000);
}

class NotificationOrchestrator {
  constructor({ pool, providerRegistry = null, logger = console, metrics = null, rateLimiter = null, entitlements = null, circuitBreaker = null, workerId = `forge-notify:${crypto.randomUUID()}` } = {}) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg pool required');
    this.pool = pool; this.providerRegistry = providerRegistry; this.logger = logger; this.metrics = metrics || { inc() {}, set() {} }; this.workerId = workerId;
    this.rateLimiter = rateLimiter || new DistributedRateLimiter({ pool, logger });
    this.entitlements = entitlements || new TenantPlanEntitlements({ pool, logger });
    this.circuitBreaker = circuitBreaker || new ProviderCircuitBreaker({ pool, metrics: this.metrics });
  }

  async tx(fn) { const c = await this.pool.connect(); try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; } finally { c.release(); } }

  async enqueue({ tenantId, projectId = null, intentKey, templateName, templateVersion = 1, payload = {}, priority = 100, dedupeKey = intentKey, recipients = [], channels = [], scheduledAt = null, deadlineAt = null, quietHours = {}, escalationPolicy = [], createdBy = 'system' }) {
    if (!tenantId || !intentKey || !templateName || !dedupeKey) throw new TypeError('tenantId, intentKey, templateName and dedupeKey are required');
    if (projectId) { const p = await this.pool.query('SELECT tenant_id FROM projects WHERE id=$1',[projectId]); if (p.rows[0]?.tenant_id !== tenantId) throw Object.assign(new Error('tenant/project mismatch'),{code:'TENANT_ISOLATION',statusCode:403}); }
    return this.tx(async c => {
      const existing = (await c.query('SELECT * FROM forge_notification_intents WHERE tenant_id=$1 AND dedupe_key=$2 FOR UPDATE',[tenantId,dedupeKey])).rows[0];
      if (existing) return existing;
      const intentId = id('notif');
      const intent = (await c.query(`INSERT INTO forge_notification_intents(id,tenant_id,project_id,intent_key,intent_version,source_type,template_name,template_version,payload,priority,dedupe_key,status,scheduled_at,deadline_at,quiet_hours,escalation_policy,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,COALESCE($13,now()),$14,$15::jsonb,$16::jsonb,$17) RETURNING *`,[intentId,tenantId,projectId,intentKey,Number(payload.version||1),payload.sourceType||'operator',templateName,templateVersion,JSON.stringify(payload),priority,dedupeKey,scheduledAt&&new Date(scheduledAt)>new Date()?'SCHEDULED':'QUEUED',scheduledAt,deadlineAt,JSON.stringify(quietHours),JSON.stringify(escalationPolicy),createdBy])).rows[0];
      const explicit = Array.isArray(recipients) ? recipients : [];
      let resolved = explicit;
      if (!resolved.length) {
        const rows = await c.query(`SELECT recipient_key,metadata,quiet_hours FROM forge_notification_preferences WHERE tenant_id=$1 AND enabled=true ORDER BY rank ASC,recipient_key ASC`,[tenantId]);
        resolved = rows.rows.map(r => ({ recipientKey:r.recipient_key,address:json(r.metadata).address||{},timezone:json(r.metadata).timezone||'UTC',locale:json(r.metadata).locale||'en',preferences:{channels:channels.length?channels:undefined},quietHours:r.quiet_hours||{}}));
      }
      for (const recipient of resolved) {
        const recipientKey = String(recipient.recipientKey || recipient.key || ''); if (!recipientKey) continue;
        const recipientId = id('nrec');
        await c.query(`INSERT INTO forge_notification_recipients(id,tenant_id,project_id,intent_id,recipient_key,address,timezone,locale,preferences) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb) ON CONFLICT(intent_id,recipient_key) DO UPDATE SET address=EXCLUDED.address,timezone=EXCLUDED.timezone,locale=EXCLUDED.locale,preferences=EXCLUDED.preferences`,[recipientId,tenantId,projectId,intent.id,recipientKey,JSON.stringify(recipient.address||{}),recipient.timezone||'UTC',recipient.locale||'en',JSON.stringify({...json(recipient.preferences),quietHours:recipient.quietHours||{}})]);
        const row = (await c.query('SELECT id,timezone,preferences FROM forge_notification_recipients WHERE intent_id=$1 AND recipient_key=$2',[intent.id,recipientKey])).rows[0];
        const prefs = json(row.preferences); const order = [...new Set((Array.isArray(prefs.channels)?prefs.channels:channels.length?channels:CHANNELS).filter(validChannel))];
        const fallback = order.length ? order : CHANNELS.filter(ch => channelAddress(recipient,ch));
        for (const channel of fallback) {
          const dedupe = `${intent.id}:${recipientKey}:${channel}`;
          const requestKey = `notification:${tenantId}:${hash({intent:intent.id,recipient:recipientKey,channel})}`;
          await c.query(`INSERT INTO forge_notification_deliveries(id,tenant_id,project_id,intent_id,recipient_id,channel,priority,status,provider_request_key,dedupe_key,idempotency_key,max_attempts,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$9,$8,$10,$11) ON CONFLICT(tenant_id,dedupe_key) DO NOTHING`,[id('ndel'),tenantId,projectId,intent.id,row.id,channel,priority,requestKey,dedupe,requestKey,Number(payload.maxAttempts||8),deadlineAt]);
        }
      }
      await c.query(`INSERT INTO forge_notification_audit(tenant_id,project_id,intent_id,actor_id,action,outcome,evidence) VALUES($1,$2,$3,$4,'ENQUEUE','ALLOWED',$5::jsonb)`,[tenantId,projectId,intent.id,createdBy,JSON.stringify({sourceType:payload.sourceType||'operator',templateName,recipientCount:resolved.length})]);
      return intent;
    });
  }

  async materializeOutbox(limit = 100) {
    const rows = await this.pool.query(`SELECT * FROM forge_outbox WHERE topic='notification.requested' AND published_at IS NULL AND available_at<=now() ORDER BY available_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,[Math.max(1,Math.min(500,limit))]);
    let materialized=0;
    for (const row of rows.rows) {
      try {
        const p=json(row.payload); const type=p.sourceType||row.aggregate_type; const sourceId=p.sourceId||String(row.aggregate_id); const template=`${type}.notification`;
        const priority = type==='incident'||type==='provider_outage'?10:type==='approval'?20:100;
        const recipient = p.recipientKey ? [{recipientKey:p.recipientKey,address:p.address||{},timezone:p.timezone||'UTC',locale:p.locale||'en',preferences:{channels:p.channels||[]}}] : [];
        await this.enqueue({tenantId:row.tenant_id,projectId:row.project_id,intentKey:`${type}:${sourceId}:${p.status||p.state||'event'}`,dedupeKey:`source:${row.aggregate_id}`,templateName:template,templateVersion:1,payload:p,priority,recipients:recipient,channels:p.channels||[],deadlineAt:p.deadlineAt||null,quietHours:p.quietHours||{},escalationPolicy:p.escalationPolicy||[],createdBy:'notification-materializer'});
        await this.pool.query(`UPDATE forge_outbox SET published_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1 AND published_at IS NULL`,[row.id]); materialized += 1;
      } catch (error) {
        await this.pool.query(`UPDATE forge_outbox SET attempts=attempts+1,last_error=$1,available_at=now()+interval '30 seconds' WHERE id=$2`,[error.message,row.id]);
        this.logger.error?.(JSON.stringify({event:'notification.materialize_failed',outboxId:row.id,error:safeError(error)}));
      }
    }
    return {materialized};
  }

  async claim(limit = 20) {
    return this.tx(async c => {
      const rows = (await c.query(`WITH picked AS (SELECT d.id FROM forge_notification_deliveries d WHERE d.status IN ('QUEUED','RETRY') AND d.next_attempt_at<=now() AND(d.deadline_at IS NULL OR d.deadline_at>now()) ORDER BY d.priority,d.next_attempt_at,d.created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE forge_notification_deliveries d SET status='LEASED',attempt_count=d.attempt_count+1,lease_token=$2,fencing_token=d.fencing_token+1,lease_until=now()+interval '90 seconds',updated_at=now() FROM picked p WHERE d.id=p.id RETURNING d.*`,[Math.max(1,Math.min(100,limit)),this.workerId])).rows;
      return rows;
    });
  }

  async recoverLeases() {
    const r = await this.pool.query(`UPDATE forge_notification_deliveries SET status='RETRY',lease_token=NULL,lease_until=NULL,next_attempt_at=now(),updated_at=now(),last_error_code='STALE_LEASE',last_error='worker lease expired' WHERE status='LEASED' AND lease_until<now() RETURNING id`);
    return r.rowCount;
  }

  async isSuppressed(delivery) {
    const r = await this.pool.query(`SELECT reason FROM forge_notification_suppressions WHERE tenant_id=$1 AND (project_id IS NULL OR project_id=$2) AND (recipient_key IS NULL OR recipient_key=$3) AND (channel IS NULL OR channel=$4) AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now()) ORDER BY created_at DESC LIMIT 1`,[delivery.tenant_id,delivery.project_id,delivery.recipient_key,delivery.channel]);
    return r.rows[0]?.reason||null;
  }

  async recipientDelivered(delivery) {
    const r = await this.pool.query(`SELECT 1 FROM forge_notification_deliveries x WHERE x.intent_id=$1 AND x.recipient_id=$2 AND x.status='SENT' AND x.id<>$3 LIMIT 1`,[delivery.intent_id,delivery.recipient_id,delivery.id]);
    return Boolean(r.rows.length);
  }

  async nextFallback(delivery) {
    await this.pool.query(`UPDATE forge_notification_deliveries SET status='CANCELLED',updated_at=now(),suppression_reason='fallback_not_needed' WHERE intent_id=$1 AND recipient_id=$2 AND status IN ('QUEUED','RETRY') AND id<>$3`,[delivery.intent_id,delivery.recipient_id,delivery.id]);
    const r=await this.pool.query(`SELECT d.id FROM forge_notification_deliveries d WHERE d.intent_id=$1 AND d.recipient_id=$2 AND d.status='QUEUED' ORDER BY d.priority,d.created_at LIMIT 1`,[delivery.intent_id,delivery.recipient_id]);
    if(r.rows[0]) await this.pool.query(`UPDATE forge_notification_deliveries SET status='RETRY',next_attempt_at=now(),updated_at=now() WHERE id=$1`,[r.rows[0].id]);
  }

  async reserveBudget(delivery) {
    try {
      const state = await this.entitlements.current(delivery.tenant_id);
      if (!state.capabilities?.notification_delivery) return null;
      return (await this.entitlements.reserve({tenantId:delivery.tenant_id,projectId:delivery.project_id,capability:'notification_delivery',amount:1,idempotencyKey:`notif-budget:${delivery.id}:${delivery.attempt_count}`,resourceType:'notification_delivery',resourceId:delivery.id,metadata:{channel:delivery.channel}})).reservation;
    } catch (error) {
      if (error.code === 'ENTITLEMENT_LIMIT_EXCEEDED' || error.code === 'ENTITLEMENT_DENIED') throw Object.assign(error,{retryable:false});
      throw error;
    }
  }

  async dispatchWebhook(delivery, recipient, intent) {
    const endpoint = channelAddress(recipient,'webhook'); if (!endpoint) throw Object.assign(new Error('webhook recipient address missing'),{code:'INVALID_RECIPIENT',retryable:false});
    const url = new URL(String(endpoint)); if (!['http:','https:'].includes(url.protocol)) throw Object.assign(new Error('webhook endpoint must be http(s)'),{code:'INVALID_ENDPOINT',retryable:false});
    const body = JSON.stringify({template:intent.template_name,templateVersion:intent.template_version,notificationId:intent.id,intentVersion:intent.intent_version,data:intent.payload});
    const controller = new AbortController(); const timer=setTimeout(()=>controller.abort(),Number(process.env.FORGE_NOTIFICATION_HTTP_TIMEOUT_MS||10000));
    try {
      const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':delivery.idempotency_key,'x-forge-notification-id':delivery.id},body,signal:controller.signal});
      const text=await response.text(); if(response.ok) return {provider:'webhook-http',status:response.status,response:text};
      const retryable=response.status===408||response.status===429||response.status>=500; const error=Object.assign(new Error(`webhook provider returned ${response.status}`),{code:response.status===429?'RATE_LIMITED':'PROVIDER_FAILED',statusCode:response.status,retryable,retryAfterMs:Number(response.headers.get('retry-after')||0)*1000}); throw error;
    } catch (error) { if(error.name==='AbortError') throw Object.assign(new Error('webhook provider timeout'),{code:'PROVIDER_TIMEOUT',retryable:true}); throw error; } finally { clearTimeout(timer); }
  }

  async dispatchProvider(delivery, recipient, intent) {
    if (!this.providerRegistry) throw Object.assign(new Error(`No registered notification provider for ${delivery.channel}`),{code:'CHANNEL_UNAVAILABLE',retryable:false});
    const capability=`notification.${delivery.channel}`;
    const result=await this.providerRegistry.execute(capability,{notificationId:intent.id,template:intent.template_name,templateVersion:intent.template_version,recipient:recipient.address,payload:intent.payload,idempotencyKey:delivery.idempotency_key},{tenantId:delivery.tenant_id,projectId:delivery.project_id,idempotencyKey:delivery.idempotency_key,allowFailover:true,healthRouting:true},{operation:'notification.send',policy:{timeoutMs:Number(process.env.FORGE_NOTIFICATION_PROVIDER_TIMEOUT_MS||30000),maxAttempts:1}});
    return {provider:result.provider||result.routing?.provider||capability,status:result.status||200,response:result.result||result};
  }

  async deliver(delivery) {
    const current=(await this.pool.query(`SELECT d.*,r.recipient_key,r.address,r.timezone,r.preferences,i.template_name,i.template_version,i.intent_version,i.payload,i.deadline_at AS intent_deadline,i.status AS intent_status,i.quiet_hours,i.escalation_policy FROM forge_notification_deliveries d JOIN forge_notification_recipients r ON r.id=d.recipient_id JOIN forge_notification_intents i ON i.id=d.intent_id WHERE d.id=$1`,[delivery.id])).rows[0];
    if(!current) return;
    if(current.intent_status==='CANCELLED'||current.intent_status==='EXPIRED') return this.pool.query(`UPDATE forge_notification_deliveries SET status='CANCELLED',updated_at=now(),suppression_reason='intent_cancelled' WHERE id=$1 AND status='LEASED'`,[current.id]);
    if(await this.recipientDelivered(current)) return this.pool.query(`UPDATE forge_notification_deliveries SET status='CANCELLED',updated_at=now(),suppression_reason='recipient_already_delivered' WHERE id=$1 AND status='LEASED'`,[current.id]);
    const suppressed=await this.isSuppressed(current); if(suppressed) return this.pool.query(`UPDATE forge_notification_deliveries SET status='SUPPRESSED',suppression_reason=$1,updated_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$2 AND status='LEASED'`,[suppressed,current.id]);
    const quiet = json(current.preferences).quietHours?.enabled!==undefined ? json(current.preferences).quietHours : json(current.quiet_hours); const allowedAt=nextAllowedAt(new Date(),current.timezone||'UTC',quiet); if(allowedAt>new Date()) return this.pool.query(`UPDATE forge_notification_deliveries SET status='RETRY',next_attempt_at=$1,lease_token=NULL,lease_until=NULL,last_error_code='QUIET_HOURS',updated_at=now() WHERE id=$2 AND status='LEASED'`,[allowedAt,current.id]);
    if(current.deadline_at && new Date(current.deadline_at)<=new Date()) return this.pool.query(`UPDATE forge_notification_deliveries SET status='EXPIRED',lease_token=NULL,lease_until=NULL,updated_at=now(),last_error_code='DEADLINE_EXCEEDED' WHERE id=$1 AND status='LEASED'`,[current.id]);
    let reservation=null; let attemptNo=current.attempt_count; const started=new Date();
    try {
      reservation=await this.reserveBudget(current);
      const rateKey=`notification:${current.tenant_id}:${current.channel}:${current.recipient_key}:${Math.floor(Date.now()/1000)}`;
      await this.rateLimiter.check({tenantId:current.tenant_id,projectId:current.project_id,method:'POST',url:`http://notification/${current.channel}`,requestKey:rateKey,cost:1});
      const route=current.channel==='webhook'?'webhook-http':`notification.${current.channel}`;
      const gate=await this.circuitBreaker.allow({tenantId:current.tenant_id,projectId:current.project_id,provider:route,service:'notifications',capability:current.channel,operation:'notification.send',impactScope:'TENANT',region:process.env.FORGE_REGION||''},{name:route,service:'notifications'});
      if(!gate.allowed) throw Object.assign(new Error('notification provider circuit is open'),{code:'CIRCUIT_OPEN',retryable:true,retryAfterMs:gate.retryAfterMs||1000});
      const result=current.channel==='webhook'?await this.dispatchWebhook(current,current,intentFrom(current)):await this.dispatchProvider(current,current,intentFrom(current));
      await this.circuitBreaker.outcome({tenantId:current.tenant_id,projectId:current.project_id,provider:route,service:'notifications',capability:current.channel,operation:'notification.send',impactScope:'TENANT',region:process.env.FORGE_REGION||''},{outcome:'SUCCESS',latencyMs:Date.now()-started.getTime(),attemptId:current.idempotency_key,eventId:`${current.id}:success`,metadata:{probeToken:gate.probeToken||null}});
      await this.pool.query(`INSERT INTO forge_notification_attempts(delivery_id,tenant_id,attempt_no,provider_route,request_key,outcome,provider_status,request_hash,response_hash,metadata,started_at,finished_at) VALUES($1,$2,$3,$4,$5,'SENT',$6,$7,$8,$9::jsonb,$10,now())`,[current.id,current.tenant_id,attemptNo,result.provider,result.provider, result.status,hash(current.payload),hash(result.response||{}),JSON.stringify({channel:current.channel}) ,started]);
      await this.pool.query(`UPDATE forge_notification_deliveries SET status='SENT',provider_route=$1,sent_at=now(),lease_token=NULL,lease_until=NULL,updated_at=now(),last_error_code=NULL,last_error=NULL WHERE id=$2 AND status='LEASED' AND lease_token=$3`,[result.provider,current.id,current.lease_token]);
      await this.pool.query(`UPDATE forge_notification_intents SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM forge_notification_deliveries WHERE intent_id=$1 AND status NOT IN ('SENT','CANCELLED','SUPPRESSED','EXPIRED','DEAD_LETTER','QUARANTINED')) THEN 'SUCCEEDED' ELSE 'PARTIAL' END,updated_at=now() WHERE id=$1`,[current.intent_id]);
      if(reservation) await this.entitlements.settle({reservationId:reservation.id,actualAmount:1,metadata:{deliveryId:current.id,outcome:'SENT'}}).catch(()=>{});
      this.metrics.inc('forge_notification_deliveries_total',{channel:current.channel,outcome:'sent'});
      return {sent:true};
    } catch (error) {
      if(reservation) await this.entitlements.release({reservationId:reservation.id,reason:error.code||'delivery_failed'}).catch(()=>{});
      const e=safeError(error); const retryable=RETRYABLE.has(e.code)||e.retryable; const terminal=!retryable||attemptNo>=current.max_attempts;
      await this.pool.query(`INSERT INTO forge_notification_attempts(delivery_id,tenant_id,attempt_no,provider_route,request_key,outcome,retry_after_ms,error_code,error_message,request_hash,metadata,started_at,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,now()) ON CONFLICT(delivery_id,attempt_no) DO UPDATE SET outcome=EXCLUDED.outcome,error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message,finished_at=now()`,[current.id,current.tenant_id,attemptNo,current.provider_route||current.channel,current.idempotency_key,e.code==='RATE_LIMITED'?'RATE_LIMITED':e.code==='CIRCUIT_OPEN'?'CIRCUIT_OPEN':e.code==='PROVIDER_TIMEOUT'?'TIMEOUT':'FAILED',e.retryAfterMs||null,e.code,e.message,hash(current.payload),JSON.stringify({attempt:attemptNo}),started]);
      const status=terminal?(e.code==='INVALID_RECIPIENT'||e.code==='CHANNEL_UNAVAILABLE'?'QUARANTINED':'DEAD_LETTER'):'RETRY';
      const delay=e.retryAfterMs||sleepMs(attemptNo); await this.pool.query(`UPDATE forge_notification_deliveries SET status=$1,next_attempt_at=CASE WHEN $1='RETRY' THEN now()+($2::bigint*interval '1 millisecond') ELSE next_attempt_at END,lease_token=NULL,lease_until=NULL,last_error_code=$3,last_error=$4,quarantine_reason=CASE WHEN $1='QUARANTINED' THEN $4 ELSE quarantine_reason END,updated_at=now() WHERE id=$5 AND status='LEASED' AND lease_token=$6`,[status,delay,e.code,e.message,current.id,current.lease_token]);
      if(terminal) { await this.nextFallback(current); await this.pool.query(`UPDATE forge_notification_intents SET status='PARTIAL',updated_at=now() WHERE id=$1 AND status NOT IN ('SUCCEEDED','CANCELLED','EXPIRED')`,[current.intent_id]); }
      this.metrics.inc('forge_notification_deliveries_total',{channel:current.channel,outcome:status.toLowerCase()}); this.logger.warn?.(JSON.stringify({event:'notification.delivery_failed',deliveryId:current.id,tenantId:current.tenant_id,channel:current.channel,error:e,status}));
      return {sent:false,status,error:e};
    }
  }

  async tick({materializeLimit=100,claimLimit=20}={}) { const materialized=await this.materializeOutbox(materializeLimit); const claimed=await this.claim(claimLimit); for(const item of claimed){try{await this.deliver(item)}catch(error){this.logger.error?.(JSON.stringify({event:'notification.worker_delivery_error',deliveryId:item.id,error:safeError(error)}));}} const recovered=await this.recoverLeases(); return {materialized,claimed:claimed.length,recovered}; }

  async cancel(id,{tenantId,actor='operator',reason='operator cancelled'}={}) { return this.tx(async c=>{const r=(await c.query(`UPDATE forge_notification_deliveries SET status='CANCELLED',lease_token=NULL,lease_until=NULL,updated_at=now(),suppression_reason=$1 WHERE id=$2 AND tenant_id=$3 AND status NOT IN ('SENT','CANCELLED','DEAD_LETTER','QUARANTINED') RETURNING *`,[reason,id,tenantId])).rows[0]; if(r)await c.query(`INSERT INTO forge_notification_audit(tenant_id,project_id,delivery_id,actor_id,action,outcome,evidence) VALUES($1,$2,$3,$4,'CANCEL','ALLOWED',$5::jsonb)`,[r.tenant_id,r.project_id,r.id,actor,JSON.stringify({reason})]); return r||null;}); }

  async suppress(input,{actor='operator'}={}) { const row={id:input.id||id('nsup'),tenantId:input.tenantId,projectId:input.projectId||null,recipientKey:input.recipientKey||null,channel:input.channel||null,templateName:input.templateName||null,reason:input.reason||'operator suppression',startsAt:input.startsAt||new Date().toISOString(),endsAt:input.endsAt||null}; await this.pool.query(`INSERT INTO forge_notification_suppressions(id,tenant_id,project_id,recipient_key,channel,template_name,reason,starts_at,ends_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[row.id,row.tenantId,row.projectId,row.recipientKey,row.channel,row.templateName,row.reason,row.startsAt,row.endsAt,actor]); return row; }

  async list({tenantId,projectId=null,status=null,limit=50,offset=0}={}) { const r=await this.pool.query(`SELECT d.*,r.recipient_key,i.template_name,i.source_type FROM forge_notification_deliveries d JOIN forge_notification_recipients r ON r.id=d.recipient_id JOIN forge_notification_intents i ON i.id=d.intent_id WHERE d.tenant_id=$1 AND ($2::text IS NULL OR d.project_id=$2) AND ($3::text IS NULL OR d.status=$3) ORDER BY d.created_at DESC LIMIT $4 OFFSET $5`,[tenantId,projectId,status,Math.min(200,Math.max(1,limit)),Math.max(0,offset)]); return r.rows; }

  async get(id,tenantId) { return (await this.pool.query(`SELECT d.*,r.recipient_key,r.address,i.template_name,i.template_version,i.payload,i.source_type FROM forge_notification_deliveries d JOIN forge_notification_recipients r ON r.id=d.recipient_id JOIN forge_notification_intents i ON i.id=d.intent_id WHERE d.id=$1 AND d.tenant_id=$2`,[id,tenantId])).rows[0]||null; }
}

function intentFrom(row){return {id:row.intent_id,template_name:row.template_name,template_version:row.template_version,intent_version:row.intent_version,payload:row.payload};}

module.exports = { NotificationOrchestrator, CHANNELS, nextAllowedAt, inQuietHours };
