const { randomUUID } = require('node:crypto');

class Outbox {
  constructor({ pool, leaseSeconds = 60, workerId = `outbox:${randomUUID()}` }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10) throw new TypeError('leaseSeconds must be >= 10');
    if (!workerId) throw new TypeError('workerId is required');
    this.pool = pool;
    this.leaseSeconds = leaseSeconds;
    this.workerId = workerId;
  }

  async append({ topic, aggregateType, aggregateId, payload = {} }, client = this.pool) {
    if (!topic || !aggregateType || !aggregateId) throw new TypeError('topic, aggregateType and aggregateId are required');
    const result = await client.query(
      `INSERT INTO forge_outbox (topic, aggregate_type, aggregate_id, payload)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [topic, aggregateType, aggregateId, JSON.stringify(payload)],
    );
    return result.rows[0];
  }

  async claim({ limit = 25, workerId = this.workerId } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be between 1 and 200');
    if (!workerId) throw new TypeError('workerId is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH candidates AS (
           SELECT id FROM forge_outbox
           WHERE published_at IS NULL
             AND available_at <= now()
             AND (claimed_until IS NULL OR claimed_until < now())
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE forge_outbox o
         SET attempts = o.attempts + 1,
             claimed_by = $2,
             claimed_until = now() + ($3::text || ' seconds')::interval
         FROM candidates c
         WHERE o.id = c.id
         RETURNING o.*`,
        [limit, workerId, this.leaseSeconds],
      );
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeat(id, workerId = this.workerId) {
    const result = await this.pool.query(
      `UPDATE forge_outbox
       SET claimed_until = now() + ($1::text || ' seconds')::interval
       WHERE id=$2 AND published_at IS NULL AND claimed_by=$3 AND claimed_until > now()
       RETURNING *`,
      [this.leaseSeconds, id, workerId],
    );
    return result.rows[0] || null;
  }

  async markPublished(id, workerId = this.workerId) {
    const result = await this.pool.query(
      `UPDATE forge_outbox SET published_at=now(), claimed_by=NULL, claimed_until=NULL
       WHERE id=$1 AND published_at IS NULL AND claimed_by=$2 RETURNING *`,
      [id, workerId],
    );
    return result.rows[0] || null;
  }

  async markFailed(id, error, delaySeconds = 30, workerId = this.workerId) {
    const result = await this.pool.query(
      `UPDATE forge_outbox
       SET last_error=$1, available_at=now()+($2::text || ' seconds')::interval,
           claimed_by=NULL, claimed_until=NULL
       WHERE id=$3 AND published_at IS NULL AND claimed_by=$4 RETURNING *`,
      [String(error?.message || error).slice(0, 4000), Math.max(1, delaySeconds), id, workerId],
    );
    return result.rows[0] || null;
  }
}

module.exports = { Outbox };
