const test = require('node:test');
const assert = require('node:assert/strict');
const { MediaLifecycleReconciler, consume } = require('../src/reconciliation/media-lifecycle-reconciler');

function streamOf(value) { return (async function* () { yield Buffer.from(value); })(); }
function storageFor({ missing = false, corrupt = false } = {}) {
  return {
    async download() {
      if (missing) throw Object.assign(new Error('missing'), { code: 'ARTIFACT_NOT_FOUND' });
      if (corrupt) throw Object.assign(new Error('checksum mismatch'), { code: 'CHECKSUM_MISMATCH' });
      return { stream: streamOf('verified') };
    },
    async cleanupPartials() { return { removed: 0 }; },
  };
}

class FakeClient {
  constructor({ jobRows = [], artifactRows = [], duplicateRows = [] } = {}) { this.jobRows = jobRows; this.artifactRows = artifactRows; this.duplicateRows = duplicateRows; this.updates = []; this.repairs = new Set(); }
  async query(sql, params = []) {
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('SELECT * FROM forge_jobs')) return { rows: this.jobRows };
    if (sql.includes('FROM artifacts a') && sql.includes('WHERE a.episode_id=$1')) return { rows: this.artifactRows };
    if (sql.includes('SELECT kind,version_id')) return { rows: this.duplicateRows };
    if (sql.includes('INSERT INTO forge_reconciliation_repairs')) {
      const fp = params[2]; if (this.repairs.has(fp)) return { rows: [] }; this.repairs.add(fp); return { rows: [{ id: params[0] }] };
    }
    if (sql.includes('UPDATE forge_jobs')) { this.updates.push({ sql, params }); return { rows: [{ id: params[1] || 'job', status: params[0] }] }; }
    if (sql.includes('UPDATE storage_objects')) { this.updates.push({ sql, params }); return { rows: [] }; }
    if (sql.includes('UPDATE forge_reconciliation_runs')) return { rows: [] };
    return { rows: [] };
  }
}

function artifact(id = 'a1', overrides = {}) {
  return { id, episode_id: 'e1', version_id: 'v1', version_episode_id: 'e1', storage_key: `k/${id}`, content_hash: 'a'.repeat(64), stored_hash: 'a'.repeat(64), status: 'READY', kind: 'render', ...overrides };
}
function reconciler(options = {}) { return new MediaLifecycleReconciler({ pool: { query: async () => ({ rows: [] }), connect: async () => { throw new Error('unused'); } }, storage: storageFor(), scanLimit: 3, ...options }); }

test('stale lease is recovered to queued', async () => {
  const r = reconciler(); const c = new FakeClient();
  const job = { id: 'j1', episode_id: 'e1', status: 'RUNNING', leased_until: new Date(Date.now() - 1000), worker_id: 'dead', payload: {} };
  await r.reconcileJob(c, 'run1', job); assert.match(c.updates[0].sql, /status='QUEUED'/); assert.equal(c.repairs.size, 1);
});

test('cancelled job is never resurrected', async () => {
  const r = reconciler(); const c = new FakeClient();
  const job = { id: 'j1', episode_id: 'e1', status: 'RUNNING', leased_until: new Date(Date.now() - 1000), payload: { lifecycleState: 'CANCELLED' } };
  await r.reconcileJob(c, 'run1', job); assert.equal(c.updates.length, 0);
});

test('superseded job is never resurrected', async () => {
  const r = reconciler(); const c = new FakeClient();
  const job = { id: 'j1', episode_id: 'e1', status: 'RUNNING', leased_until: new Date(Date.now() - 1000), payload: { lifecycleState: 'SUPERSEDED' } };
  await r.reconcileJob(c, 'run1', job); assert.equal(c.updates.length, 0);
});

test('terminal success without output becomes failed', async () => {
  const r = reconciler(); const c = new FakeClient();
  const job = { id: 'j1', episode_id: 'e1', status: 'RUNNING', finished_at: new Date(), payload: { terminalStatus: 'SUCCEEDED' }, result: { artifactIds: [] } };
  await r.reconcileJob(c, 'run1', job); assert.match(c.updates[0].sql, /status='FAILED'/); assert.equal(c.repairs.size, 1);
});

test('missing artifact is marked missing and job fails', async () => {
  const r = reconciler({ storage: storageFor({ missing: true }) }); const c = new FakeClient({ artifactRows: [artifact()] });
  await r.reconcileJob(c, 'run1', { id: 'j1', episode_id: 'e1', status: 'SUCCEEDED', result: { artifactIds: ['a1'] } });
  assert.ok(c.updates.some((x) => x.sql.includes('UPDATE storage_objects'))); assert.ok(c.updates.some((x) => x.sql.includes("status='FAILED'")));
});

test('corrupt artifact is marked corrupt', async () => {
  const r = reconciler({ storage: storageFor({ corrupt: true }) }); const c = new FakeClient({ artifactRows: [artifact()] });
  await r.reconcileJob(c, 'run1', { id: 'j1', episode_id: 'e1', status: 'QUEUED', result: { artifactIds: ['a1'] } });
  assert.ok(c.updates.some((x) => x.params[0] === 'CORRUPT'));
});

test('checksum mismatch is treated as permanent corruption', async () => {
  const r = reconciler({ storage: storageFor({ corrupt: true }) }); const c = new FakeClient({ artifactRows: [artifact()] });
  await r.reconcileJob(c, 'run1', { id: 'j1', episode_id: 'e1', status: 'SUCCEEDED', result: { artifactIds: ['a1'] } });
  assert.ok([...c.repairs].length >= 1);
});

test('duplicate logical output is flagged without mutating artifacts', async () => {
  const r = reconciler(); const c = new FakeClient({ duplicateRows: [{ kind: 'render', version_id: 'v1', logical_key: 'render:v1', count: 2, canonical_id: 'a1' }] });
  await r.reconcileJob(c, 'run1', { id: 'j1', episode_id: 'e1', status: 'SUCCEEDED', result: { artifactIds: [] } });
  assert.ok(c.repairs.size >= 1); assert.ok(!c.updates.some((x) => x.sql.includes('DELETE FROM artifacts')));
});

test('idempotent rerun does not create duplicate repair records', async () => {
  const r = reconciler(); const c = new FakeClient(); const job = { id: 'j1', episode_id: 'e1', status: 'RUNNING', leased_until: new Date(Date.now() - 1000), worker_id: 'dead', payload: {} };
  await r.reconcileJob(c, 'run1', job); await r.reconcileJob(c, 'run1', job); assert.equal(c.repairs.size, 1);
});

test('bounded artifact scan respects configured limit', () => { assert.equal(reconciler({ scanLimit: 3 }).scanLimit, 3); assert.throws(() => new MediaLifecycleReconciler({ pool: { query() {}, connect() {} }, storage: storageFor(), scanLimit: 0 }), /scanLimit/); });

test('heartbeat expiry uses the same deterministic lease boundary', async () => {
  const r = reconciler(); const c = new FakeClient(); const expired = new Date(Date.now() - 1);
  await r.reconcileJob(c, 'run1', { id: 'j1', episode_id: 'e1', status: 'RUNNING', leased_until: expired, payload: {} });
  assert.equal(c.updates.length > 0, true);
});

test('cancellation stops bounded stream consumption', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => consume(streamOf('x'), controller.signal), /cancelled/i);
});
