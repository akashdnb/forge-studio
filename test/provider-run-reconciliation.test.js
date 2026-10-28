'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findStaleProviderRuns, reconcileStaleProviderRun } = require('../src/generation/provider-run-reconciliation');

function fakePool(run, artifacts = []) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT * FROM provider_runs WHERE id = $1 FOR UPDATE')) return { rows: run ? [run] : [] };
      if (sql.includes('SELECT id, version_id, content_hash, created_at')) return { rows: artifacts };
      if (sql.includes("UPDATE provider_runs SET status = 'FAILED'")) { run.status = 'FAILED'; run.error = JSON.parse(params[0]); run.finished_at = params[1]; return { rows: [run] }; }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM provider_runs WHERE status = 'RUNNING'")) return { rows: run ? [run] : [] };
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
    async connect() { return client; },
  };
}

test('stale provider runs are discoverable without replaying the provider', async () => {
  const now = new Date('2026-10-28T05:00:00.000Z');
  const run = { id: 'run-1', status: 'RUNNING', started_at: new Date('2026-10-28T04:00:00.000Z') };
  const pool = fakePool(run);
  const rows = await findStaleProviderRuns(pool, { now, staleAfterMs: 15 * 60 * 1000, limit: 10 });
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'run-1'); assert.equal(pool.calls.length, 1);
});

test('stale RUNNING provider runs fail closed and persist reconciliation evidence', async () => {
  const now = new Date('2026-10-28T05:00:00.000Z');
  const run = { id: 'run-2', status: 'RUNNING', started_at: new Date('2026-10-28T04:00:00.000Z'), external_job_id: 'provider-job-2' };
  const pool = fakePool(run, [{ id: 'artifact-2', version_id: 'version-2', content_hash: 'abc', created_at: now }]);
  const result = await reconcileStaleProviderRun(pool, { runId: 'run-2', now, staleAfterMs: 15 * 60 * 1000, actor: 'test-reconciler' });
  assert.equal(result.reconciled, true); assert.equal(result.run.status, 'FAILED'); assert.deepEqual(result.persistedArtifactIds, ['artifact-2']);
  assert.equal(result.run.error.code, 'PROVIDER_RUN_RECONCILIATION_REQUIRED'); assert.equal(result.run.error.requiresExternalProviderVerification, true);
  assert.equal(result.run.error.externalJobId, 'provider-job-2'); assert.deepEqual(result.run.error.persistedArtifactIds, ['artifact-2']); assert.equal(result.run.error.actor, 'test-reconciler');
  assert.equal(pool.calls.filter((call) => call.sql.startsWith('UPDATE provider_runs')).length, 1);
});

test('fresh RUNNING provider runs are never changed', async () => {
  const now = new Date('2026-10-28T05:00:00.000Z');
  const run = { id: 'run-3', status: 'RUNNING', started_at: new Date('2026-10-28T04:55:00.000Z') };
  const pool = fakePool(run);
  const result = await reconcileStaleProviderRun(pool, { runId: 'run-3', now, staleAfterMs: 15 * 60 * 1000 });
  assert.equal(result.reconciled, false); assert.equal(result.reason, 'LEASE_NOT_EXPIRED'); assert.equal(run.status, 'RUNNING');
  assert.equal(pool.calls.filter((call) => call.sql.startsWith('UPDATE provider_runs')).length, 0);
});

test('terminal provider runs are immutable under reconciliation', async () => {
  const run = { id: 'run-4', status: 'SUCCEEDED', started_at: new Date('2026-10-28T04:00:00.000Z') };
  const pool = fakePool(run);
  const result = await reconcileStaleProviderRun(pool, { runId: 'run-4', now: new Date('2026-10-28T05:00:00.000Z') });
  assert.equal(result.reconciled, false); assert.equal(result.reason, 'TERMINAL'); assert.equal(run.status, 'SUCCEEDED');
});
