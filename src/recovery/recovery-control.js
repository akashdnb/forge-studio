const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { Pool } = require('pg');
const { BackupService, redactDatabaseUrl } = require('./backup-service');
const { RecoveryArtifactArchive } = require('./recovery-artifacts');
const { canonicalize, sha256, merkleRoot, schemaFingerprint, verifyDatabaseInvariants } = require('./recovery-verifier');

function isolatedTarget(sourceUrl, targetUrl) {
  if (!targetUrl || targetUrl === sourceUrl) return false;
  if (process.env.FORGE_RESTORE_ALLOW_NONISOLATED === 'true') return true;
  const allowed = String(process.env.FORGE_RECOVERY_TARGET_PREFIX || '').trim();
  return Boolean(allowed && targetUrl.startsWith(allowed));
}

class RecoveryControlPlane {
  constructor({ pool, backupService, artifactArchive, targetStorage, logger = console, maxConcurrency = 1 }) {
    if (!pool?.query || !pool?.connect) throw new TypeError('pg-compatible pool is required');
    this.pool = pool;
    this.backup = backupService || new BackupService({ pool });
    this.artifactArchive = artifactArchive || (this.backup.storage ? new RecoveryArtifactArchive({ storage: this.backup.storage, pool }) : null);
    this.targetStorage = targetStorage;
    this.logger = logger;
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 1);
  }

  async assertTenant(tenantId) {
    if (!tenantId) throw Object.assign(new Error('tenantId is required'), { code: 'TENANT_REQUIRED' });
    const result = await this.pool.query('SELECT id FROM tenants WHERE id=$1', [tenantId]);
    if (!result.rowCount) throw Object.assign(new Error('tenant not found'), { code: 'TENANT_NOT_FOUND' });
  }
  async tableExists(table) { const result = await this.pool.query('SELECT to_regclass($1) AS name', [`public.${table}`]); return Boolean(result.rows[0]?.name); }
  async audit({ tenantId, actor, action, targetType, targetId, outcome = 'ALLOWED', details = {} }) {
    if (!await this.tableExists('security_audit_events')) return;
    await this.pool.query(`INSERT INTO security_audit_events(tenant_id,actor,action,target_type,target_id,outcome,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [tenantId, actor, action, targetType, targetId, outcome, JSON.stringify(details)]).catch((error) => this.logger.warn?.(`recovery audit failed: ${error.message}`));
  }
  async createCheckpoint(operationId, phase, status, details = {}) {
    const hash = sha256(canonicalize({ operationId, phase, status, details }));
    const result = await this.pool.query(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM forge_recovery_checkpoints WHERE operation_id=$1`, [operationId]);
    const sequence = Number(result.rows[0].sequence);
    await this.pool.query(`INSERT INTO forge_recovery_checkpoints(operation_id,sequence,phase,status,checkpoint_hash,details,completed_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,CASE WHEN $4='COMPLETED' THEN now() ELSE NULL END)`, [operationId, sequence, phase, status, hash, JSON.stringify(details)]);
    await this.pool.query(`UPDATE forge_restore_operations SET phase=$2,checkpoint_seq=$3,heartbeat_at=now() WHERE id=$1`, [operationId, phase, sequence]);
    return { sequence, hash };
  }
  async recoveryEpoch() { return Number((await this.pool.query('SELECT forge_next_recovery_epoch() AS epoch')).rows[0].epoch); }
  async artifactRoot(tenantId) {
    const result = await this.pool.query(`SELECT a.id,a.episode_id,a.version_id,a.content_hash,s.storage_key,s.content_hash AS stored_hash,s.size_bytes FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE p.tenant_id=$1 ORDER BY a.id`, [tenantId]);
    return merkleRoot(result.rows.map((row) => ({ id: row.id, episodeId: row.episode_id, versionId: row.version_id, contentHash: row.content_hash, storageKey: row.storage_key, storedHash: row.stored_hash, sizeBytes: Number(row.size_bytes || 0) })));
  }

  async createBackup({ tenantId, actor, reason = 'operator', dryRun = false, verifyContent = true, signal } = {}) {
    await this.assertTenant(tenantId);
    if (!this.artifactArchive) throw Object.assign(new Error('artifact recovery storage is not configured'), { code: 'RECOVERY_STORAGE_UNAVAILABLE' });
    const sourceSchema = await schemaFingerprint(this.pool);
    try {
      const result = await this.backup.createBackup({ actor, reason, dryRun, verifyContent, signal });
      if (dryRun) return { ...result, tenantId, schemaFingerprint: sourceSchema };
      const artifacts = await this.artifactArchive.snapshot({ tenantId, backupId: result.id, signal });
      await this.pool.query(`UPDATE forge_backup_records SET tenant_id=$2,schema_fingerprint=$3,content_root=$4,encryption_key_id=$5,source_release_id=$6,integrity_status='VERIFIED',artifact_archive_path=$7,artifact_archive_sha256=$8,artifact_archive_bytes=$9 WHERE id=$1`, [result.id, tenantId, sourceSchema, artifacts.root, process.env.FORGE_BACKUP_ENCRYPTION_KEY_ID || 'default', process.env.FORGE_RELEASE_ID || 'unknown', artifacts.archive, artifacts.archiveSha256, artifacts.bytes]);
      await this.audit({ tenantId, actor, action: 'RECOVERY_BACKUP_CREATED', targetType: 'backup', targetId: result.id, details: { artifactRoot: artifacts.root, artifactArchiveSha256: artifacts.archiveSha256, schemaFingerprint: sourceSchema } });
      return { ...result, tenantId, schemaFingerprint: sourceSchema, contentRoot: artifacts.root, artifactArchivePath: artifacts.archive, artifactArchiveSha256: artifacts.archiveSha256 };
    } catch (error) {
      await this.audit({ tenantId, actor, action: 'RECOVERY_BACKUP_FAILED', targetType: 'backup', targetId: 'unknown', outcome: 'FAILED', details: { code: error.code || 'BACKUP_FAILED' } });
      throw error;
    }
  }

  async planRestore({ tenantId, actor, archivePath, targetDatabaseUrl } = {}) {
    await this.assertTenant(tenantId);
    if (!isolatedTarget(this.backup.databaseUrl, targetDatabaseUrl)) throw Object.assign(new Error('restore target is not an explicitly isolated recovery database'), { code: 'RESTORE_TARGET_NOT_ISOLATED' });
    const verified = await this.backup.verifyBackup({ archivePath });
    const extracted = await this.backup.extract(archivePath);
    try {
      const record = await this.pool.query('SELECT artifact_archive_path,artifact_archive_sha256,tenant_id,content_root,schema_fingerprint FROM forge_backup_records WHERE id=$1', [extracted.metadata.backupId]);
      const row = record.rows[0];
      if (!row || row.tenant_id !== tenantId || !row.artifact_archive_path) throw Object.assign(new Error('backup is not authorized for this tenant or has no artifact archive'), { code: 'RECOVERY_TENANT_MISMATCH' });
      const target = { database: redactDatabaseUrl(targetDatabaseUrl), format: extracted.metadata.format, artifactCount: extracted.metadata.artifactCount, pitr: extracted.metadata.pitr, archiveSha256: verified.archiveSha256, manifestSha256: verified.metadataDigest, artifactArchiveSha256: row.artifact_archive_sha256, schemaFingerprint: row.schema_fingerprint, contentRoot: row.content_root };
      await this.audit({ tenantId, actor, action: 'RECOVERY_RESTORE_PLANNED', targetType: 'backup', targetId: extracted.metadata.backupId, details: target });
      return { status: 'PLANNED', tenantId, backupId: extracted.metadata.backupId, target };
    } finally { await fs.rm(extracted.dir, { recursive: true, force: true }); }
  }

  async restoreAndVerify({ tenantId, actor, archivePath, targetDatabaseUrl, targetStorage = this.targetStorage, signal } = {}) {
    await this.assertTenant(tenantId);
    if (!this.artifactArchive || !targetStorage) throw Object.assign(new Error('isolated target artifact storage is required'), { code: 'RECOVERY_TARGET_STORAGE_REQUIRED' });
    if (!isolatedTarget(this.backup.databaseUrl, targetDatabaseUrl)) throw Object.assign(new Error('restore target is not an explicitly isolated recovery database'), { code: 'RESTORE_TARGET_NOT_ISOLATED' });
    const active = await this.pool.query(`SELECT count(*)::int AS count FROM forge_restore_operations WHERE status='RUNNING'`);
    if (Number(active.rows[0].count) >= this.maxConcurrency) throw Object.assign(new Error('another restore is already running'), { code: 'RECOVERY_BUSY' });

    const operationId = crypto.randomUUID();
    const fence = await this.recoveryEpoch();
    await this.pool.query(`INSERT INTO forge_restore_operations(id,status,phase,dry_run,target_database,fencing_token,created_by,tenant_id,heartbeat_at) VALUES($1,'RUNNING','PREFLIGHT',false,$2,$3,$4,$5,now())`, [operationId, redactDatabaseUrl(targetDatabaseUrl), String(fence), actor, tenantId]);
    let extracted; let target;
    try {
      await this.createCheckpoint(operationId, 'PREFLIGHT', 'STARTED');
      const archive = await this.backup.verifyBackup({ archivePath, signal });
      extracted = await this.backup.extract(archivePath);
      if (extracted.metadata.format !== 'forge-pg-custom-v1') throw Object.assign(new Error('unsupported backup format'), { code: 'INCOMPATIBLE_BACKUP_FORMAT' });
      const record = await this.pool.query('SELECT artifact_archive_path,artifact_archive_sha256,tenant_id,content_root FROM forge_backup_records WHERE id=$1', [extracted.metadata.backupId]);
      const backupRecord = record.rows[0];
      if (!backupRecord || backupRecord.tenant_id !== tenantId || !backupRecord.artifact_archive_path) throw Object.assign(new Error('backup artifact archive is not authorized for this tenant'), { code: 'RECOVERY_TENANT_MISMATCH' });
      await this.createCheckpoint(operationId, 'PREFLIGHT', 'COMPLETED', { archiveSha256: archive.archiveSha256, manifestSha256: archive.metadataDigest, artifactArchiveSha256: backupRecord.artifact_archive_sha256 });
      target = new Pool({ connectionString: targetDatabaseUrl, max: 2, connectionTimeoutMillis: 5000 });
      await target.query('SELECT 1');
      await this.backup.compatibility(target, extracted.metadata);
      const targetSchema = await schemaFingerprint(target);
      await this.pool.query('UPDATE forge_restore_operations SET target_schema_fingerprint=$2 WHERE id=$1', [operationId, targetSchema]);
      await this.createCheckpoint(operationId, 'COMPATIBILITY', 'COMPLETED', { targetSchemaFingerprint: targetSchema });
      await this.createCheckpoint(operationId, 'RESTORE_DATABASE', 'STARTED');
      await this.backup.runCommand('pg_restore', ['--exit-on-error','--single-transaction','--no-owner','--no-acl','--clean','--if-exists','--dbname',targetDatabaseUrl,extracted.dump], signal);
      await this.createCheckpoint(operationId, 'RESTORE_DATABASE', 'COMPLETED');
      await this.createCheckpoint(operationId, 'ARTIFACT_RESTORE', 'STARTED');
      const artifactResult = await this.artifactArchive.restore({ archive: backupRecord.artifact_archive_path, targetStorage, tenantId, signal });
      const artifactVerification = await this.artifactArchive.verifyRestored({ archive: backupRecord.artifact_archive_path, targetStorage, tenantId, signal });
      await this.pool.query('UPDATE forge_restore_operations SET artifact_restore_status=\'RESTORED\' WHERE id=$1', [operationId]);
      await this.createCheckpoint(operationId, 'ARTIFACT_RESTORE', 'COMPLETED', { artifactResult, artifactVerification });
      await this.createCheckpoint(operationId, 'FENCING', 'STARTED', { recoveryEpoch: fence });
      const diagnostics = await this.backup.reconcile(target, String(fence));
      await this.createCheckpoint(operationId, 'FENCING', 'COMPLETED', diagnostics);
      await this.createCheckpoint(operationId, 'VERIFYING', 'STARTED');
      const verification = await verifyDatabaseInvariants(target, { tenantId });
      const restoredRoot = await this.artifactRootFromTarget(target, tenantId);
      verification.checks.restoredArtifactRoot = restoredRoot;
      verification.checks.manifestArtifactRoot = backupRecord.content_root;
      if (backupRecord.content_root && restoredRoot !== backupRecord.content_root) verification.diagnostics.push({ check: 'artifactRoot', expected: backupRecord.content_root, actual: restoredRoot });
      if (!verification.ok || (backupRecord.content_root && restoredRoot !== backupRecord.content_root)) throw Object.assign(new Error('restored database invariants failed'), { code: 'RESTORE_VERIFICATION_FAILED', diagnostics: verification });
      await this.createCheckpoint(operationId, 'VERIFYING', 'COMPLETED', verification.checks);
      await this.pool.query(`UPDATE forge_restore_operations SET status='SUCCEEDED',phase='VERIFIED',verification_status='PASS',diagnostics=$2::jsonb,completed_at=now() WHERE id=$1`, [operationId, JSON.stringify({ ...diagnostics, artifactResult, artifactVerification, verification })]);
      await this.audit({ tenantId, actor, action: 'RECOVERY_RESTORE_VERIFIED', targetType: 'restore', targetId: operationId, details: { fence, verification } });
      return { id: operationId, status: 'SUCCEEDED', recoveryEpoch: fence, diagnostics, artifactResult, artifactVerification, verification };
    } catch (error) {
      await this.pool.query(`UPDATE forge_restore_operations SET status='FAILED',phase='FAILED',verification_status='FAIL',artifact_restore_status=CASE WHEN artifact_restore_status='PENDING' THEN 'FAILED' ELSE artifact_restore_status END,error_code=$2,error_message=$3,diagnostics=$4::jsonb,completed_at=now() WHERE id=$1`, [operationId, error.code || 'RESTORE_FAILED', error.message, JSON.stringify(error.diagnostics || {})]).catch(() => {});
      await this.createCheckpoint(operationId, 'FAILED', 'FAILED', { code: error.code || 'RESTORE_FAILED' }).catch(() => {});
      await this.audit({ tenantId, actor, action: 'RECOVERY_RESTORE_FAILED', targetType: 'restore', targetId: operationId, outcome: 'FAILED', details: { code: error.code || 'RESTORE_FAILED' } });
      throw error;
    } finally {
      await target?.end?.().catch(() => {});
      if (extracted) await fs.rm(extracted.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async artifactRootFromTarget(target, tenantId) {
    const result = await target.query(`SELECT a.id,a.episode_id,a.version_id,a.content_hash,s.storage_key,s.content_hash AS stored_hash,s.size_bytes FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id LEFT JOIN storage_objects s ON s.artifact_id=a.id WHERE p.tenant_id=$1 ORDER BY a.id`, [tenantId]);
    return merkleRoot(result.rows.map((row) => ({ id: row.id, episodeId: row.episode_id, versionId: row.version_id, contentHash: row.content_hash, storageKey: row.storage_key, storedHash: row.stored_hash, sizeBytes: Number(row.size_bytes || 0) })));
  }
}

module.exports = { RecoveryControlPlane, isolatedTarget };
