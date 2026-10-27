const test = require('node:test');
const assert = require('node:assert/strict');
const { ArtifactLifecycleWorker, parseRetentionPolicy } = require('../src/reconciliation/artifact-lifecycle-worker');

function baseArtifact(overrides = {}) {
  return { id: 'a1', episode_id: 'e1', project_id: 'p1', version_id: 'v1', kind: 'render', episode_state: 'PUBLISHED', storage_key: 'tenants/forge/projects/p1/artifacts/render/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4', storage_status: 'READY', created_at: new Date(Date.now() - 120 * 86400000), ...overrides };
}

class FakeClient {
  constructor({ lifecycle = null, refs = {}, reachable = false, expired = true, lock = true } = {}) {
    this.lifecycle = lifecycle || { artifact_id: 'a1', project_id: 'p1', state: 'RETAINED', reference_count: 0, quarantine_at: null };
    this.refs = refs; this.reachable = reachable; this.expired = expired; this.lock = lock; this.events = []; this.updates = []; this.inTx = false;
  }
  async query(sql, params = []) {
    if (sql === 'BEGIN') { this.inTx = true; return { rows: [] }; }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { this.inTx = false; return { rows: [] }; }
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: this.lock }] };
    if (sql.includes('INSERT INTO artifact_lifecycle_records')) { this.lifecycle = { ...this.lifecycle, artifact_id: params[0], project_id: params[1] }; return { rows: [] }; }
    if (sql.includes('SELECT * FROM artifact_lifecycle_records WHERE artifact_id=$1')) return { rows: [this.lifecycle] };
    if (sql.includes('FROM artifact_lifecycle_records WHERE artifact_id=$1 FOR UPDATE')) return { rows: [this.lifecycle] };
    if (sql.includes('SELECT a.created_at, s.expires_at')) return { rows: [{ created_at: new Date(Date.now() - 120 * 86400000), expires_at: null, status: 'READY', storage_key: 'k/a1' }] };
    if (sql.includes('SELECT count(*) FROM version_dependencies')) return { rows: [{ dependency_refs: this.refs.dependencyRefs || 0, input_version_refs: this.refs.inputVersionRefs || 0, approval_refs: this.refs.approvalRefs || 0, qa_refs: this.refs.qaRefs || 0, publish_refs: this.refs.publishRefs || 0, package_refs: this.refs.packageRefs || 0, episode_refs: this.refs.episodeRefs || 0, active_job_refs: this.refs.activeJobRefs || 0, active_provider_refs: this.refs.activeProviderRefs || 0, hold_refs: this.refs.holdRefs || 0, active_episode_refs: this.refs.activeEpisodeRefs || 0 }] };
    if (sql.includes('WITH RECURSIVE reachable')) return { rows: [{ reachable: this.reachable }] };
    if (sql.includes('UPDATE artifact_lifecycle_records SET state=') && sql.includes('RETURNING *')) { this.lifecycle = { ...this.lifecycle, state: 'DELETION_PENDING' }; return { rows: [this.lifecycle] }; }
    if (sql.includes('UPDATE artifact_lifecycle_records SET state=')) { const state = params[0]; this.lifecycle = { ...this.lifecycle, state, reference_count: Number(params[1] || 0) }; this.updates.push({ sql, params }); return { rows: [] }; }
    if (sql.includes('UPDATE artifact_lifecycle_records SET reference_count=')) { this.lifecycle = { ...this.lifecycle, reference_count: Number(params[0] || 0) }; return { rows: [] }; }
    if (sql.includes('INSERT INTO artifact_lifecycle_events')) { this.events.push({ sql, params }); return { rows: [] }; }
    if (sql.includes('SELECT a.*,e.project_id')) return { rows: [this.lifecycle.state === 'DELETION_PENDING' ? { ...baseArtifact(), ...this.lifecycle } : baseArtifact()] };
    if (sql.includes('SELECT state FROM artifact_lifecycle_records')) return { rows: [{ state: this.lifecycle.state }] };
    if (sql.includes('UPDATE storage_objects SET status=\'DELETED\'')) this.updates.push({ sql, params });
    return { rows: [] };
  }
}

function worker({ client = new FakeClient(), storage = { delete: async () => ({ deleted: true }) }, ...options } = {}) {
  return { worker: new ArtifactLifecycleWorker({ pool: { query: async () => ({ rows: [] }), connect: async () => client }, storage, scanLimit: 10, quarantineGraceMinutes: 0, retentionDays: { render: 30, default: 30 }, ...options }), client };
}

test('active job reference protects an expired artifact', async () => {
  const { worker, client } = worker({ client: new FakeClient({ refs: { activeJobRefs: 1 } }) });
  const result = await worker.evaluateOne(client, 'run1', baseArtifact(), false);
  assert.equal(result, 'protected'); assert.equal(client.lifecycle.state, 'PROTECTED');
});

test('approved version is protected even after retention expiry', async () => {
  const { worker, client } = worker({ client: new FakeClient({ refs: { approvalRefs: 1 } }) });
  await worker.evaluateOne(client, 'run1', baseArtifact(), false);
  assert.equal(client.lifecycle.state, 'PROTECTED');
});

test('passed QA evidence is a protection reference', async () => {
  const { worker, client } = worker({ client: new FakeClient({ refs: { qaRefs: 1 } }) });
  await worker.evaluateOne(client, 'run1', baseArtifact(), false);
  assert.equal(client.lifecycle.state, 'PROTECTED');
});

test('published history protects final media', async () => {
  const { worker, client } = worker({ client: new FakeClient({ refs: { publishRefs: 1 } }) });
  await worker.evaluateOne(client, 'run1', baseArtifact(), false);
  assert.equal(client.lifecycle.state, 'PROTECTED');
});

test('provenance reachability protects upstream versions', async () => {
  const { worker, client } = worker({ client: new FakeClient({ reachable: true }) });
  await worker.evaluateOne(client, 'run1', baseArtifact({ version_id: 'v-upstream' }), false);
  assert.equal(client.lifecycle.state, 'PROTECTED');
});

test('superseded and unreferenced versions enter quarantine after retention expiry', async () => {
  const { worker, client } = worker({ client: new FakeClient() });
  const result = await worker.evaluateOne(client, 'run1', baseArtifact({ version_id: 'superseded-v1' }), false);
  assert.equal(result, 'quarantined'); assert.equal(client.lifecycle.state, 'QUARANTINED');
  assert.ok(client.events.some((event) => event.params[2] === 'QUARANTINED'));
});

test('quarantine progresses deterministically to deletion pending', async () => {
  const { worker, client } = worker({ client: new FakeClient({ lifecycle: { artifact_id: 'a1', project_id: 'p1', state: 'QUARANTINED', reference_count: 0, quarantine_at: new Date(Date.now() - 1000) } }) });
  const result = await worker.evaluateOne(client, 'run1', baseArtifact(), false);
  assert.equal(result, 'deletion-pending'); assert.equal(client.lifecycle.state, 'DELETION_PENDING');
});

test('dry-run never changes lifecycle state', async () => {
  const { worker, client } = worker({ client: new FakeClient() });
  const result = await worker.evaluateOne(client, 'run1', baseArtifact(), true);
  assert.equal(result, 'candidate'); assert.equal(client.lifecycle.state, 'RETAINED'); assert.ok(client.events.some((event) => event.params[2] === 'DRY_RUN'));
});

test('storage delete is idempotent for repeated execution', async () => {
  let deletes = 0; const storage = { delete: async () => { deletes++; return { deleted: true }; } };
  const client = new FakeClient({ lifecycle: { artifact_id: 'a1', project_id: 'p1', state: 'DELETION_PENDING', reference_count: 0 } });
  const { worker } = worker({ client, storage });
  const first = await worker.deleteOne('run1', 'a1');
  client.lifecycle.state = 'DELETED';
  const second = await worker.deleteOne('run1', 'a1');
  assert.equal(first.status, 'DELETED'); assert.equal(second.status, 'SKIPPED'); assert.equal(deletes, 1);
});

test('storage provider failure leaves deletion pending for retry', async () => {
  const client = new FakeClient({ lifecycle: { artifact_id: 'a1', project_id: 'p1', state: 'DELETION_PENDING', reference_count: 0 } });
  const storage = { delete: async () => { throw Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET', retryable: true }); } };
  const { worker } = worker({ client, storage });
  const result = await worker.deleteOne('run1', 'a1');
  assert.equal(result.status, 'FAILED'); assert.equal(client.lifecycle.state, 'DELETION_PENDING'); assert.ok(client.events.some((event) => event.params[2] === 'DELETE_FAILED'));
});

test('hold prevents a pre-delete race from deleting an artifact', async () => {
  const client = new FakeClient({ lifecycle: { artifact_id: 'a1', project_id: 'p1', state: 'DELETION_PENDING', reference_count: 0 }, refs: { holdRefs: 1 } });
  let deleted = false; const storage = { delete: async () => { deleted = true; } };
  const { worker } = worker({ client, storage });
  const result = await worker.deleteOne('run1', 'a1');
  assert.equal(result.status, 'PROTECTED'); assert.equal(deleted, false); assert.equal(client.lifecycle.state, 'PROTECTED');
});

test('post-delete crash can be reconciled idempotently', async () => {
  let deletes = 0; const storage = { delete: async () => { deletes++; } };
  const client = new FakeClient({ lifecycle: { artifact_id: 'a1', project_id: 'p1', state: 'DELETION_PENDING', reference_count: 0 } });
  const { worker } = worker({ client, storage });
  const result = await worker.deleteOne('run1', 'a1');
  assert.equal(result.status, 'DELETED'); assert.equal(deletes, 1); assert.equal(client.lifecycle.state, 'DELETED');
  const rerun = await worker.deleteOne('run1', 'a1'); assert.equal(rerun.status, 'SKIPPED'); assert.equal(deletes, 1);
});

test('concurrent runs use an advisory lock and one skips', async () => {
  const client = new FakeClient({ lock: false }); const { worker } = worker({ client });
  const result = await worker.run({ reason: 'concurrent-test' });
  assert.equal(result.status, 'SKIPPED_CONCURRENT');
});

test('cancellation is checked before destructive work', async () => {
  const controller = new AbortController(); controller.abort();
  const { worker } = worker({ signal: controller.signal });
  await assert.rejects(() => worker.run({ reason: 'cancelled' }), /cancelled/i);
});

test('retention policy parser accepts JSON and rejects invalid shapes', () => {
  assert.deepEqual(parseRetentionPolicy('{"render":14}'), { render: 14 });
  assert.throws(() => parseRetentionPolicy('[]'), /object/);
});
