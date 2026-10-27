'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { TenantResourceFairness } = require('../src/fairness/tenant-resource-fairness');

const databaseUrl = process.env.FORGE_TEST_DATABASE_URL || process.env.DATABASE_URL;

test('tenant resource reservation is atomic and idempotent across concurrent workers', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    const job = (await pool.query(`SELECT id,tenant_id,project_id,kind,attempts FROM forge_jobs WHERE status='QUEUED' AND tenant_id IS NOT NULL LIMIT 1`)).rows[0];
    if (!job) return;
    const service = new TenantResourceFairness({ pool });
    const attempt = Number(job.attempts || 0) + 1;
    const candidate = { ...job, attempts: attempt };
    const [a,b] = await Promise.all([service.claim({ job: candidate, workerId: 'fairness-test-a' }), service.claim({ job: candidate, workerId: 'fairness-test-b' })]);
    assert.equal(a.reservation_id, b.reservation_id);
    const count = Number((await pool.query(`SELECT count(*)::int n FROM forge_resource_reservations WHERE job_id=$1 AND attempt=$2`, [job.id, attempt])).rows[0].n);
    assert.equal(count, 1);
    await service.release(job.id, attempt, { reason: 'postgres-concurrency-test' });
    assert.equal((await pool.query(`SELECT status FROM forge_resource_reservations WHERE job_id=$1 AND attempt=$2`, [job.id, attempt])).rows[0].status, 'RELEASED');
  } finally { await pool.end(); }
});

test('tenant/project policy is isolated in PostgreSQL', { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const rows = (await pool.query(`SELECT t.id tenant_id,p.id project_id FROM tenants t LEFT JOIN projects p ON p.tenant_id=t.id ORDER BY t.id LIMIT 2`)).rows;
    if (rows.length < 2 || !rows[0].project_id || !rows[1].project_id) return;
    const [a,b] = rows;
    assert.notEqual(a.tenant_id, b.tenant_id);
    const cross = await pool.query(`SELECT count(*)::int n FROM forge_resource_policies WHERE tenant_id=$1 AND project_id=$2`, [a.tenant_id, b.project_id]);
    assert.equal(Number(cross.rows[0].n), 0);
  } finally { await pool.end(); }
});
