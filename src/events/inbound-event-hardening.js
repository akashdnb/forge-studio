const crypto = require('node:crypto');

const PERMANENT_REJECTION_CODES = new Set([
  'INVALID_TIMESTAMP', 'STALE_TIMESTAMP', 'INVALID_NONCE', 'INVALID_SIGNATURE',
  'REPLAY_DETECTED', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'INVALID_EVENT_ID',
  'INVALID_SCHEMA', 'INVALID_JSON', 'EVENT_NOT_ALLOWED', 'CONFLICTING_EVENT_IDENTITY',
  'NOT_FOUND', 'TENANT_MISMATCH', 'FORBIDDEN'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeJson(body) {
  try {
    const value = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function boundedText(value, max = 512) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, max);
}

function retentionUntil(now, days) {
  const parsed = Number(days);
  const safeDays = Number.isFinite(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : 90;
  return new Date(now + safeDays * 86400000);
}

function installInboundEventHardening({ InboundWebhookService, poolResolver = null, logger = console } = {}) {
  if (!InboundWebhookService?.prototype) throw new TypeError('InboundWebhookService is required');
  if (InboundWebhookService.prototype.__eventHardeningInstalled) return;
  InboundWebhookService.prototype.__eventHardeningInstalled = true;

  const originalIngest = InboundWebhookService.prototype.ingest;
  InboundWebhookService.prototype.ingest = async function hardenedIngest(args) {
    const pool = this.pool;
    const now = this.now?.() ?? Date.now();
    const body = typeof args.body === 'string' ? args.body : '';
    const payloadHash = sha256(body);
    const payload = safeJson(body);
    let endpoint = null;
    try {
      endpoint = (await pool.query(
        `SELECT id,tenant_id,project_id,name,replay_window_seconds FROM forge_inbound_webhook_endpoints WHERE id=$1 AND active`,
        [args.endpointId]
      )).rows[0] || null;
    } catch (error) {
      logger.error?.(JSON.stringify({ component: 'inbound-event-hardening', stage: 'endpoint_lookup', message: error.message }));
      throw error;
    }

    const route = args.eventType || 'unknown';
    const sourceIdentity = `webhook:${args.endpointId}`;
    const providerIdentity = boundedText(endpoint?.name, 256);
    const deduplicationKey = `${args.endpointId}:${boundedText(args.externalEventId, 256) || 'missing'}:${payloadHash}`;
    const correlationId = boundedText(payload.correlationId || payload.correlation_id || args.correlationId);
    const causationId = boundedText(payload.causationId || payload.causation_id || args.causationId);
    const signatureFingerprint = args.signature ? sha256(String(args.signature).replace(/^v1=/, '')) : null;
    const metadata = {
      method: boundedText(args.method, 16),
      path: boundedText(args.path, 1024),
      contentType: boundedText(args.contentType, 128),
      eventId: boundedText(args.externalEventId, 256),
      receivedUnixSeconds: Number(args.timestamp) || null
    };
    const retention = retentionUntil(now, process.env.FORGE_INBOUND_RETENTION_DAYS);
    let intakeId = null;

    if (endpoint) {
      const inserted = await pool.query(`
        INSERT INTO forge_event_intake(
          endpoint_id,tenant_id,project_id,source_identity,provider_identity,schema_name,schema_version,
          received_at,observed_at,signature_algorithm,signature_fingerprint,verification_state,nonce,nonce_state,
          correlation_id,causation_id,payload_hash,deduplication_key,processing_state,retention_until,metadata
        ) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0),to_timestamp($8/1000.0),$9,$10,'PENDING',$11,'NOT_PRESENT',$12,$13,$14,$15,'RECEIVED',$16,$17::jsonb)
        ON CONFLICT(endpoint_id,deduplication_key) DO UPDATE SET
          observed_at=EXCLUDED.observed_at,last_observed_at=EXCLUDED.observed_at,duplicate_count=forge_event_intake.duplicate_count+1
        RETURNING intake_id,processing_state,duplicate_count
      `, [
        endpoint.id, endpoint.tenant_id, endpoint.project_id, sourceIdentity, providerIdentity,
        route, Number(args.version) || 1, now, 'hmac-sha256', signatureFingerprint, boundedText(args.nonce, 256),
        correlationId, causationId, payloadHash, deduplicationKey, retention, JSON.stringify(metadata)
      ]);
      intakeId = inserted.rows[0]?.intake_id || null;
    }

    try {
      const result = await originalIngest.call(this, args);
      const state = result.status === 'DUPLICATE' ? 'DUPLICATE' : 'ACCEPTED';
      if (intakeId) {
        await pool.query(`UPDATE forge_event_intake SET event_id=COALESCE(event_id,$2),verification_state='VERIFIED',nonce_state=CASE WHEN $3 IS NULL THEN 'NOT_PRESENT' ELSE 'ACCEPTED' END,processing_state=$1,last_observed_at=now() WHERE intake_id=$4`, [state, result.eventId || null, args.nonce || null, intakeId]);
      }
      return result;
    } catch (error) {
      const code = error.code || 'REQUEST_FAILURE';
      const rejection = PERMANENT_REJECTION_CODES.has(code);
      if (intakeId) {
        await pool.query(`UPDATE forge_event_intake SET verification_state=$1,nonce_state=$2,processing_state=$3,quarantine_reason=$4,last_error=$5,last_observed_at=now() WHERE intake_id=$6`, [
          code === 'INVALID_SIGNATURE' || code === 'STALE_TIMESTAMP' ? 'REJECTED' : 'REJECTED',
          code === 'REPLAY_DETECTED' ? 'DUPLICATE' : (args.nonce ? 'REJECTED' : 'NOT_PRESENT'),
          rejection ? 'REJECTED' : 'RECEIVED',
          rejection ? code : null,
          boundedText(error.message, 1024), intakeId
        ]);
      }
      throw error;
    }
  };

  const originalQuarantine = InboundWebhookService.prototype.quarantine;
  InboundWebhookService.prototype.quarantine = async function hardenedQuarantine(eventId, routeKind, reason) {
    const result = await originalQuarantine.call(this, eventId, routeKind, reason);
    await this.pool.query(`UPDATE forge_event_intake SET event_id=$2,processing_state='QUARANTINED',quarantine_reason=$3,last_error=$3,attempt_count=attempt_count+1,last_observed_at=now() WHERE event_id=$1`, [eventId, eventId, boundedText(reason, 1024)]);
    return result;
  };

  const originalMarkEffect = InboundWebhookService.prototype.markEffect;
  InboundWebhookService.prototype.markEffect = async function hardenedMarkEffect(eventId, routeKind, status, error = null) {
    const result = await originalMarkEffect.call(this, eventId, routeKind, status, error);
    const state = status === 'SUCCEEDED' ? 'PROCESSED' : status === 'DEAD_LETTER' ? 'QUARANTINED' : status === 'PROCESSING' ? 'PROCESSING' : 'RECEIVED';
    await this.pool.query(`UPDATE forge_event_intake SET processing_state=$2,attempt_count=attempt_count+1,last_error=$3,last_observed_at=now() WHERE event_id=$1`, [eventId, state, boundedText(error?.message, 1024)]);
    return result;
  };

  InboundWebhookService.prototype.claimReplay = async function claimReplay({ eventId, routeKind, operatorId, reason = 'operator replay' } = {}) {
    if (!eventId || !routeKind || !operatorId) throw Object.assign(new Error('eventId, routeKind and operatorId are required'), { code: 'INVALID_REPLAY_REQUEST', statusCode: 400 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const event = (await client.query(`SELECT id,tenant_id FROM forge_inbound_events WHERE id=$1 FOR UPDATE`, [eventId])).rows[0];
      if (!event) throw Object.assign(new Error('Event not found'), { code: 'NOT_FOUND', statusCode: 404 });
      const effect = (await client.query(`SELECT status FROM forge_inbound_event_effects WHERE event_id=$1 AND route_kind=$2 FOR UPDATE`, [eventId, routeKind])).rows[0];
      if (!effect) throw Object.assign(new Error('Replay route not found'), { code: 'NOT_FOUND', statusCode: 404 });
      const active = (await client.query(`SELECT 1 FROM forge_event_replay_claims WHERE event_id=$1 AND route_kind=$2 AND state='CLAIMED'`, [eventId, routeKind])).rows[0];
      if (active) throw Object.assign(new Error('Replay already in progress'), { code: 'REPLAY_BUSY', statusCode: 409 });
      const epoch = Number((await client.query(`SELECT COALESCE(MAX(claim_epoch),0)+1 AS next_epoch FROM forge_event_replay_claims WHERE event_id=$1 AND route_kind=$2`, [eventId, routeKind])).rows[0].next_epoch);
      await client.query(`INSERT INTO forge_event_replay_claims(event_id,route_kind,claim_epoch,operator_id,reason) VALUES($1,$2,$3,$4,$5)`, [eventId, routeKind, epoch, operatorId, boundedText(reason, 1024)]);
      await client.query(`UPDATE forge_event_intake SET processing_state='REPLAYING',last_error=NULL,last_observed_at=now() WHERE event_id=$1`, [eventId]);
      await client.query('COMMIT');
      return { eventId, routeKind, claimEpoch: epoch, tenantId: event.tenant_id };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  };

  InboundWebhookService.prototype.releaseReplay = async function releaseReplay({ eventId, routeKind, claimEpoch, completed = false } = {}) {
    await this.pool.query(`UPDATE forge_event_replay_claims SET state=$4,released_at=CASE WHEN $4='RELEASED' THEN now() ELSE released_at END,completed_at=CASE WHEN $4='COMPLETED' THEN now() ELSE completed_at END WHERE event_id=$1 AND route_kind=$2 AND claim_epoch=$3 AND state='CLAIMED'`, [eventId, routeKind, claimEpoch, completed ? 'COMPLETED' : 'RELEASED']);
    await this.pool.query(`UPDATE forge_event_intake SET processing_state=CASE WHEN $4='COMPLETED' THEN 'ACCEPTED' ELSE 'REPLAY_PENDING' END,last_observed_at=now() WHERE event_id=$1`, [eventId, routeKind, claimEpoch, completed ? 'COMPLETED' : 'RELEASED']);
  };
}

module.exports = { installInboundEventHardening, sha256, safeJson, retentionUntil };
