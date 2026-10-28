'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideReconciliation, reconcileScheduledExecutions } = require('../src/scheduling/release-schedule-reconciliation');

function fixture(overrides = {}) {
  return {
    id: 'exec-1',
    status: 'QUEUED',
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    episode_id: 'episode-1',
    schedule_id: 'schedule-1',
    schedule_version: 2,
    occurrence_key: 'UTC:2026-10-28T12:00:00.000Z',
    destination: 'youtube',
    release_epoch: 7,
    publish_run_id: 'run-1',
    publish_job_id: null,
    gate_fingerprint: 'gate-1',
    job_status: null,
    publish_status: 'QUEUED',
    schedule_status: 'ACTIVE',
    current_version: 2,
    current_release_epoch: 7,
    ...overrides,
  };
}

test('terminal publish success wins over scheduler execution state', () => {
  assert.deepEqual(decideReconciliation(fixture({ status: 'RUNNING', publish_status: 'PUBLISHED', job_status: 'SUCCEEDED' })), { action: 'TERMINAL', status: 'PUBLISHED' });
});

test('terminal publish failure cannot be resurrected by a missing job', () => {
  assert.deepEqual(decideReconciliation(fixture({ publish_status: 'FAILED', job_status: null })), { action: 'TERMINAL', status: 'FAILED' });
});

test('missing publish job is safe to recreate only for a current queued execution', () => {
  assert.deepEqual(decideReconciliation(fixture({ job_status: null })), { action: 'REQUEUE' });
  assert.equal(decideReconciliation(fixture({ status: 'QUEUED', current_version: 3 })).action, 'TERMINAL');
  assert.equal(decideReconciliation(fixture({ status: 'QUEUED', current_release_epoch: 8 })).action, 'TERMINAL');
  assert.equal(decideReconciliation(fixture({ status: 'QUEUED', publish_run_id: null })).status, 'RECONCILIATION_REQUIRED');
});

test('missing job for running work never requeues an uncertain provider attempt', () => {
  const decision = decideReconciliation(fixture({ status: 'RUNNING', job_status: null }));
  assert.equal(decision.action, 'RECONCILE');
  assert.equal(decision.status, 'RECONCILIATION_REQUIRED');
});

test('terminal publish job with nonterminal publish run fails closed', () => {
  const decision = decideReconciliation(fixture({ job_status: 'FAILED', publish_status: 'QUEUED' }));
  assert.equal(decision.action, 'RECONCILE');
  assert.equal(decision.status, 'RECONCILIATION_REQUIRED');
});

test('persisted reconciliation is idempotent and does not recreate a terminal execution', async () => {
  const rows = [fixture({ id: 'published', publish_status: 'PUBLISHED', job_status: 'SUCCEEDED' }), fixture({ id: 'orphaned', status: 'RUNNING', job_status: null })];
  const updates = [];
  const jobs = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes('SELECT x.*')) return { rows };
      if (sql.startsWith('UPDATE forge_release_schedule_executions')) {
        const row = rows.find((item) => item.id === params[0]);
        if (row) {
          row.status = params[1] || row.status;
          row.block_reason = params[2] || row.block_reason;
          updates.push({ id: row.id, status: row.status });
        }
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    },
  };
  const queue = { async enqueue() { jobs.push('unexpected'); return { id: 'new-job' }; } };

  const first = await reconcileScheduledExecutions({ pool, queue });
  const second = await reconcileScheduledExecutions({ pool, queue });
  assert.equal(first.fixed, 2);
  assert.equal(second.fixed, 0);
  assert.equal(jobs.length, 0);
  assert.equal(rows.find((row) => row.id === 'published').status, 'PUBLISHED');
  assert.equal(rows.find((row) => row.id === 'orphaned').status, 'RECONCILIATION_REQUIRED');
  assert.deepEqual(updates, [
    { id: 'published', status: 'PUBLISHED' },
    { id: 'orphaned', status: 'RECONCILIATION_REQUIRED' },
  ]);
});
