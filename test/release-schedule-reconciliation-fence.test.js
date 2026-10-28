'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { enqueueMissingReleaseJob } = require('../src/scheduling/release-schedule-reconciliation-fence');

function fixture(overrides = {}) {
  return {
    id: 'execution-a',
    tenant_id: 'tenant-1',
    project_id: 'project-1',
    episode_id: 'episode-1',
    schedule_id: 'schedule-a',
    schedule_version: 1,
    occurrence_key: 'UTC:2026-10-28T15:00:00.000Z',
    destination: 'youtube',
    release_epoch: 3,
    gate_fingerprint: 'gate-a',
    publish_run_id: 'publish-run-a',
    publish_job_id: null,
    status: 'QUEUED',
    ...overrides,
  };
}

function createPersistedFixture(row = fixture()) {
  const state = {
    execution: { ...row },
    gateFingerprint: row.gate_fingerprint,
    jobs: [],
    committed: false,
    episodeLocked: false,
    pendingIdentityChange: null,
  };

  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT x.*, s.status AS schedule_status')) return { rows: [{ ...state.execution, schedule_status: 'ACTIVE', current_version: state.execution.schedule_version, publish_status: 'QUEUED' }] };
      if (sql.includes('SELECT id FROM episodes')) { state.episodeLocked = true; return { rows: [{ id: state.execution.episode_id }] }; }
      if (sql.includes('SELECT id FROM episode_packages')) return { rows: [{ id: 'package-a' }] };
      if (sql.startsWith('UPDATE forge_release_schedule_executions')) {
        if (sql.includes("status='RECONCILIATION_REQUIRED'")) {
          state.execution = { ...state.execution, status: 'RECONCILIATION_REQUIRED' };
        } else {
          state.execution = { ...state.execution, publish_job_id: params[1], status: 'QUEUED' };
        }
        return { rows: [{ id: state.execution.id, publish_job_id: state.execution.publish_job_id }], rowCount: 1 };
      }
      if (sql.startsWith('COMMIT')) {
        state.committed = true;
        state.episodeLocked = false;
        if (state.pendingIdentityChange) {
          state.gateFingerprint = state.pendingIdentityChange;
          state.pendingIdentityChange = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('ROLLBACK')) { state.episodeLocked = false; return { rows: [], rowCount: 0 }; }
      if (sql.startsWith('INSERT INTO forge_jobs')) {
        const job = { id: `job-${state.jobs.length + 1}`, payload: JSON.parse(params[4]), idempotency_key: params[8] };
        state.jobs.push(job);
        return { rows: [job], rowCount: 1 };
      }
      throw new Error(`Unhandled SQL in fixture: ${sql.slice(0, 80)}`);
    },
    release() {},
  };

  const pool = { async connect() { return client; } };
  const queue = { async enqueue(args) { return this.pool.query('INSERT INTO forge_jobs', [null, args.projectId, args.episodeId, args.kind, JSON.stringify(args.payload), args.priority, 3, null, args.idempotencyKey, args.createdBy, null, null, null]).then((r) => r.rows[0]); }, pool };
  const transactionContext = new AsyncLocalStorage();
  const gate = async () => ({ ok: true, fingerprint: state.gateFingerprint, snapshot: { packageId: 'package-a' }, failures: [] });
  return { state, pool, queue, gate, transactionContext };
}

test('unchanged identity persists exactly one durable job', async () => {
  const f = createPersistedFixture();
  const result = await enqueueMissingReleaseJob({ ...f, row: f.state.execution });
  assert.equal(result.outcome, 'ENQUEUED');
  assert.equal(f.state.jobs.length, 1);
  assert.equal(f.state.execution.publish_job_id, 'job-1');
  assert.equal(f.state.jobs[0].payload.gateFingerprint, 'gate-a');
});

test('identity mutation racing after the gate check cannot commit before the fenced job', async () => {
  const f = createPersistedFixture();
  f.gate = async () => {
    f.state.pendingIdentityChange = 'gate-b';
    return { ok: true, fingerprint: 'gate-a', snapshot: { packageId: 'package-a' }, failures: [] };
  };
  const result = await enqueueMissingReleaseJob({ ...f, row: f.state.execution });
  assert.equal(result.outcome, 'ENQUEUED');
  assert.equal(f.state.jobs.length, 1);
  assert.equal(f.state.jobs[0].payload.gateFingerprint, 'gate-a');
  assert.equal(f.state.gateFingerprint, 'gate-b');
  assert.equal(f.state.committed, true);
});

test('changed identity is fail-closed and a retry cannot create a stale job', async () => {
  const f = createPersistedFixture({ gate_fingerprint: 'gate-a' });
  f.state.gateFingerprint = 'gate-b';
  const result = await enqueueMissingReleaseJob({ ...f, row: f.state.execution });
  assert.equal(result.outcome, 'STALE');
  assert.equal(f.state.jobs.length, 0);
  assert.equal(f.state.execution.status, 'RECONCILIATION_REQUIRED');

  const retry = createPersistedFixture({ gate_fingerprint: 'gate-b', status: 'QUEUED' });
  const retryResult = await enqueueMissingReleaseJob({ ...retry, row: retry.state.execution });
  assert.equal(retryResult.outcome, 'ENQUEUED');
  assert.equal(retry.state.jobs.length, 1);
});

test('a newer valid release remains independently schedulable', async () => {
  const f = createPersistedFixture({ id: 'execution-b', schedule_id: 'schedule-b', schedule_version: 2, occurrence_key: 'UTC:2026-10-28T16:00:00.000Z', gate_fingerprint: 'gate-b' });
  const result = await enqueueMissingReleaseJob({ ...f, row: f.state.execution });
  assert.equal(result.outcome, 'ENQUEUED');
  assert.equal(f.state.jobs.length, 1);
  assert.match(f.state.jobs[0].idempotency_key, /schedule-b:v2/);
});
