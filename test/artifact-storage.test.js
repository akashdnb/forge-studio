const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, chmod } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const { LocalFileStorage, artifactKey } = require('../src/storage/local-file-storage');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('local storage writes content-addressed objects atomically and idempotently', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-storage-'));
  try {
    const storage = new LocalFileStorage({ rootDir: root, maxBytes: 1024 });
    const content = Buffer.from('real mp4 bytes for test'); const digest = sha(content);
    const first = await storage.upload({ stream: Readable.from(content), projectId: 'project-1', tenantId: 'tenant-1', kind: 'render', contentType: 'video/mp4' });
    const second = await storage.upload({ stream: Readable.from(content), projectId: 'project-1', tenantId: 'tenant-1', kind: 'render', contentType: 'video/mp4' });
    assert.equal(first.sha256, digest); assert.equal(first.key, second.key); assert.equal((await storage.head(first.key)).sizeBytes, content.length);
    assert.equal(first.key, artifactKey({ projectId: 'project-1', tenantId: 'tenant-1', kind: 'render', sha256: digest, contentType: 'video/mp4' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local storage rejects traversal and oversized uploads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-storage-'));
  try {
    const storage = new LocalFileStorage({ rootDir: root, maxBytes: 4 });
    await assert.rejects(() => storage.upload({ stream: Readable.from(Buffer.from('12345')), projectId: 'p', tenantId: 't', kind: 'image', contentType: 'image/png' }), { code: 'ARTIFACT_TOO_LARGE' });
    assert.throws(() => storage.pathFor('../outside'), { code: 'UNSAFE_STORAGE_KEY' });
    assert.throws(() => artifactKey({ projectId: '../p', tenantId: 't', kind: 'render', sha256: 'a'.repeat(64), contentType: 'video/mp4' }), /projectId/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('download verifies persisted checksum and reports corruption', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-storage-'));
  try {
    const storage = new LocalFileStorage({ rootDir: root, maxBytes: 1024 }); const content = Buffer.from('caption bytes');
    const stored = await storage.upload({ stream: Readable.from(content), projectId: 'p', tenantId: 't', kind: 'caption', contentType: 'text/vtt' });
    const good = await storage.download({ key: stored.key, expectedSha256: stored.sha256 });
    const chunks = []; for await (const chunk of good.stream) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), content);
    await writeFile(path.join(root, stored.key), 'tampered');
    const bad = await storage.download({ key: stored.key, expectedSha256: stored.sha256 });
    await assert.rejects(async () => { for await (const chunk of bad.stream) void chunk; }, { code: 'CHECKSUM_MISMATCH' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('download reports missing objects explicitly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-storage-'));
  try {
    const storage = new LocalFileStorage({ rootDir: root, maxBytes: 1024 });
    await assert.rejects(() => storage.download({ key: 'tenants/t/projects/p/artifacts/render/aa/' + 'a'.repeat(64) + '.mp4' }), { code: 'ARTIFACT_NOT_FOUND' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
