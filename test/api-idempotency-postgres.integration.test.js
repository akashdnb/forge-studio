const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { withIdempotencyTransaction } = require('../src/persistence/api-idempotency');

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
let pool;

async function migrate() {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const sql = await fs.readFile(path.join(__dirname, '..', 'migrations', '111_api_idempotency_replay_safety.sql'), 'utf8');
  await pool.query(sql);
}

test('PostgreSQL idempotency registry serializes concurrent identical requests', { skip }, async () => {
  await migrate();
  const key = `pg-concurrency-${Date.now()}`;
  const context = { tenantId: `tenant-${Date.now()}`, operation: 'test.concurrent', idempotencyKey: key, requestHash: 'a'.repeat(64), actor: 'test', requestId: 'req-1' };
  let executions = 0;
  const work = async () => withIdempotencyTransaction(pool, context, async (client) => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
    await client.query('SELECT 1');
    return { accepted: true, execution: executions };
  });
  const [first, second] = await Promise.all([work(), work()]);
  assert.deepEqual(first, second);
  assert.equal(executions, 1);
  const row = (await pool.query('SELECT status,response_body FROM forge_api_idempotency_keys WHERE idempotency_key=$1', [key])).rows[0];
  assert.equal(row.status, 'COMMITTED');
  assert.deepEqual(row.response_body, first);
  await pool.query('DELETE FROM forge_api_idempotency_events WHERE idempotency_key=$1', [key]);
  await pool.query('DELETE FROM forge_api_idempotency_keys WHERE idempotency_key=$1', [key]);
  await pool.end();
  pool = null;
});

test('PostgreSQL mismatched reuse fails closed and failed transaction leaves no committed outcome', { skip }, async () => {
  if (!pool) await migrate();
  const tenant = `tenant-failure-${Date.now()}`;
  const key = `pg-failure-${Date.now()}`;
  const base = { tenantId: tenant, operation: 'test.failure', idempotencyKey: key, requestHash: 'b'.repeat(64), actor: 'test', requestId: 'req-fail' };
  await assert.rejects(() => withIdempotencyTransaction(pool, base, async () => { throw new Error('synthetic crash before commit'); }), /synthetic crash/);
  const count = await pool.query('SELECT count(*)::int AS count FROM forge_api_idempotency_keys WHERE idempotency_key=$1', [key]);
  assert.equal(count.rows[0].count, 0);
  await assert.rejects(() => withIdempotencyTransaction(pool, { ...base, requestHash: 'c'.repeat(64) }, async () => ({ ok: true })), /different request fingerprint/);
  const success = await withIdempotencyTransaction(pool, base, async () => ({ ok: true, committed: true }));
  assert.deepEqual(success, { ok: true, committed: true });
  await pool.query('DELETE FROM forge_api_idempotency_events WHERE idempotency_key=$1', [key]);
  await pool.query('DELETE FROM forge_api_idempotency_keys WHERE idempotency_key=$1', [key]);
  await pool.end();
  pool = null;
});
