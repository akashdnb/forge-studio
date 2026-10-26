class Outbox {
  constructor({ pool }) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('A pg-compatible pool is required');
    this.pool = pool;
  }

  async append({ topic, aggregateType, aggregateId, payload = {} }, client = this.pool) {
    const result = await client.query(
      `INSERT INTO forge_outbox (topic, aggregate_type, aggregate_id, payload)
       VALUES ($1,$2,$3,$4::jsonb) RETURNING *`,
      [topic, aggregateType, aggregateId, JSON.stringify(payload)],
    );
    return result.rows[0];
  }

  async claim({ limit = 25 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be between 1 and 200');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT * FROM forge_outbox
         WHERE published_at IS NULL AND available_at <= now()
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [limit],
      );
      if (result.rows.length) {
        await client.query('UPDATE forge_outbox SET attempts=attempts+1 WHERE id = ANY($1::bigint[])', [result.rows.map((row) => row.id)]);
      }
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async markPublished(id) {
    const result = await this.pool.query('UPDATE forge_outbox SET published_at=now() WHERE id=$1 AND published_at IS NULL RETURNING *', [id]);
    return result.rows[0] || null;
  }

  async markFailed(id, error, delaySeconds = 30) {
    const result = await this.pool.query(
      `UPDATE forge_outbox SET last_error=$2, available_at=now()+($1::text || ' seconds')::interval WHERE id=$3 AND published_at IS NULL RETURNING *`,
      [Math.max(1, delaySeconds), error?.message || String(error), id],
    );
    return result.rows[0] || null;
  }
}

module.exports = { Outbox };
