const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

function isRetryableTransactionError(error) {
  return RETRYABLE_SQLSTATES.has(error?.code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a transaction with bounded retry for serialization failures and deadlocks.
 * The callback must be safe to execute more than once and must not perform
 * external side effects before commit. Jitter prevents synchronized workers
 * from repeatedly colliding on the same lock set.
 */
async function withRetryableTransaction(pool, operation, {
  isolationLevel = 'READ COMMITTED',
  maxRetries = 3,
  baseDelayMs = 20,
  maxDelayMs = 500,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg-compatible pool is required');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new TypeError('maxRetries must be between 0 and 5');
  const allowedIsolation = new Set(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']);
  if (!allowedIsolation.has(isolationLevel)) throw new TypeError('Unsupported transaction isolation level');

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      const result = await operation(client, attempt);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      if (!isRetryableTransactionError(error) || attempt === maxRetries) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 2)));
      await sleep(exponential + jitter);
    } finally {
      client.release();
    }
  }
  throw new Error('Transaction retry loop exhausted');
}

module.exports = { RETRYABLE_SQLSTATES, isRetryableTransactionError, withRetryableTransaction };
