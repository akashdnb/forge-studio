'use strict';

const crypto = require('node:crypto');
const { OutboundWebhookReliability } = require('./outbound-webhook-reliability');
const { computeBackoff } = require('./durable-delivery');
const { requestPinned } = require('./outbound-webhook-http');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

class FencedOutboundWebhookReliability extends OutboundWebhookReliability {
  constructor(options = {}) {
    super(options);
    this.requestImpl = options.requestImpl || requestPinned;
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
      const current = (await c.query(`SELECT status,lease_token,lease_until,worker_id FROM forge_event_deliveries WHERE id=$1 FOR UPDATE`, [delivery.id])).rows[0];
      if (!current || current.status !== 'IN_FLIGHT' || current.lease_token !== delivery.lease_token || !current.lease_until || new Date(current.lease_until).getTime() <= Date.now()) {
        await c.query('ROLLBACK');
        return { status: 'FENCED', latencyMs: options.latencyMs || 0, responseStatus: statusCode, circuitState: 'UNCHANGED' };
      }

      await c.query(`INSERT INTO forge_event_delivery_attempts
        (id,delivery_id,subscription_id,attempt,status,response_status,error_code,latency_ms,started_at,finished_at,nonce,request_timestamp,key_id,idempotency_key,response_body_hash,retry_after_ms,error_class)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()-($9::text||' milliseconds')::interval,now(),$10,$11,$12,$13,$14,$15,$16)`,
      [crypto.randomUUID(),delivery.id,delivery.subscription_id,delivery.attempts,next,statusCode,options.error?.code || null,options.latencyMs || 0,options.latencyMs || 0,
        options.nonce || null,options.timestamp || null,delivery.key_id,delivery.idempotency_key || delivery.id,responseBodyHash,options.retryAfterMs || null,options.error?.name || null]);

      let circuitState = 'CLOSED';
      if (next === 'SUCCEEDED') {
        await c.query(`UPDATE forge_event_subscriptions SET circuit_state='CLOSED',circuit_failures=0,circuit_opened_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2`, [delivery.subscription_id,delivery.tenant_id]);
      } else if (next !== 'CANCELLED') {
        const s = (await c.query(`SELECT circuit_failures,circuit_failure_threshold,circuit_cooldown_seconds,circuit_state FROM forge_event_subscriptions WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [delivery.subscription_id,delivery.tenant_id])).rows[0];
        const failures = Number(s?.circuit_failures || 0) + 1;
        circuitState = failures >= Number(s?.circuit_failure_threshold || this.config.circuitFailureThreshold) ? 'OPEN' : (s?.circuit_state === 'HALF_OPEN' ? 'HALF_OPEN' : 'CLOSED');
        await c.query(`UPDATE forge_event_subscriptions SET circuit_failures=$2,circuit_state=$3,circuit_opened_until=CASE WHEN $3='OPEN' THEN now()+($4::text||' seconds')::interval ELSE circuit_opened_until END,updated_at=now() WHERE id=$1 AND tenant_id=$5`,
          [delivery.subscription_id,failures,circuitState,Number(s?.circuit_cooldown_seconds || this.config.circuitCooldownSeconds),delivery.tenant_id]);
      }

      const fenced = await c.query(`UPDATE forge_event_deliveries SET status=$2,available_at=$3,last_error=$4,last_response_status=$5,lease_token=NULL,lease_until=NULL,worker_id=NULL,
        updated_at=now(),completed_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED','DEAD_LETTER','CANCELLED') THEN now() ELSE completed_at END
        WHERE id=$1 AND status='IN_FLIGHT' AND lease_token=$6 AND lease_until>now() RETURNING id`,
      [delivery.id,next,next==='RETRY'?availableAt:new Date(),options.error?.message?.slice(0,500) || null,statusCode,delivery.lease_token]);
      if (!fenced.rows[0]) {
        await c.query('ROLLBACK');
        return { status: 'FENCED', latencyMs: options.latencyMs || 0, responseStatus: statusCode, circuitState: 'UNCHANGED' };
      }

      if (next === 'SUCCEEDED' && delivery.replay_of == null) {
        await c.query(`INSERT INTO forge_event_consumer_cursors(subscription_id,tenant_id,ordering_key,last_acked_sequence,last_event_id,updated_at)
          VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(subscription_id,ordering_key) DO UPDATE SET
          last_acked_sequence=GREATEST(forge_event_consumer_cursors.last_acked_sequence,EXCLUDED.last_acked_sequence),
          last_event_id=CASE WHEN EXCLUDED.last_acked_sequence>=forge_event_consumer_cursors.last_acked_sequence THEN EXCLUDED.last_event_id ELSE forge_event_consumer_cursors.last_event_id END,
          updated_at=now()`, [delivery.subscription_id,delivery.tenant_id,delivery.ordering_key,delivery.ordering_sequence,delivery.event_id]);
        await c.query(`UPDATE forge_event_deliveries SET acked_at=now(),acked_by=$2 WHERE id=$1 AND status='SUCCEEDED'`, [delivery.id,delivery.worker_id || current.worker_id || 'event-worker']);
      }
      if (next === 'DEAD_LETTER') await c.query(`INSERT INTO forge_event_dlq(delivery_id,reason,quarantined_at) VALUES($1,$2,now()) ON CONFLICT(delivery_id) DO UPDATE SET reason=EXCLUDED.reason,quarantined_at=now()`, [delivery.id,options.error?.message || `HTTP ${statusCode || 0}`]);
      await c.query('COMMIT');
      return { status: next, latencyMs: options.latencyMs || 0, responseStatus: statusCode, circuitState };
    } catch (error) {
      await c.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      c.release();
    }
  }
}

module.exports = { FencedOutboundWebhookReliability };
