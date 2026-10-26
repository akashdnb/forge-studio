const test = require('node:test');
const assert = require('node:assert/strict');
const { ArtifactStorageService } = require('../src/storage/artifact-storage-service');

test('artifact storage service resolves only the trusted persisted storage key', async () => {
  const calls = [];
  const storage = { upload: async () => {}, async download(input) { calls.push(input); return { stream: null, sizeBytes: 12, key: input.key, uri: 's3://bucket/' + input.key }; } };
  const trustedKey = 'tenants/forge/projects/project-1/artifacts/render/aa/' + 'a'.repeat(64) + '.mp4';
  const pool = { query: async (sql) => {
    if (sql.startsWith('SELECT a.*')) return { rows: [{ id: 'artifact-1', episode_id: 'episode-1', version_id: 'version-1', kind: 'render', content_hash: 'a'.repeat(64), storage_uri: 'https://attacker.invalid/payload', storage_key: trustedKey, status: 'READY', stored_hash: 'a'.repeat(64), media_type: 'video/mp4', metadata: {}, project_id: 'project-1' }] };
    throw new Error('unexpected query: ' + sql);
  }};
  const service = new ArtifactStorageService({ storage, repository: { db: { pool } } });
  const opened = await service.openArtifact({ artifactId: 'artifact-1', projectId: 'project-1', expectedVersionId: 'version-1' });
  assert.equal(opened.key, trustedKey); assert.equal(calls[0].key, trustedKey); assert.notEqual(calls[0].key, 'https://attacker.invalid/payload');
});

test('artifact storage service rejects cross-project writes before touching storage', async () => {
  let uploaded = false;
  const service = new ArtifactStorageService({ storage: { upload: async () => { uploaded = true; }, download: async () => {} }, repository: { db: { getEpisode: async () => ({ id: 'e', project_id: 'other' }) } } });
  await assert.rejects(() => service.putArtifact({ episodeId: 'e', projectId: 'project', versionId: 'v', kind: 'render', content: Buffer.from('x') }), { code: 'INVALID_PROVENANCE' });
  assert.equal(uploaded, false);
});
