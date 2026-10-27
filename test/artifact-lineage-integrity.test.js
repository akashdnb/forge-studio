'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { LocalFileStorage } = require('../src/storage/local-file-storage');
const { ArtifactIntegrityControlPlane, digest } = require('../src/storage/artifact-integrity-control-plane');
const { verifyAndRebuildContentReference } = require('../src/storage/artifact-integrity-repair');

const ROOT = path.resolve(__dirname, '..');

test('artifact integrity modules remain syntactically valid', () => {
  for (const file of [
    'src/storage/artifact-integrity-control-plane.js',
    'src/storage/artifact-integrity-bootstrap.js',
    'src/storage/artifact-integrity-worker.js',
    'src/storage/artifact-integrity-repair.js',
    'src/storage/artifact-storage-service.js',
    'src/runtime/worker-entry.js',
  ]) execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
});

test('lineage evidence digest is deterministic', () => {
  assert.equal(digest({ relation: 'DERIVED_FROM', inputVersionId: 'v1' }), digest({ relation: 'DERIVED_FROM', inputVersionId: 'v1' }));
  assert.notEqual(digest({ relation: 'DERIVED_FROM', inputVersionId: 'v1' }), digest({ relation: 'DERIVED_FROM', inputVersionId: 'v2' }));
});

test('local storage rejects same-size corruption during verified read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-artifact-integrity-'));
  try {
    const storage = new LocalFileStorage({ rootDir: root, maxBytes: 1024 * 1024 });
    const content = Buffer.from('immutable forge artifact');
    const uploaded = await storage.upload({ stream: require('node:stream').Readable.from(content), tenantId: 'tenant-test', projectId: 'project-test', kind: 'audio', contentType: 'audio/mpeg' });
    const file = storage.pathFor(uploaded.key);
    const corrupted = Buffer.from(content);
    corrupted[0] ^= 0xff;
    fs.writeFileSync(file, corrupted);
    await assert.rejects(() => storage.download({ key: uploaded.key, expectedSha256: uploaded.sha256 }).then(async result => { for await (const chunk of result.stream) void chunk; }), error => error.code === 'CHECKSUM_MISMATCH');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified repair refuses a checksum mismatch before ledger mutation', async () => {
  let mutated = false;
  const service = {
    pool: { query: async () => ({ rows: [{ id: 'a', content_hash: 'a'.repeat(64), storage_key: 'k', size_bytes: 3, status: 'READY', project_id: 'p', tenant_id: 't' }] }) },
    storage: { download: async () => ({ stream: require('node:stream').Readable.from(Buffer.from('bad')) }) },
    rebuildContentReference: async () => { mutated = true; },
  };
  await assert.rejects(() => verifyAndRebuildContentReference(service, { tenantId: 't', artifactId: 'a' }), error => error.code === 'CHECKSUM_MISMATCH' || error.code === 'SIZE_MISMATCH');
  assert.equal(mutated, false);
});

test('migration 149 is present exactly once', () => {
  const matches = fs.readdirSync(path.join(ROOT, 'migrations')).filter(name => /^149_.*\.sql$/.test(name));
  assert.equal(matches.length, 1, `expected one migration 149, found ${matches.join(', ')}`);
});

test('postgres lineage write is concurrent-idempotent and tenant scoped', { skip: !process.env.DATABASE_URL || process.env.FORGE_RUN_ARTIFACT_INTEGRITY_INTEGRATION !== 'true' }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  try {
    const scope = (await pool.query(`SELECT p.tenant_id,p.id project_id,e.id episode_id,v.id version_id,a.id artifact_id
      FROM projects p JOIN episodes e ON e.project_id=p.id JOIN version_records v ON v.episode_id=e.id JOIN artifacts a ON a.version_id=v.id
      WHERE p.tenant_id IS NOT NULL ORDER BY a.created_at LIMIT 1`)).rows[0];
    if (!scope) return;
    const parent = (await pool.query(`SELECT a.id,a.version_id FROM artifacts a JOIN episodes e ON e.id=a.episode_id
      WHERE e.id=$1 AND a.id<>$2 ORDER BY a.created_at LIMIT 1`, [scope.episode_id, scope.artifact_id])).rows[0];
    if (!parent) return;
    const service = new ArtifactIntegrityControlPlane({ pool, storage: { download: async () => { throw Object.assign(new Error('not used'), { code: 'ARTIFACT_NOT_FOUND' }); } } });
    const results = await Promise.all(Array.from({ length: 5 }, () => service.recordArtifactLineage({ childArtifactId: scope.artifact_id, parentArtifactId: parent.id, actor: 'integrity-test', evidence: { test: true } })));
    assert.equal(new Set(results.map(row => row.id)).size, 1);
    const count = Number((await pool.query(`SELECT count(*) FROM artifact_lineage_edges WHERE child_artifact_id=$1 AND parent_artifact_id=$2 AND relation='DERIVED_FROM'`, [scope.artifact_id, parent.id])).rows[0].count);
    assert.equal(count, 1);
    const cross = (await pool.query(`SELECT a.id FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id WHERE p.tenant_id<>$1 LIMIT 1`, [scope.tenant_id])).rows[0];
    if (cross) await assert.rejects(() => service.recordArtifactLineage({ childArtifactId: scope.artifact_id, parentArtifactId: cross.id, actor: 'integrity-test' }), error => error.code === 'TENANT_SCOPE_VIOLATION');
  } finally {
    await pool.end();
  }
});
