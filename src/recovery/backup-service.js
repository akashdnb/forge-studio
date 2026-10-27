const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createCipheriv, createDecipheriv } = crypto;
const execFileAsync = promisify(execFile);

const FORMAT = 'forge-pg-custom-v1';
const DEFAULTS = { retentionDays: 14, maxArtifacts: 5000, maxArtifactBytes: 512 * 1024 * 1024, timeoutMs: 30 * 60 * 1000 };

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function positive(value, fallback) { const n = Number(value ?? fallback); if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('configuration value must be a positive integer'); return n; }
function cancelled(signal) { if (signal?.aborted) throw Object.assign(new Error('Recovery operation cancelled'), { code: 'CANCELLED' }); }
function backupKey(value = process.env.FORGE_BACKUP_ENCRYPTION_KEY) {
  if (!value) throw Object.assign(new Error('FORGE_BACKUP_ENCRYPTION_KEY is required'), { code: 'BACKUP_KEY_MISSING' });
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw Object.assign(new Error('FORGE_BACKUP_ENCRYPTION_KEY must decode to 32 bytes'), { code: 'BACKUP_KEY_INVALID' });
  return key;
}
function encryptMetadata(metadata, key = backupKey()) {
  const iv = crypto.randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const compressed = require('node:zlib').gzipSync(Buffer.from(JSON.stringify(metadata)), { level: 6 });
  return Buffer.concat([Buffer.from('FGBK1'), iv, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
}
function decryptMetadata(buffer, key = backupKey()) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString() !== 'FGBK1') throw Object.assign(new Error('Backup metadata header is invalid'), { code: 'BACKUP_METADATA_CORRUPT' });
  const iv = buffer.subarray(5, 17), tag = buffer.subarray(buffer.length - 16), ciphertext = buffer.subarray(17, buffer.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
  return JSON.parse(require('node:zlib').gunzipSync(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toString());
}
async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), new Writable({ write(chunk, _encoding, cb) { hash.update(chunk); cb(); } }));
  return hash.digest('hex');
}
function redactDatabaseUrl(value) { try { const url = new URL(value); url.username = 'REDACTED'; url.password = 'REDACTED'; return url.toString(); } catch { return 'REDACTED'; } }
function targetIsolated(value) {
  if (process.env.FORGE_RESTORE_ALLOW_NONISOLATED === 'true') return true;
  try { const name = decodeURIComponent(new URL(value).pathname.replace(/^\//, '')).toLowerCase(); return /(restore|recovery|disposable|dr)$/.test(name); } catch { return false; }
}

class BackupService {
  constructor({ pool, storage, databaseUrl = process.env.DATABASE_URL, backupDir = process.env.FORGE_BACKUP_DIR || '.forge-backups', commandRunner = execFileAsync, logger = console, config = {} }) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool is required');
    if (!databaseUrl) throw Object.assign(new Error('DATABASE_URL is required'), { code: 'DATABASE_URL_MISSING' });
    this.pool = pool; this.storage = storage; this.databaseUrl = databaseUrl; this.backupDir = path.resolve(backupDir); this.commandRunner = commandRunner; this.logger = logger;
    this.config = { retentionDays: positive(config.retentionDays, process.env.FORGE_BACKUP_RETENTION_DAYS || DEFAULTS.retentionDays), maxArtifacts: positive(config.maxArtifacts, process.env.FORGE_BACKUP_MAX_ARTIFACTS || DEFAULTS.maxArtifacts), maxArtifactBytes: positive(config.maxArtifactBytes, process.env.FORGE_BACKUP_MAX_ARTIFACT_BYTES || DEFAULTS.maxArtifactBytes), timeoutMs: positive(config.timeoutMs, process.env.FORGE_BACKUP_TIMEOUT_MS || DEFAULTS.timeoutMs), pitrEnabled: String(config.pitrEnabled ?? process.env.FORGE_BACKUP_PITR_ENABLED ?? '').toLowerCase() === 'true' };
  }
  async ensureDir() { await fsp.mkdir(this.backupDir, { recursive: true, mode: 0o700 }); }
  async runCommand(file, args, signal) {
    cancelled(signal); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs); timer.unref?.();
    const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
    try { return await this.commandRunner(file, args, { signal: controller.signal, maxBuffer: 2 * 1024 * 1024 }); }
    catch (error) { if (controller.signal.aborted) throw Object.assign(new Error(signal?.aborted ? 'Recovery operation cancelled' : 'Recovery command timed out'), { code: signal?.aborted ? 'CANCELLED' : 'TIMEOUT' }); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
  async lock(client) { const r = await client.query("SELECT pg_try_advisory_lock(hashtext('forge:backup-restore')) AS acquired"); if (!r.rows[0]?.acquired) throw Object.assign(new Error('Another recovery operation is running'), { code: 'RECOVERY_BUSY' }); }
  async unlock(client) { await client.query("SELECT pg_advisory_unlock(hashtext('forge:backup-restore'))").catch(() => {}); }
  async snapshot(client) { return (await client.query("SELECT current_database() database_name, current_setting('server_version') server_version, pg_current_wal_lsn()::text wal_lsn, now() snapshot_at")).rows[0]; }
  async migrations(client = this.pool) { return (await client.query('SELECT version, checksum FROM forge_schema_migrations ORDER BY version')).rows; }
  async migrationFingerprint(client = this.pool) { return sha256(JSON.stringify(await this.migrations(client))); }

  async artifactManifest(client, { verifyContent = true, signal } = {}) {
    if (!this.storage) return { skipped: true, artifacts: [] };
    const rows = await client.query(`SELECT a.id,a.episode_id,a.version_id,a.kind,a.content_hash,s.storage_key,s.content_hash stored_hash,s.size_bytes,s.status FROM artifacts a JOIN storage_objects s ON s.artifact_id=a.id ORDER BY a.id LIMIT $1`, [this.config.maxArtifacts]);
    if (rows.rowCount === this.config.maxArtifacts) this.logger.warn?.('backup artifact inventory hit configured bound');
    const artifacts = [];
    for (const row of rows.rows) {
      cancelled(signal);
      if (row.content_hash && row.stored_hash && row.content_hash !== row.stored_hash) throw Object.assign(new Error(`artifact ${row.id} checksum metadata mismatch`), { code: 'CHECKSUM_MISMATCH' });
      const head = await this.storage.head(row.storage_key); if (!head) throw Object.assign(new Error(`artifact ${row.id} is missing from storage`), { code: 'ARTIFACT_MISSING' });
      if (Number(row.size_bytes || 0) !== Number(head.sizeBytes || 0)) throw Object.assign(new Error(`artifact ${row.id} size mismatch`), { code: 'CHECKSUM_MISMATCH' });
      const item = { id: row.id, episodeId: row.episode_id, versionId: row.version_id, kind: row.kind, storageKey: row.storage_key, contentHash: row.content_hash, storedHash: row.stored_hash, sizeBytes: Number(row.size_bytes || 0), status: row.status };
      if (verifyContent && row.content_hash) {
        if (item.sizeBytes > this.config.maxArtifactBytes) throw Object.assign(new Error(`artifact ${row.id} exceeds verification bound`), { code: 'ARTIFACT_TOO_LARGE' });
        const object = await this.storage.download({ key: row.storage_key, expectedSha256: row.content_hash, maxBytes: this.config.maxArtifactBytes });
        await pipeline(object.stream, new Writable({ write(_chunk, _encoding, cb) { cb(); } })); item.verified = true;
      }
      artifacts.push(item);
    }
    return { skipped: false, artifacts };
  }

  async createBackup({ actor = 'system', reason = 'scheduled', dryRun = false, verifyContent = true, signal } = {}) {
    await this.ensureDir(); const id = randomUUID(), client = await this.pool.connect(); let recordInserted = false; let txOpen = false;
    try {
      await this.lock(client); cancelled(signal); await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); txOpen = true;
      const snapshot = await this.snapshot(client); const migrationFingerprint = await this.migrationFingerprint(client);
      const exportedSnapshot = (await client.query('SELECT pg_export_snapshot() snapshot_id')).rows[0].snapshot_id;
      const manifest = await this.artifactManifest(client, { verifyContent, signal });
      const metadata = { format: FORMAT, backupId: id, createdAt: new Date().toISOString(), actor: actor === 'system' ? 'system' : 'redacted', reason, snapshot, exportedSnapshot, migrationFingerprint, pitr: { enabled: this.config.pitrEnabled, walLsn: snapshot.wal_lsn }, artifactCount: manifest.artifacts.length, artifacts: manifest.artifacts, secretsExcluded: true };
      const manifestSha = sha256(JSON.stringify(metadata)); const retention = new Date(Date.now() + this.config.retentionDays * 86400000);
      if (dryRun) { await client.query('ROLLBACK'); txOpen = false; return { id, dryRun: true, manifestSha256: manifestSha, pitr: metadata.pitr, artifactCount: manifest.artifacts.length }; }
      const dir = path.join(this.backupDir, id); await fsp.mkdir(dir, { recursive: true, mode: 0o700 }); const dump = path.join(dir, 'database.dump');
      await this.runCommand('pg_dump', ['--format=custom','--no-owner','--no-acl','--no-comments','--snapshot',exportedSnapshot,'--file',dump,this.databaseUrl], signal);
      await fsp.writeFile(path.join(dir, 'metadata.enc'), encryptMetadata(metadata), { mode: 0o600 }); const archive = path.join(this.backupDir, `${id}.tar.gz`);
      await this.runCommand('tar', ['-czf', archive, '-C', dir, 'database.dump', 'metadata.enc'], signal); const info = await fsp.stat(archive); const archiveSha = await fileSha256(archive);
      await client.query('COMMIT'); txOpen = false;
      await this.pool.query(`INSERT INTO forge_backup_records(id,status,backup_format,database_name,migration_fingerprint,server_version,wal_lsn,snapshot_at,manifest_sha256,archive_sha256,backup_path,metadata_path,bytes,artifact_count,verified_artifact_count,retention_expires_at,created_by,completed_at) VALUES($1,'SUCCEEDED',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())`, [id, FORMAT, snapshot.database_name, migrationFingerprint, snapshot.server_version, snapshot.wal_lsn, snapshot.snapshot_at, manifestSha, archiveSha, archive, `${archive}#metadata.enc`, info.size, manifest.artifacts.length, manifest.artifacts.filter((a) => a.verified).length, retention, actor]);
      await fsp.rm(dir, { recursive: true, force: true }); await this.applyRetention({ signal }); return { id, status: 'SUCCEEDED', archivePath: archive, archiveSha256: archiveSha, manifestSha256: manifestSha, bytes: info.size, artifactCount: metadata.artifactCount, pitr: metadata.pitr };
    } catch (error) {
      if (txOpen) await client.query('ROLLBACK').catch(() => {});
      if (recordInserted) await this.pool.query(`UPDATE forge_backup_records SET status='FAILED',error_code=$2,error_message=$3,completed_at=now() WHERE id=$1`, [id, error.code || 'BACKUP_FAILED', error.message]).catch(() => {});
      throw error;
    } finally { await this.unlock(client); client.release(); }
  }

  async extract(archivePath) {
    const dir = path.join(this.backupDir, `.restore-${randomUUID()}`); await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    try { await this.commandRunner('tar', ['-xzf', archivePath, '-C', dir], { maxBuffer: 2 * 1024 * 1024 }); const metadata = decryptMetadata(await fsp.readFile(path.join(dir, 'metadata.enc'))); return { dir, dump: path.join(dir, 'database.dump'), metadata }; }
    catch (error) { await fsp.rm(dir, { recursive: true, force: true }); throw Object.assign(error, { code: error.code || 'BACKUP_ARCHIVE_CORRUPT' }); }
  }
  async verifyBackup({ archivePath, signal } = {}) { cancelled(signal); const info = await fsp.stat(archivePath); const { dir, dump, metadata } = await this.extract(archivePath); try { const dumpInfo = await fsp.stat(dump); if (!dumpInfo.size) throw Object.assign(new Error('database dump is empty'), { code: 'BACKUP_ARCHIVE_CORRUPT' }); return { valid: true, archiveBytes: info.size, archiveSha256: await fileSha256(archivePath), metadataDigest: sha256(JSON.stringify(metadata)), artifactCount: metadata.artifactCount, pitr: metadata.pitr }; } finally { await fsp.rm(dir, { recursive: true, force: true }); } }

  async compatibility(targetPool, metadata) {
    const targetVersion = (await targetPool.query("SELECT current_setting('server_version') server_version")).rows[0].server_version;
    const targetMigrations = await targetPool.query('SELECT version, checksum FROM forge_schema_migrations ORDER BY version').catch(() => ({ rows: [] }));
    if (Number(String(targetVersion).split('.')[0]) < Number(String(metadata.snapshot.server_version).split('.')[0])) throw Object.assign(new Error('target PostgreSQL major version is older than backup'), { code: 'INCOMPATIBLE_POSTGRES' });
    if (targetMigrations.rows.length && sha256(JSON.stringify(targetMigrations.rows)) !== metadata.migrationFingerprint) throw Object.assign(new Error('target migration fingerprint differs from backup'), { code: 'INCOMPATIBLE_MIGRATIONS' });
  }
  async reconcile(targetPool, fence) {
    const d = { fencedJobs: 0, staleExecutions: 0, schedulerStateReset: 0, orphanedArtifacts: 0, duplicateIdentities: 0 };
    const exists = async (name) => Boolean((await targetPool.query('SELECT to_regclass($1) AS name', [name])).rows[0]?.name);
    if (await exists('public.forge_jobs')) d.fencedJobs = (await targetPool.query(`UPDATE forge_jobs SET status='QUEUED',leased_until=NULL,worker_id=NULL,dispatch_token=NULL,dispatch_generation=dispatch_generation+1,last_schedule_reason=$1,updated_at=now() WHERE status='RUNNING'`, [`restore-fence:${fence}`])).rowCount;
    if (await exists('public.forge_execution_runs')) d.staleExecutions = (await targetPool.query(`UPDATE forge_execution_runs SET status='STALE',failure_code='RESTORED_STATE_FENCED',failure_message='restore fenced pre-disaster execution state',updated_at=now() WHERE status IN ('DISPATCHING','QUEUED','IN_PROGRESS')`)).rowCount;
    if (await exists('public.forge_scheduler_state')) d.schedulerStateReset = (await targetPool.query('DELETE FROM forge_scheduler_state')).rowCount;
    if (await exists('public.artifacts') && await exists('public.storage_objects')) d.orphanedArtifacts = Number((await targetPool.query(`SELECT count(*)::int count FROM artifacts a LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE s.id IS NULL`)).rows[0].count);
    d.duplicateIdentities = Number((await targetPool.query(`SELECT count(*)::int count FROM (SELECT id FROM forge_jobs GROUP BY id HAVING count(*)>1) d`).catch(() => ({ rows: [{ count: 0 }] }))).rows[0].count);
    if (d.orphanedArtifacts || d.duplicateIdentities) throw Object.assign(new Error('post-restore integrity reconciliation failed'), { code: 'RESTORE_INTEGRITY_FAILED', diagnostics: d });
    return d;
  }
  async restore({ archivePath, targetDatabaseUrl, actor = 'system', dryRun = false, signal } = {}) {
    if (!archivePath || !targetDatabaseUrl) throw new TypeError('archivePath and targetDatabaseUrl are required');
    if (!dryRun && !targetIsolated(targetDatabaseUrl)) throw Object.assign(new Error('restore target is not identified as an isolated recovery database'), { code: 'RESTORE_TARGET_NOT_ISOLATED' });
    const id = randomUUID(), fence = randomUUID(), client = await this.pool.connect(); let operationInserted = false;
    try {
      await this.lock(client); await this.pool.query(`INSERT INTO forge_restore_operations(id,status,phase,dry_run,target_database,fencing_token,created_by) VALUES($1,'RUNNING','PREFLIGHT',$2,$3,$4,$5)`, [id, dryRun, redactDatabaseUrl(targetDatabaseUrl), fence, actor]); operationInserted = true;
      const { dir, dump, metadata } = await this.extract(archivePath); cancelled(signal);
      if (metadata.format !== FORMAT) throw Object.assign(new Error('unsupported backup format'), { code: 'INCOMPATIBLE_BACKUP_FORMAT' });
      if (dryRun) { await this.pool.query(`UPDATE forge_restore_operations SET status='SUCCEEDED',phase='VERIFIED',diagnostics=$2::jsonb,completed_at=now() WHERE id=$1`, [id, JSON.stringify({ dryRun: true, artifactCount: metadata.artifactCount, pitr: metadata.pitr })]); await fsp.rm(dir, { recursive: true, force: true }); return { id, status: 'SUCCEEDED', dryRun: true, pitr: metadata.pitr }; }
      const { Pool } = require('pg'); const target = new Pool({ connectionString: targetDatabaseUrl, max: 2, connectionTimeoutMillis: 5000 });
      try { await target.query('SELECT 1'); await this.compatibility(target, metadata); await this.pool.query(`UPDATE forge_restore_operations SET phase='RESTORE_DATABASE' WHERE id=$1`, [id]); await this.runCommand('pg_restore', ['--exit-on-error','--single-transaction','--no-owner','--no-acl','--clean','--if-exists','--dbname',targetDatabaseUrl,dump], signal); await this.pool.query(`UPDATE forge_restore_operations SET phase='RECONCILE' WHERE id=$1`, [id]); const diagnostics = await this.reconcile(target, fence); await this.pool.query(`UPDATE forge_restore_operations SET status='SUCCEEDED',phase='VERIFIED',diagnostics=$2::jsonb,completed_at=now() WHERE id=$1`, [id, JSON.stringify(diagnostics)]); return { id, status: 'SUCCEEDED', fencingToken: fence, diagnostics, pitr: metadata.pitr }; }
      finally { await target.end().catch(() => {}); await fsp.rm(dir, { recursive: true, force: true }); }
    } catch (error) { if (operationInserted) await this.pool.query(`UPDATE forge_restore_operations SET status='FAILED',phase='FAILED',error_code=$2,error_message=$3,completed_at=now() WHERE id=$1`, [id, error.code || 'RESTORE_FAILED', error.message]).catch(() => {}); throw error; }
    finally { await this.unlock(client); client.release(); }
  }
  async applyRetention({ signal } = {}) { const rows = await this.pool.query(`SELECT id,backup_path FROM forge_backup_records WHERE status='SUCCEEDED' AND retention_expires_at < now() ORDER BY retention_expires_at LIMIT 50`); for (const row of rows.rows) { cancelled(signal); if (row.backup_path) await fsp.rm(row.backup_path, { force: true }).catch(() => {}); await this.pool.query("UPDATE forge_backup_records SET status='EXPIRED' WHERE id=$1", [row.id]); } return { expired: rows.rowCount }; }
}
module.exports = { BackupService, FORMAT, sha256, encryptMetadata, decryptMetadata, redactDatabaseUrl, fileSha256, targetIsolated };
