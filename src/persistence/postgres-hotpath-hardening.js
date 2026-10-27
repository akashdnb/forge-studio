const { PostgresRepository } = require('./postgres-repository');
const { withRetryableTransaction } = require('./transaction-runner');

const MAX_PAGE_SIZE = 200;
const MAX_OFFSET = 5000;

function decodeEpisodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value.updatedAt || typeof value.id !== 'string') throw new Error('invalid');
    return value;
  } catch {
    throw new TypeError('cursor must be a valid episode page cursor');
  }
}

function encodeEpisodeCursor(row) {
  return row ? Buffer.from(JSON.stringify({ updatedAt: row.updated_at, id: row.id })).toString('base64url') : null;
}

function installPostgresHotpathHardening() {
  if (PostgresRepository.prototype.__forgeHotpathHardeningInstalled) return;
  PostgresRepository.prototype.__forgeHotpathHardeningInstalled = true;

  PostgresRepository.prototype.withTransaction = function hardenedWithTransaction(operation, options = {}) {
    return withRetryableTransaction(this.pool, operation, options);
  };

  PostgresRepository.prototype.listEpisodes = async function hardenedListEpisodes({ projectId, limit = 50, offset = 0, cursor = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new TypeError(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) throw new TypeError(`offset must be between 0 and ${MAX_OFFSET}`);
    const decoded = decodeEpisodeCursor(cursor);
    const values = [];
    const where = [];
    if (projectId) { values.push(projectId); where.push(`project_id=$${values.length}`); }
    if (decoded) {
      values.push(decoded.updatedAt, decoded.id);
      where.push(`(updated_at,id)<($${values.length - 1},$${values.length})`);
    }
    values.push(limit);
    const limitParam = values.length;
    let sql = `SELECT * FROM episodes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC,id DESC LIMIT $${limitParam}`;
    if (!decoded && offset > 0) {
      values.push(offset);
      sql = sql.replace(/LIMIT \$\d+$/, `LIMIT $${limitParam} OFFSET $${values.length}`);
    }
    const result = await this.pool.query(sql, values);
    const rows = result.rows;
    Object.defineProperty(rows, 'nextCursor', { value: encodeEpisodeCursor(rows[rows.length - 1]), enumerable: false });
    return rows;
  };
}

module.exports = { installPostgresHotpathHardening, encodeEpisodeCursor, decodeEpisodeCursor };
