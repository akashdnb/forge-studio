const crypto = require('node:crypto');
const { DurableEventDelivery, computeBackoff, deterministicDeliveryId } = require('./durable-delivery');

class TransactionalOutboxDelivery extends DurableEventDelivery {
  constructor(options = {}) {
    super(options);
    this.config = { maxOutboxAttempts: 12, ...this.config };
  }

  async publish({ client = this.pool, tenantId, projectId, episodeId = null, type, payload, aggregateType = 'event', aggregateId = null, runId = null, workflowVersionId = null, causationId = null, correlationId = null }) {
    if (!tenantId || !projectId || !type) throw new TypeError('tenantId, projectId and type are required');
    const schema = require('./durable-delivery').EVENT_SCHEMAS[type];
    if (!schema) throw new TypeError(`Unknown event type: ${type}`);
    const body = { ...payload };
    for (const key of schema.required) if (body[key] === undefined || body[key] === null) throw new TypeError(`Event payload missing ${key}`);
    const result = await client.query(
      `SELECT forge_capture_event($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) AS id`,
      [type, projectId, episodeId, aggregateType, aggregateId || crypto.randomUUID(), JSON.stringify(body), runId, workflowVersionId, causationId, correlationId],
    );
    const event = (await client.query('SELECT * FROM forge_events WHERE id=$1', [result.rows[0].id])).rows[0];
    if (!event || event.tenant_id !== tenantId) throw Object.assign(new Error('event tenant mismatch'), { code: 'TENANT_MISMATCH' });
    return event;
  }

  async fanout(limit = 100, workerId = `outbox:${crypto.randomUUID()}`) {
    const claim = await this.pool.connect();
    let rows;
    try {
      await claim.query('BEGIN');
      rows = (await claim.query(`
        SELECT * FROM forge_outbox
        WHERE published_at IS NULL AND dead_letter_at IS NULL AND available_at <= now()
          AND (lease_until IS NULL OR lease_until < now())
        ORDER BY ordering_key NULLS LAST, ordering_sequence NULLS LAST, id
        FOR UPDATE SKIP LOCKED LIMIT $1`, [limit])).rows;
      for (const row of rows) {
        const token = crypto.randomUUID();
        await claim.query(`UPDATE forge_outbox SET lease_token=$2,lease_until=now()+($3::text||' seconds')::interval,worker_id=$4,attempts=attempts+1 WHERE id=$1`, [row.id, token, this.config.leaseSeconds, workerId]);
        row.lease_token = token;
        row.attempts += 1;
      }
      await claim.query('COMMIT');
    } catch (error) {
      try { await claim.query('ROLLBACK'); } catch {}
      throw error;
    } finally { claim.release(); }

    for (const row of rows) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const eventId = row.event_id || row.payload?.eventId;
        if (!eventId) throw Object.assign(new Error('outbox eventId missing'), { code: 'OUTBOX_CORRUPT' });
        const event = (await client.query('SELECT * FROM forge_events WHERE id=$1 FOR SHARE', [eventId])).rows[0];
        if (!event) throw Object.assign(new Error('event missing'), { code: 'EVENT_MISSING' });
        const subscriptions = (await client.query(`
          SELECT * FROM forge_event_subscriptions
          WHERE active AND tenant_id=$1 AND (project_id IS NULL OR project_id=$2)
            AND (cardinality(event_types)=0 OR $3=ANY(event_types))`, [event.tenant_id, event.project_id, event.type])).rows;
        for (const subscription of subscriptions) {
          const id = deterministicDeliveryId(event.id, subscription.id);
          await client.query(`
            INSERT INTO forge_event_deliveries(id,event_id,subscription_id,tenant_id,project_id,sequence_no,ordering_key,ordering_sequence,status,available_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',now()) ON CONFLICT (id) DO NOTHING`,
          [id, event.id, subscription.id, event.tenant_id, event.project_id, event.sequence_no, event.ordering_key, event.aggregate_sequence]);
        }
        const fenced = await client.query(`UPDATE forge_outbox SET published_at=now(),last_error=NULL,last_error_code=NULL,lease_token=NULL,lease_until=NULL,worker_id=NULL WHERE id=$1 AND lease_token=$2 AND published_at IS NULL RETURNING id`, [row.id, row.lease_token]);
        if (!fenced.rows[0]) throw Object.assign(new Error('outbox fencing token lost'), { code: 'OUTBOX_FENCED' });
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        const terminal = row.attempts >= this.config.maxOutboxAttempts;
        await this.pool.query(`
          UPDATE forge_outbox SET last_error=$2,last_error_code=$3,
            available_at=CASE WHEN $5 THEN now() ELSE now()+($4::text||' milliseconds')::interval END,
            lease_token=NULL,lease_until=NULL,worker_id=NULL,
            dead_letter_at=CASE WHEN $5 THEN now() ELSE dead_letter_at END,
            quarantine_reason=CASE WHEN $5 THEN $2 ELSE quarantine_reason END
          WHERE id=$1 AND lease_token=$6`,
        [row.id, error.message.slice(0, 500), error.code || 'OUTBOX_FAILURE', computeBackoff(row.attempts, this.config), terminal, row.lease_token]);
      } finally { client.release(); }
    }
    return rows.length;
  }

  async claim({ workerId, limit = 10 } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = (await client.query(`
        SELECT d.*,s.endpoint_url,s.secret_ciphertext,s.event_types,s.ordered,s.rate_limit_per_second,s.max_concurrency,
               e.type,e.version,e.payload,e.redacted_payload,e.created_at,e.sequence_no,e.ordering_key,e.aggregate_sequence,
               e.schema_name,e.schema_version,e.causation_id,e.correlation_id
        FROM forge_event_deliveries d
        JOIN forge_event_subscriptions s ON s.id=d.subscription_id
        JOIN forge_events e ON e.id=d.event_id
        LEFT JOIN forge_event_consumer_cursors cursor ON cursor.subscription_id=d.subscription_id AND cursor.ordering_key=d.ordering_key
        WHERE d.status IN ('PENDING','RETRY') AND d.available_at <= now() AND s.active
          AND (cursor.last_acked_sequence IS NULL OR d.ordering_sequence > cursor.last_acked_sequence)
          AND (NOT s.ordered OR NOT EXISTS (
            SELECT 1 FROM forge_event_deliveries prior
            WHERE prior.subscription_id=d.subscription_id AND prior.ordering_key=d.ordering_key
              AND prior.ordering_sequence < d.ordering_sequence
              AND prior.status NOT IN ('SUCCEEDED','CANCELLED','DEAD_LETTER')
          ))
          AND (SELECT count(*) FROM forge_event_deliveries active WHERE active.subscription_id=d.subscription_id AND active.status='IN_FLIGHT' AND active.lease_until > now()) < s.max_concurrency
          AND (SELECT count(*) FROM forge_event_delivery_attempts a WHERE a.subscription_id=d.subscription_id AND a.started_at > now()-interval '1 second') < s.rate_limit_per_second
        ORDER BY d.ordering_key,d.ordering_sequence,d.created_at
        FOR UPDATE OF d SKIP LOCKED LIMIT $1`, [limit])).rows;
      const claimed = [];
      for (const row of rows) {
        const token = crypto.randomUUID();
        const updated = await client.query(`UPDATE forge_event_deliveries SET status='IN_FLIGHT',lease_token=$2,lease_until=now()+($3::text||' seconds')::interval,worker_id=$4,attempts=attempts+1,updated_at=now() WHERE id=$1 AND status IN ('PENDING','RETRY') AND (lease_until IS NULL OR lease_until < now()) RETURNING *`, [row.id, token, this.config.leaseSeconds, workerId]);
        if (updated.rows[0]) claimed.push({ ...row, ...updated.rows[0] });
      }
      await client.query('COMMIT');
      return claimed;
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
  }

  async finishDelivery(delivery, options) {
    const result = await super.finishDelivery(delivery, options);
    if (result.status === 'SUCCEEDED') {
      await this.pool.query(`
        INSERT INTO forge_event_consumer_cursors(subscription_id,tenant_id,ordering_key,last_acked_sequence,last_event_id,updated_at)
        VALUES($1,$2,$3,$4,$5,now())
        ON CONFLICT(subscription_id,ordering_key) DO UPDATE
          SET last_acked_sequence=GREATEST(forge_event_consumer_cursors.last_acked_sequence,EXCLUDED.last_acked_sequence),
              last_event_id=CASE WHEN EXCLUDED.last_acked_sequence >= forge_event_consumer_cursors.last_acked_sequence THEN EXCLUDED.last_event_id ELSE forge_event_consumer_cursors.last_event_id END,
              updated_at=now()`,
      [delivery.subscription_id, delivery.tenant_id, delivery.ordering_key, delivery.ordering_sequence, delivery.event_id]);
      await this.pool.query(`UPDATE forge_event_deliveries SET acked_at=now(),acked_by=$2 WHERE id=$1 AND status='SUCCEEDED'`, [delivery.id, delivery.worker_id || 'event-worker']);
    }
    return result;
  }

  async diagnostics({ tenantId = null, orderingKey = null } = {}) {
    const args = []; const clauses = [];
    if (tenantId) { args.push(tenantId); clauses.push(`e.tenant_id=$${args.length}`); }
    if (orderingKey) { args.push(orderingKey); clauses.push(`e.ordering_key=$${args.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(`
      SELECT e.id,e.type,e.tenant_id,e.project_id,e.ordering_key,e.aggregate_sequence,e.schema_version,e.created_at,
             o.published_at,o.attempts AS outbox_attempts,o.dead_letter_at,
             count(d.id)::int AS deliveries,
             count(*) FILTER (WHERE d.status='IN_FLIGHT')::int AS in_flight,
             count(*) FILTER (WHERE d.status='RETRY')::int AS retrying,
             count(*) FILTER (WHERE d.status='DEAD_LETTER')::int AS dead_letter
      FROM forge_events e
      LEFT JOIN forge_outbox o ON o.event_id=e.id
      LEFT JOIN forge_event_deliveries d ON d.event_id=e.id
      ${where}
      GROUP BY e.id,o.id ORDER BY e.created_at DESC LIMIT 200`, args);
    return result.rows;
  }
}

module.exports = { TransactionalOutboxDelivery };
