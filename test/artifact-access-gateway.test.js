const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { ArtifactAccessGateway, parseRange, signToken, verifyToken } = require('../src/storage/artifact-access-gateway');

const SECRET = '01234567890123456789012345678901';
const HASH = 'a'.repeat(64);

function makeFixture(overrides = {}) {
  const artifact = {
    id: 'artifact-1', episode_id: 'episode-1', version_id: 'version-1', kind: 'render', content_hash: HASH,
    media_type: 'video/mp4', metadata: { storageKey: 'must-not-leak' }, created_by: 'owner', created_at: new Date().toISOString(),
    artifact_lifecycle: 'ACTIVE', project_id: 'project-1', episode_state: 'APPROVED', current_render_id: 'artifact-1',
    approved_render_id: 'artifact-1', published_record_id: null, storage_key: 'tenants/forge/projects/project-1/artifacts/render/aa/aaaaaaaa.mp4',
    storage_status: 'READY', storage_lifecycle: 'ACTIVE', size_bytes: 4, stored_hash: HASH, checksum_verified: true, ...overrides,
  };
  const audit = [];
  const pool = { query: async (sql, params) => {
    if (sql.includes('FROM artifacts a JOIN episodes')) return { rows: [artifact] };
    if (sql.includes('SELECT p.created_by,m.role')) return { rows: [{ created_by: 'owner', role: null }] };
    if (sql.includes('WITH RECURSIVE seeds')) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('INSERT INTO audit_events')) { audit.push({ sql, params }); return { rows: [] }; }
    if (sql.includes('UPDATE storage_objects')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  return { artifact, audit, repository: { db: { pool } } };
}

function makeGateway({ storage, clock = () => 1700000000000, fixtureOverrides = {}, adminActors = '', workerActors = '' } = {}) {
  const f = makeFixture(fixtureOverrides);
  if (!storage) storage = { download: async () => ({ stream: Readable.from(Buffer.from('test')), sizeBytes: 4, key: f.artifact.storage_key }) };
  return { gateway: new ArtifactAccessGateway({ repository: f.repository, storage, signingSecret: SECRET, tokenTtlSeconds: 300, maxRangeBytes: 2, maxTransferBytes: 1024, adminActors, workerActors, clock }), fixture: f };
}

test('parseRange rejects malformed, multi-range and oversized requests', () => {
  assert.deepEqual(parseRange('bytes=1-2', 10, 4), { start: 1, end: 2, length: 2 });
  assert.throws(() => parseRange('bytes=1-9', 10, 4), /exceeds/);
  assert.throws(() => parseRange('bytes=1-2,4-5', 10, 4), /Multiple/);
  assert.throws(() => parseRange('bytes=20-21', 10, 4), /not satisfiable/);
  assert.throws(() => parseRange('bytes=wat', 10, 4), /Malformed/);
});

test('signed artifact tokens expire and detect tampering', () => {
  const token = signToken({ v: 1, jti: 'j1', artifactId: 'artifact-1', actor: 'owner', action: 'download', exp: 200 }, SECRET);
  assert.equal(verifyToken(token, SECRET, 199000).artifactId, 'artifact-1');
  assert.throws(() => verifyToken(`${token}x`, SECRET, 199000), (error) => error.code === 'INVALID_ACCESS_TOKEN');
  assert.throws(() => verifyToken(token, SECRET, 200000), (error) => error.code === 'ACCESS_TOKEN_EXPIRED');
});

test('metadata access is project-scoped and never exposes storage paths', async () => {
  const { gateway } = makeGateway();
  const item = await gateway.metadata({ artifactId: 'artifact-1', actor: 'owner' });
  assert.equal(item.projectId, 'project-1');
  assert.equal(item.contentHash, HASH);
  assert.equal(item.storageKey, undefined);
  assert.equal(item.storageUri, undefined);
});

test('unapproved, quarantined, deleted and superseded artifacts are denied', async (t) => {
  for (const lifecycle of ['QUARANTINED', 'DELETED', 'SUPERSEDED']) {
    await t.test(lifecycle, async () => {
      const { gateway } = makeGateway({ fixtureOverrides: { artifact_lifecycle: lifecycle } });
      await assert.rejects(() => gateway.metadata({ artifactId: 'artifact-1', actor: 'owner' }), (error) => error.code === 'ARTIFACT_LIFECYCLE_DENIED');
    });
  }
  const { gateway } = makeGateway({ fixtureOverrides: { episode_state: 'QA', approved_render_id: null } });
  await assert.rejects(() => gateway.open({ artifactId: 'artifact-1', actor: 'owner' }), (error) => error.code === 'APPROVAL_REQUIRED');
});

test('project isolation and IDOR are denied', async () => {
  const f = makeFixture({ project_id: 'project-2' });
  f.repository.db.pool.query = async (sql) => {
    if (sql.includes('FROM artifacts a JOIN episodes')) return { rows: [f.artifact] };
    if (sql.includes('SELECT p.created_by,m.role')) return { rows: [{ created_by: 'different-owner', role: null }] };
    throw new Error(`unexpected query: ${sql}`);
  };
  const gateway = new ArtifactAccessGateway({ repository: f.repository, storage: { download: async () => ({ stream: Readable.from('x'), sizeBytes: 1 }) }, signingSecret: SECRET });
  await assert.rejects(() => gateway.metadata({ artifactId: 'artifact-1', actor: 'owner' }), (error) => error.code === 'FORBIDDEN');
  await assert.rejects(() => gateway.metadata({ artifactId: '../artifact-1', actor: 'owner' }), (error) => error.code === 'INVALID_ARTIFACT_ID');
});

test('signed access is bound to actor, artifact and action', async () => {
  const { gateway } = makeGateway();
  const issued = await gateway.issueToken({ artifactId: 'artifact-1', actor: 'owner', action: 'download' });
  await assert.rejects(() => gateway.open({ artifactId: 'artifact-1', actor: 'other', token: issued.token }), (error) => ['TOKEN_BINDING_MISMATCH','FORBIDDEN'].includes(error.code));
  await assert.rejects(() => gateway.metadata({ artifactId: 'artifact-2', actor: 'owner', token: issued.token }), (error) => error.code === 'TOKEN_BINDING_MISMATCH');
});

test('range delivery is bounded and returns exact content length', async () => {
  const { gateway } = makeGateway({ storage: { downloadRange: async ({ start, end }) => ({ stream: Readable.from(Buffer.from('ab')), sizeBytes: end - start + 1 }) } });
  const result = await gateway.open({ artifactId: 'artifact-1', actor: 'owner', rangeHeader: 'bytes=1-2' });
  assert.equal(result.statusCode, 206);
  assert.equal(result.contentLength, 2);
  assert.equal(result.contentRange, 'bytes 1-2/4');
  await assert.rejects(() => gateway.open({ artifactId: 'artifact-1', actor: 'owner', rangeHeader: 'bytes=0-3' }), (error) => error.code === 'RANGE_TOO_LARGE');
});

test('checksum mismatch, missing artifact and provider failures are surfaced safely', async (t) => {
  await t.test('checksum', async () => {
    const { gateway } = makeGateway({ storage: { download: async () => { throw Object.assign(new Error('bad hash'), { code: 'CHECKSUM_MISMATCH' }); } } });
    await assert.rejects(() => gateway.open({ artifactId: 'artifact-1', actor: 'owner' }), (error) => error.code === 'ARTIFACT_CORRUPT');
  });
  await t.test('missing', async () => {
    const { gateway } = makeGateway({ storage: { download: async () => { throw Object.assign(new Error('gone'), { code: 'ARTIFACT_NOT_FOUND' }); } } });
    await assert.rejects(() => gateway.open({ artifactId: 'artifact-1', actor: 'owner' }), (error) => error.code === 'ARTIFACT_NOT_FOUND');
  });
  await t.test('provider failure', async () => {
    const { gateway } = makeGateway({ storage: { download: async () => { throw new Error('provider unavailable'); } } });
    await assert.rejects(() => gateway.open({ artifactId: 'artifact-1', actor: 'owner' }), (error) => error.code === 'STORAGE_PROVIDER_ERROR');
  });
});

test('concurrent downloads remain independently authorized and audited', async () => {
  const { gateway, fixture } = makeGateway();
  const results = await Promise.all(Array.from({ length: 8 }, () => gateway.open({ artifactId: 'artifact-1', actor: 'owner' })));
  assert.equal(results.length, 8);
  assert.equal(fixture.audit.filter((event) => event.params[3] === 'ARTIFACT_DOWNLOAD').length, 8);
});

test('worker and recovery policies are explicit', async () => {
  const { gateway: worker } = makeGateway({ fixtureOverrides: { episode_state: 'QA', approved_render_id: null }, workerActors: 'worker-1' });
  const result = await worker.open({ artifactId: 'artifact-1', actor: 'worker-1', purpose: 'worker' });
  assert.equal(result.statusCode, 200);
  const { gateway: admin } = makeGateway({ fixtureOverrides: { artifact_lifecycle: 'QUARANTINED' }, adminActors: 'admin-1' });
  const metadata = await admin.metadata({ artifactId: 'artifact-1', actor: 'admin-1', recovery: true });
  assert.equal(metadata.id, 'artifact-1');
  await assert.rejects(() => admin.metadata({ artifactId: 'artifact-1', actor: 'admin-1' }), (error) => error.code === 'ARTIFACT_LIFECYCLE_DENIED');
});
