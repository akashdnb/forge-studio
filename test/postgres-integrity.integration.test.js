const test = require('node:test');
const assert = require('node:assert/strict');
const DATABASE_URL = process.env.DATABASE_URL;

test('database ownership constraints reject cross-project jobs', { skip: !DATABASE_URL }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO projects (id,name,created_by) VALUES ($1,$2,$3),($4,$5,$6)', [`db-hardening-p1-${suffix}`, 'hardening-p1', 'test', `db-hardening-p2-${suffix}`, 'hardening-p2', 'test']);
    await client.query('INSERT INTO episodes (id,project_id,title,created_by) VALUES ($1,$2,$3,$4)', [`db-hardening-e-${suffix}`, `db-hardening-p1-${suffix}`, 'hardening', 'test']);
    await assert.rejects(
      client.query('INSERT INTO forge_jobs (id,project_id,episode_id,kind,idempotency_key,created_by) VALUES ($1,$2,$3,$4,$5,$6)', [`db-hardening-j-${suffix}`, `db-hardening-p2-${suffix}`, `db-hardening-e-${suffix}`, 'hardening', `db-hardening-k-${suffix}`, 'test']),
      /job project must match episode project|ownership mismatch/i,
    );
    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
});
