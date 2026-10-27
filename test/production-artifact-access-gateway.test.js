const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { ProductionArtifactAccessGateway } = require('../src/storage/production-artifact-access-gateway');
const SECRET = '01234567890123456789012345678901';
const HASH = 'a'.repeat(64);
function setup(released = true, reachable = true) {
  const artifact = { id: 'a1', episode_id: 'e1', version_id: 'v1', kind: 'render', content_hash: HASH, media_type: 'video/mp4', lifecycle_state: 'RETAINED', project_id: 'p1', episode_state: released ? 'APPROVED' : 'QA', current_render_id: released ? 'a1' : null, approved_render_id: released ? 'a1' : null, storage_key: 'safe/key', storage_status: 'READY', size_bytes: 4, stored_hash: HASH };
  const pool = { query: async (sql) => {
    if (sql.includes('FROM artifacts a JOIN episodes')) return { rows: [artifact] };
    if (sql.includes('SELECT p.created_by')) return { rows: [{ created_by: 'owner', role: 'OWNER' }] };
    if (sql.includes('WITH RECURSIVE seeds')) return { rows: reachable ? [{ ok: 1 }] : [] };
    if (sql.includes('INSERT INTO audit_events')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  return new ProductionArtifactAccessGateway({ repository: { db: { pool } }, storage: { download: async () => ({ stream: Readable.from('test'), sizeBytes: 4 }) }, signingSecret: SECRET });
}
test('production gateway denies unapproved delivery', async () => {
  const gateway = setup(false);
  await assert.rejects(() => gateway.metadata({ artifactId: 'a1', actor: 'owner' }), (error) => error.code === 'APPROVAL_REQUIRED');
  await assert.rejects(() => gateway.open({ artifactId: 'a1', actor: 'owner' }), (error) => error.code === 'APPROVAL_REQUIRED');
});
test('production gateway requires provenance reachability', async () => {
  const gateway = setup(true, false);
  await assert.rejects(() => gateway.metadata({ artifactId: 'a1', actor: 'owner' }), (error) => error.code === 'PROVENANCE_DENIED');
});
