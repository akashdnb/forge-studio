const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { ProductionArtifactAccessGateway } = require('../src/storage/production-artifact-access-gateway');

const SECRET = '01234567890123456789012345678901';
const HASH = 'a'.repeat(64);

function setup({ released = true, reachable = true, worker = false } = {}) {
  const artifact = { id: 'a1', episode_id: 'e1', version_id: 'v1', kind: 'render', content_hash: HASH, media_type: 'video/mp4', artifact_lifecycle: 'ACTIVE', project_id: 'p1', episode_state: released ? 'APPROVED' : 'QA', current_render_id: released ? 'a1' : null, approved_render_id: released ? 'a1' : null, storage_key: 'safe/key', storage_status: 'READY', storage_lifecycle: 'ACTIVE', size_bytes: 4, stored_hash: HASH };
  const pool = { query: async (sql) => {
    if (sql.includes('FROM artifacts a JOIN episodes')) return { rows: [artifact] };
    if (sql.includes('SELECT p.created_by,m.role')) return { rows: [{ created_by: 'owner', role: null }] };
    if (sql.includes('WITH RECURSIVE seeds')) return { rows: reachable ? [{ ok: 1 }] : [] };
    if (sql.includes('INSERT INTO audit_events') || sql.includes('UPDATE storage_objects')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const gateway = new ProductionArtifactAccessGateway({ repository: { db: { pool } }, storage: { download: async () => ({ stream: Readable.from('test'), sizeBytes: 4 }) }, signingSecret: SECRET, workerActors: worker ? 'worker-1' : '' });
  return gateway;
}

test('production gateway denies unapproved metadata and delivery', async () => {
  const gateway = setup({ released: false });
  await assert.rejects(() => gateway.metadata({ artifactId: 'a1', actor: 'owner' }), (error) => error.code === 'APPROVAL_REQUIRED');
  await assert.rejects(() => gateway.open({ artifactId: 'a1', actor: 'owner' }), (error) => error.code === 'APPROVAL_REQUIRED');
});

test('production gateway requires provenance reachability', async () => {
  const gateway = setup({ reachable: false });
  await assert.rejects(() => gateway.metadata({ artifactId: 'a1', actor: 'owner' }), (error) => error.code === 'PROVENANCE_DENIED');
});

test('configured worker may consume pre-approval artifacts without granting user access', async () => {
  const gateway = setup({ released: false, worker: true });
  const result = await gateway.open({ artifactId: 'a1', actor: 'worker-1', purpose: 'worker' });
  assert.equal(result.statusCode, 200);
  await assert.rejects(() => gateway.open({ artifactId: 'a1', actor: 'owner' }), (error) => error.code === 'APPROVAL_REQUIRED');
});
