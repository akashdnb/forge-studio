const test = require('node:test');
const assert = require('node:assert/strict');
let Pool; try { ({ Pool } = require('pg')); } catch { Pool = null; }
const { CostGovernanceService, categoryForJob, unitsFor } = require('../src/cost/cost-governance');
const { PersistentProductionRepository } = require('../src/persistence/production-repository');
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const maybe = Pool && databaseUrl ? test : test.skip;

test('cost unit attribution is deterministic', () => {
  assert.equal(categoryForJob('publish:youtube', {}), 'publishing');
  assert.equal(categoryForJob('workflow:render', {}), 'media');
  assert.equal(categoryForJob('forge-runner:package', {}), 'runner');
  assert.equal(categoryForJob('workflow:artifact-storage', {}), 'storage');
  assert.equal(unitsFor('second', { durationMs: 2500 }), 2.5);
  assert.equal(unitsFor('cpu_ms', { cpuMs: 1234 }), 1234);
  assert.equal(unitsFor('byte', { inputBytes: 10, outputBytes: 90 }), 100);
});

maybe('parallel reservations cannot overspend one tenant/project budget', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const repo = new PersistentProductionRepository({ pool });
  await repo.migrate();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `cost-tenant-${suffix}`;
  const projectId = `cost-project-${suffix}`;
  const episodeId = `cost-episode-${suffix}`;
  await pool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [tenantId, 'Cost test tenant', 'test']);
  await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4)', [projectId, 'Cost test project', 'test', tenantId]);
  await pool.query('INSERT INTO episodes(id,project_id,title,created_by) VALUES($1,$2,$3,$4)', [episodeId, projectId, 'Cost test episode', 'test']);
  await pool.query(`INSERT INTO forge_jobs(id,project_id,episode_id,kind,payload,priority,idempotency_key,created_by) VALUES($1,$2,$3,'workflow:render','{}'::jsonb,10,$4,'test'),($5,$2,$3,'workflow:render','{}'::jsonb,100,$6,'test')`, [`cost-job-a-${suffix}`, projectId, episodeId, `cost-idem-a-${suffix}`, `cost-job-b-${suffix}`, `cost-idem-b-${suffix}`]);
  const cost = new CostGovernanceService({ pool, required: true });
  await cost.configureRate({ providerType: 'media', provider: 'workflow:render', operation: 'workflow:render', unitType: 'request', unitPrice: 1, currency: 'USD', normalizedCurrency: 'USD', version: `test-rate-${suffix}`, actor: 'test' });
  await cost.configureBudget({ scopeType: 'GLOBAL', scopeId: 'global', hardCostLimit: 1, currency: 'USD', actor: 'test', configVersion: `test-budget-${suffix}` });
  const jobs = (await pool.query('SELECT * FROM forge_jobs WHERE id IN ($1,$2) ORDER BY id', [`cost-job-a-${suffix}`, `cost-job-b-${suffix}`])).rows;
  const results = await Promise.allSettled(jobs.map((job) => cost.reserveForJob({ job })));
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.allowed).length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'COST_BUDGET_REJECTED').length, 1);
  await pool.end();
});

maybe('failure injection releases a held reservation and stale recovery expires abandoned reservations', async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 6 });
  const repo = new PersistentProductionRepository({ pool });
  await repo.migrate();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `recovery-tenant-${suffix}`;
  const projectId = `recovery-project-${suffix}`;
  await pool.query('INSERT INTO tenants(id,name,created_by) VALUES($1,$2,$3)', [tenantId, 'Recovery tenant', 'test']);
  await pool.query('INSERT INTO projects(id,name,created_by,tenant_id) VALUES($1,$2,$3,$4)', [projectId, 'Recovery project', 'test', tenantId]);
  await pool.query(`INSERT INTO forge_jobs(id,project_id,kind,payload,idempotency_key,created_by) VALUES($1,$2,'workflow:test','{}'::jsonb,$3,'test')`, [`recovery-job-${suffix}`, projectId, `recovery-idem-${suffix}`]);
  const cost = new CostGovernanceService({ pool, required: true, reservationTtlMs: 1000 });
  await cost.configureRate({ providerType: 'workflow', provider: 'workflow:test', operation: 'workflow:test', unitType: 'request', unitPrice: 1, version: `recovery-rate-${suffix}`, actor: 'test' });
  await cost.configureBudget({ scopeType: 'GLOBAL', scopeId: 'global', hardCostLimit: 10, currency: 'USD', actor: 'test', configVersion: `recovery-budget-${suffix}` });
  const job = (await pool.query('SELECT * FROM forge_jobs WHERE id=$1', [`recovery-job-${suffix}`])).rows[0];
  const held = await cost.reserveForJob({ job });
  await cost.release({ reservationId: held.reservation.id, reason: 'failure-injection' });
  assert.equal((await pool.query('SELECT status FROM cost_reservations WHERE id=$1', [held.reservation.id])).rows[0].status, 'RELEASED');
  const job2 = { ...job, id: `recovery-job-2-${suffix}`, idempotency_key: `recovery-idem-2-${suffix}` };
  await pool.query(`INSERT INTO forge_jobs(id,project_id,kind,payload,idempotency_key,created_by) VALUES($1,$2,'workflow:test','{}'::jsonb,$3,'test')`, [job2.id, projectId, job2.idempotency_key]);
  const held2 = await cost.reserveForJob({ job: job2 });
  await pool.query("UPDATE cost_reservations SET expires_at=now()-interval '1 second' WHERE id=$1", [held2.reservation.id]);
  const recovered = await cost.recoverStaleReservations({ limit: 10 });
  assert.equal(recovered.recovered, 1);
  assert.equal((await pool.query('SELECT status FROM cost_reservations WHERE id=$1', [held2.reservation.id])).rows[0].status, 'EXPIRED');
  await pool.end();
});
