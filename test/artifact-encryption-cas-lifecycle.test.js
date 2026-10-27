'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { LocalFileStorage } = require('../src/storage/local-file-storage');
const { authenticateManifest, verifyManifest, canonicalManifest } = require('../src/storage/artifact-integrity-manifest');

const ROOT = path.resolve(__dirname, '..');
const TEST_KEY = 'artifact-integrity-test-secret-material-32-bytes-min';

function manifest(overrides = {}) {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    artifactId: 'artifact-a',
    versionId: 'version-a',
    kind: 'video',
    storageKey: 'tenants/tenant-a/projects/project-a/artifacts/video/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp4',
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    mediaType: 'video/mp4',
    encryptionMode: 'AES256',
    encryptionKeyId: null,
    ...overrides,
  };
}

test('canonical artifact identity is digest-based and filename independent', () => {
  const a = canonicalManifest(manifest({ storageKey: 'a/content.mp4' }));
  const b = canonicalManifest(manifest({ storageKey: 'b/renamed.mp4' }));
  assert.equal(a.identity, 'sha256:' + 'a'.repeat(64));
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(Object.hasOwn(a, 'filename'), false);
});

test('authenticated integrity manifests reject metadata tampering', () => {
  const original = manifest();
  const auth = authenticateManifest(original, TEST_KEY);
  assert.equal(verifyManifest(original, auth.mac, TEST_KEY), true);
  assert.equal(verifyManifest({ ...original, sizeBytes: 1025 }, auth.mac, TEST_KEY), false);
  assert.equal(verifyManifest({ ...original, tenantId: 'tenant-b' }, auth.mac, TEST_KEY), false);
});

test('local content-addressed storage deduplicates retries and isolates tenants', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cas-'));
  try {
    const storage = new LocalFileStorage({ rootDir: root, maxBytes: 1024 * 1024 });
    const bytes = Buffer.from('same immutable bytes');
    const first = await storage.upload({ stream: Readable.from(bytes), tenantId: 'tenant-a', projectId: 'project-a', kind: 'video', contentType: 'video/mp4' });
    const retry = await storage.upload({ stream: Readable.from(bytes), tenantId: 'tenant-a', projectId: 'project-a', kind: 'video', contentType: 'video/mp4' });
    const otherTenant = await storage.upload({ stream: Readable.from(bytes), tenantId: 'tenant-b', projectId: 'project-a', kind: 'video', contentType: 'video/mp4' });
    assert.equal(first.key, retry.key);
    assert.notEqual(first.key, otherTenant.key);
    assert.equal(first.sha256, retry.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local verified reads detect same-size corruption', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cas-corrupt-'));
  try {
    const storage = new LocalFileStorage({ rootDir: root, maxBytes: 1024 * 1024 });
    const content = Buffer.from('integrity protected artifact');
    const uploaded = await storage.upload({ stream: Readable.from(content), tenantId: 'tenant-a', projectId: 'project-a', kind: 'video', contentType: 'video/mp4' });
    const file = storage.pathFor(uploaded.key);
    const corrupted = Buffer.from(content);
    corrupted[0] ^= 0xff;
    fs.writeFileSync(file, corrupted);
    await assert.rejects(async () => {
      const result = await storage.download({ key: uploaded.key, expectedSha256: uploaded.sha256 });
      for await (const chunk of result.stream) void chunk;
    }, error => error.code === 'CHECKSUM_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('migration 150 is unique and includes integrity manifest schema', () => {
  const matches = fs.readdirSync(path.join(ROOT, 'migrations')).filter(name => /^150_.*\.sql$/.test(name));
  assert.deepEqual(matches, ['150_artifact_integrity_encryption_manifest.sql']);
  const sql = fs.readFileSync(path.join(ROOT, 'migrations', matches[0]), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS artifact_integrity_manifests/);
  assert.match(sql, /forge_artifact_integrity_manifest_immutable/);
  assert.match(sql, /artifact_content_objects_tenant_sha_idx/);
});

test('postgres integration exposes tenant-safe manifest and encryption metadata', { skip: !process.env.DATABASE_URL || process.env.FORGE_RUN_ARTIFACT_ENCRYPTION_INTEGRATION !== 'true' }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const manifestTable = await pool.query("SELECT to_regclass('public.artifact_integrity_manifests') AS table_name");
    assert.equal(manifestTable.rows[0].table_name, 'artifact_integrity_manifests');
    const storageColumns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='storage_objects' AND column_name IN ('encryption_mode','encryption_key_id','integrity_manifest_id') ORDER BY column_name`);
    assert.deepEqual(storageColumns.rows.map(r => r.column_name), ['encryption_key_id', 'encryption_mode', 'integrity_manifest_id']);
    const index = await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='artifact_content_objects_tenant_sha_idx'");
    assert.equal(index.rows.length, 1);
  } finally {
    await pool.end();
  }
});
