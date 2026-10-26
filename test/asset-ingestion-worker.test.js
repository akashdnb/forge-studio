const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AssetIngestionWorker, validateProbe, provenanceFingerprint } = require('../src/assets/asset-ingestion-worker');

const probe = (type, overrides = {}) => ({ format: { format_name: type === 'image' ? 'image2' : type === 'audio' ? 'mp4' : 'mov,mp4', duration: type === 'image' ? 0 : 4 }, streams: [{ codec_type: type, codec_name: type === 'image' ? 'png' : type === 'audio' ? 'aac' : 'h264', width: type === 'audio' ? undefined : 1920, height: type === 'audio' ? undefined : 1080, ...overrides }] });
const config = { maxBytes: 1024 * 1024, maxDurationSeconds: 60, maxWidth: 4096, maxHeight: 4096 };

test('valid image/audio/video metadata validates', () => {
  assert.equal(validateProbe(probe('image'), { mediaType: 'image/png', sizeBytes: 100, config }).type, 'image');
  assert.equal(validateProbe(probe('audio'), { mediaType: 'audio/mp4', sizeBytes: 100, config }).type, 'audio');
  assert.equal(validateProbe(probe('video'), { mediaType: 'video/mp4', sizeBytes: 100, config }).type, 'video');
});

test('checksum mismatch is rejected before persistence', async () => {
  const worker = makeWorker();
  await assert.rejects(() => worker.execute({ episodeId: 'ep', sourceVersionId: 'scene:1', mediaType: 'image/png', contentBase64: Buffer.from('valid').toString('base64'), expectedSha256: '0'.repeat(64) }), { code: 'CHECKSUM_MISMATCH' });
});

test('corrupt media and unsupported formats are rejected', () => {
  assert.throws(() => validateProbe({ format: {}, streams: [] }, { mediaType: 'image/png', sizeBytes: 10, config }), { code: 'MEDIA_CORRUPT' });
  assert.throws(() => validateProbe(probe('image'), { mediaType: 'image/gif', sizeBytes: 10, config }), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  assert.throws(() => validateProbe(probe('video'), { mediaType: 'video/mp4', sizeBytes: 10, config: { ...config, maxWidth: 100 } }), { code: 'DIMENSION_LIMIT' });
  assert.throws(() => validateProbe(probe('video', { codec_name: 'mpeg4' }), { mediaType: 'video/mp4', sizeBytes: 10, config }), { code: 'UNSUPPORTED_CODEC' });
});

test('size and duration limits are bounded', () => {
  assert.throws(() => validateProbe(probe('video'), { mediaType: 'video/mp4', sizeBytes: config.maxBytes + 1, config }), { code: 'ASSET_TOO_LARGE' });
  assert.throws(() => validateProbe({ ...probe('video'), format: { ...probe('video').format, duration: 61 } }, { mediaType: 'video/mp4', sizeBytes: 10, config }), { code: 'DURATION_LIMIT' });
});

test('provenance fingerprint is stable and order independent', () => {
  const a = provenanceFingerprint({ sourceVersionId: 'scene:1', inputVersionIds: ['b', 'a'], sceneId: 's1', assetRole: 'hero' });
  const b = provenanceFingerprint({ sourceVersionId: 'scene:1', inputVersionIds: ['a', 'b'], sceneId: 's1', assetRole: 'hero' });
  assert.equal(a, b);
});

test('duplicate checksum is idempotently returned without a second artifact', async () => {
  const source = Buffer.from('same-source'); const checksum = crypto.createHash('sha256').update(source).digest('hex');
  const queries = [];
  const pool = { async query(sql) { queries.push(sql); if (sql.includes('SELECT * FROM asset_ingestions')) return { rows: [{ status: 'READY', artifact_id: 'asset:1', version_id: 'asset:1', metadata: { validated: true } }] }; return { rows: [] }; } };
  const worker = makeWorker({ pool });
  const result = await worker.execute({ episodeId: 'ep', sourceVersionId: 'scene:1', mediaType: 'image/png', contentBase64: source.toString('base64'), expectedSha256: checksum });
  assert.equal(result.deduplicated, true); assert.equal(result.artifactId, 'asset:1'); assert.equal(queries.filter((q) => q.includes('INSERT INTO artifacts')).length, 0);
});

test('provenance mismatch is rejected', async () => {
  const pool = { async query(sql) { if (sql.includes('version_records')) return { rows: [] }; return { rows: [] }; } };
  await assert.rejects(() => makeWorker({ pool }).execute({ episodeId: 'ep', sourceVersionId: 'missing', mediaType: 'image/png', contentBase64: Buffer.from('x').toString('base64') }), { code: 'INVALID_PROVENANCE' });
});

test('retryable probe timeout is surfaced for durable job retry', async () => {
  const worker = makeWorker({ probeImpl: async () => { const error = new Error('timeout'); error.code = 'ASSET_TIMEOUT'; error.retryable = true; throw error; } });
  await assert.rejects(() => worker.execute({ episodeId: 'ep', sourceVersionId: 'scene:1', mediaType: 'image/png', contentBase64: Buffer.from('x').toString('base64') }), { code: 'ASSET_TIMEOUT', retryable: true });
});

test('cancellation is terminal', async () => {
  const pool = { async query(sql) { if (sql.includes('forge_jobs')) return { rows: [{ status: 'CANCELLED' }] }; return { rows: [] }; } };
  await assert.rejects(() => makeWorker({ pool }).execute({ episodeId: 'ep', sourceVersionId: 'scene:1', mediaType: 'image/png', contentBase64: Buffer.from('x').toString('base64') }, { id: 'job' }), { code: 'ASSET_CANCELLED', retryable: false });
});

test('partial storage completion can be reconciled to the immutable artifact', async () => {
  let registered = false; const pool = { async query() { return { rows: [] }; } };
  const repository = { db: { pool }, registerArtifact: async (input) => { registered = input; return input; } };
  const storage = { keyFor: () => 'key', head: async () => ({ key: 'key' }) };
  const worker = new AssetIngestionWorker({ repository, storage });
  const ok = await worker.reconcileStorage({ episodeId: 'ep', projectId: 'project', ingestionId: 'ingest', versionId: 'asset:1', artifactId: 'asset:1', kind: 'image', mediaType: 'image/png', checksum: 'a'.repeat(64), inputVersionIds: ['scene:1'], metadata: { validated: true }, createdBy: 'worker' });
  assert.equal(ok, true); assert.equal(registered.id, 'asset:1');
});

function makeWorker({ pool, probeImpl } = {}) {
  const db = pool || { async query(sql) { if (sql.includes('FROM episodes')) return { rows: [{ id: 'ep', project_id: 'project' }] }; if (sql.includes('version_records')) return { rows: [{ id: 'scene:1', kind: 'scene-plan', episode_id: 'ep' }] }; return { rows: [] }; } };
  const repository = { db: { pool: db, getEpisode: async () => ({ id: 'ep', projectId: 'project' }) }, registerArtifact: async (input) => input };
  const storage = { upload: async ({ expectedSha256, contentType }) => ({ key: `asset/${expectedSha256}`, uri: `storage://${expectedSha256}`, sha256: expectedSha256, sizeBytes: 1, contentType }), download: async () => ({ stream: require('node:stream').Readable.from([]) }), keyFor: () => 'key', head: async () => null };
  return new AssetIngestionWorker({ repository, storage, probeImpl: probeImpl || (async () => probe('image')), config });
}
