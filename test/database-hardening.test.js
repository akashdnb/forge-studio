const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EPISODE_PAGE_SQL,
  JOB_PAGE_SQL,
  JOB_CLAIM_SQL,
  RETENTION_PAGE_SQL,
  assertBoundedQueryShape,
} = require('../src/persistence/query-shapes');
const { withRetryableTransaction } = require('../src/persistence/transaction-runner');

test('critical read and cleanup query shapes are bounded and keyset paginated', () => {
  for (const sql of [EPISODE_PAGE_SQL, JOB_PAGE_SQL, JOB_CLAIM_SQL, RETENTION_PAGE_SQL]) {
    assert.equal(assertBoundedQueryShape(sql), true);
    assert.match(sql, /LIMIT \$\d+/i);
  }
  assert.doesNotMatch(EPISODE_PAGE_SQL, /OFFSET/i);
  assert.doesNotMatch(JOB_PAGE_SQL, /OFFSET/i);
  assert.match(JOB_CLAIM_SQL, /FOR UPDATE\s+SKIP LOCKED/i);
});

test('query-shape guard rejects unbounded scans', () => {
  assert.throws(() => assertBoundedQueryShape('SELECT * FROM usage_events ORDER BY created_at'), /LIMIT/);
  assert.throws(() => assertBoundedQueryShape('SELECT * FROM episodes LIMIT $1 OFFSET $2'), /OFFSET/);
});

test('transaction runner retries serialization failures and deadlocks', async () => {
  let connectCount = 0;
  const calls = [];
  const pool = {
    async connect() {
      connectCount += 1;
      let failed = false;
      return {
        async query(sql) {
          calls.push(sql);
          if (sql === 'COMMIT' && !failed) {
            failed = true;
            const error = new Error('deadlock');
            error.code = '40P01';
            throw error;
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const result = await withRetryableTransaction(pool, async (_client, attempt) => `ok-${attempt}`, { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 });
  assert.equal(result, 'ok-1');
  assert.equal(connectCount, 2);
  assert.equal(calls.filter((sql) => sql === 'BEGIN ISOLATION LEVEL READ COMMITTED').length, 2);
  assert.equal(calls.filter((sql) => sql === 'ROLLBACK').length, 1);
});

test('transaction runner does not retry non-retryable errors', async () => {
  let connects = 0;
  const pool = {
    async connect() {
      connects += 1;
      return {
        async query(sql) {
          if (sql.startsWith('BEGIN')) return { rows: [] };
          if (sql === 'ROLLBACK') return { rows: [] };
          throw Object.assign(new Error('constraint violation'), { code: '23505' });
        },
        release() {},
      };
    },
  };
  await assert.rejects(() => withRetryableTransaction(pool, async () => { throw Object.assign(new Error('constraint violation'), { code: '23505' }); }), /constraint violation/);
  assert.equal(connects, 1);
});
