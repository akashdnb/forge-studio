const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { BackupService, encryptMetadata, decryptMetadata, sha256, redactDatabaseUrl } = require('../src/recovery/backup-service');
const exec = promisify(execFile);

const key = crypto.randomBytes(32);
const key64 = key.toString('base64');

function fakePool() {
  const state = { artifactRows: null };
  const client = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.startsWith('SELECT pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
      if (sql.startsWith('BEGIN')) return { rows: [] };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('current_database()')) return { rows: [{ database_name: 'forge', server_version: '16.4', wal_lsn: '0/123', snapshot_at: new Date().toISOString() }] };
      if (sql.includes('pg_export_snapshot')) return { rows: [{ snapshot_id: '00000001-1' }] };
      if (sql.includes('forge_schema_migrations')) return { rows: [{ version: '012_episode_version_concurrency.sql', checksum: 'abc' }] };
      if (sql.includes('artifacts a')) return { rows: state.artifactRows || [] };
      return { rows: [] };
    },
    release() {},
  };
  return { state, async connect() { return client; }, async query(sql) { return client.query(sql); } };
}

test('backup metadata is encrypted, compressed and round-trips without secrets', () => {
  const metadata = { format: 'forge-pg-custom-v1', actor: 'redacted', secretLike: 'must-not-be-plaintext' };
  const encoded = encryptMetadata(metadata, key);
  assert.equal(encoded.toString('utf8').includes('must-not-be-plaintext'), false);
  assert.deepEqual(decryptMetadata(encoded, key), metadata);
});

test('backup metadata corruption is detected', () => {
  const encoded = encryptMetadata({ ok: true }, key); encoded[encoded.length - 1] ^= 1;
  assert.throws(() => decryptMetadata(encoded, key), /Unsupported state|unable to authenticate|bad decrypt/i);
});

test('checksum helper is deterministic and database URLs are redacted', () => {
  assert.equal(sha256(Buffer.from('forge')), sha256(Buffer.from('forge')));
  const redacted = redactDatabaseUrl('postgres://user:password@example.com:5432/forge');
  assert.match(redacted, /REDACTED/); assert.doesNotMatch(redacted, /password/);
});

test('backup service exports a PostgreSQL snapshot before pg_dump and records WAL assumptions', async () => {
  process.env.FORGE_BACKUP_ENCRYPTION_KEY = key64;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-recovery-')); const pool = fakePool(); const calls = [];
  const service = new BackupService({ pool, backupDir: dir, databaseUrl: 'postgres://user:password@localhost/forge', config: { retentionDays: 1, pitrEnabled: true }, commandRunner: async (file, args) => {
    calls.push([file, args]); if (file === 'pg_dump') await fs.writeFile(args[args.indexOf('--file') + 1], 'disposable-pgdump'); if (file === 'tar') await exec(file, args); return { stdout: '', stderr: '' };
  } });
  const result = await service.createBackup({ verifyContent: false });
  assert.equal(result.status, 'SUCCEEDED'); assert.equal(calls[0][0], 'pg_dump'); assert.ok(calls[0][1].includes('--snapshot')); assert.equal(result.pitr.enabled, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('artifact missing failure aborts a backup before archive creation', async () => {
  process.env.FORGE_BACKUP_ENCRYPTION_KEY = key64;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-recovery-')); const pool = fakePool();
  pool.state.artifactRows = [{ id: 'a1', episode_id: 'e1', version_id: 'v1', kind: 'video', content_hash: 'a'.repeat(64), storage_key: 'missing', stored_hash: 'a'.repeat(64), size_bytes: 10, status: 'READY' }];
  const service = new BackupService({ pool, storage: { head: async () => null }, backupDir: dir, databaseUrl: 'postgres://localhost/forge' });
  await assert.rejects(() => service.createBackup({ verifyContent: false }), { code: 'ARTIFACT_MISSING' });
  await fs.rm(dir, { recursive: true, force: true });
});

test('restore reconciliation fences running jobs, marks external executions stale, and resets scheduler state', async () => {
  const calls = []; const pool = { async query(sql) { calls.push(sql); if (sql.includes('to_regclass')) return { rows: [{ name: 'present' }] }; if (sql.includes('SELECT count(*)')) return { rows: [{ count: 0 }] }; return { rowCount: 2, rows: [] }; } };
  const service = Object.create(BackupService.prototype); const result = await service.reconcile(pool, 'fence-123');
  assert.equal(result.fencedJobs, 2); assert.equal(result.staleExecutions, 2); assert.equal(result.schedulerStateReset, 2);
  assert.match(calls.find((sql) => sql.includes('forge_jobs')), /dispatch_generation=dispatch_generation\+1/); assert.match(calls.find((sql) => sql.includes('forge_execution_runs')), /RESTORED_STATE_FENCED/);
});
