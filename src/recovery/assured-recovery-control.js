const crypto = require('node:crypto');
const { Pool } = require('pg');
const { RecoveryControlPlane } = require('./recovery-control');
const { canonicalize, sha256, verifyDatabaseInvariants } = require('./recovery-verifier');
const { allocateGeneration, recordIntegrity, coverage, rpo, targetHash } = require('./recovery-assurance');
const { retryBounded } = require('./recovery-retry');
const { redactDatabaseUrl } = require('./backup-service');

class AssuredRecoveryControlPlane extends RecoveryControlPlane {
  constructor({ productionStorage, ...options }) {
    super(options);
    this.productionStorage = productionStorage;
  }

  async createBackup(options = {}) {
    const result = await super.createBackup(options);
    if (result.dryRun) return result;
    const generation = await allocateGeneration(this.pool, options.tenantId);
    const cover = await coverage(this.pool);
    const rpoSeconds = await rpo(this.pool, result.snapshotAt || new Date().toISOString());
    const keyVersion = process.env.FORGE_BACKUP_ENCRYPTION_KEY_ID || 'default';
    await this.pool.query(`UPDATE forge_backup_records SET backup_generation=$2,coverage_status=$3,dependency_complete=$4,encryption_algorithm=$5,key_version=$6,last_known_good=true,rpo_seconds=$7 WHERE id=$1`, [result.id, generation, cover.status, cover.dependencyComplete, 'AES-256-GCM', keyVersion, rpoSeconds]);
    await this.pool.query(`UPDATE forge_backup_records SET last_known_good=false WHERE tenant_id=$1 AND id<>$2 AND status='SUCCEEDED'`, [options.tenantId, result.id]);
    const payload = { version: 1, backupId: result.id, tenantId: options.tenantId, generation, archiveSha256: result.archiveSha256, manifestSha256: result.manifestSha256, artifactArchiveSha256: result.artifactArchiveSha256, contentRoot: result.contentRoot, schemaFingerprint: result.schemaFingerprint, coverage: cover, encryption: { algorithm: 'AES-256-GCM', keyVersion }, rpoSeconds };
    const signed = await recordIntegrity(this.pool, { tenantId: options.tenantId, backupId: result.id, generation, evidenceType: 'BACKUP_COMMIT', payload });
    await this.pool.query('UPDATE forge_backup_records SET signed_integrity_id=$2 WHERE id=$1', [result.id, signed.id]);
    return { ...result, generation, coverage: cover, rpoSeconds, signedIntegrityId: signed.id, signatureKeyId: signed.keyId };
  }

  async requestProductionRestoreApproval({ tenantId, actor, backupId, targetDatabaseUrl, expiresMinutes = 30, reason = 'disaster-recovery' } = {}) {
    await this.assertTenant(tenantId);
    const production = process.env.FORGE_PRODUCTION_DATABASE_URL;
    if (!production || targetDatabaseUrl !== production) throw Object.assign(new Error('production target must match FORGE_PRODUCTION_DATABASE_URL exactly'), { code: 'PRODUCTION_TARGET_MISMATCH' });
    const backup = await this.pool.query(`SELECT id,tenant_id,status,integrity_status,signed_integrity_id,backup_generation,manifest_sha256,archive_sha256,artifact_archive_sha256,content_root FROM forge_backup_records WHERE id=$1`, [backupId]);
    const row = backup.rows[0];
    if (!row || row.tenant_id !== tenantId || row.status !== 'SUCCEEDED' || row.integrity_status !== 'VERIFIED' || !row.signed_integrity_id) throw Object.assign(new Error('backup is not an eligible verified recovery point'), { code: 'BACKUP_NOT_ELIGIBLE' });
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + Math.max(1, Number(expiresMinutes) || 30) * 60000);
    const evidence = { version: 1, approvalId: id, tenantId, backupId, generation: row.backup_generation, targetDatabaseHash: targetHash(targetDatabaseUrl), actor, reason, expiresAt: expiresAt.toISOString(), archiveSha256: row.archive_sha256, manifestSha256: row.manifest_sha256, artifactArchiveSha256: row.artifact_archive_sha256, contentRoot: row.content_root };
    const evidenceHash = sha256(canonicalize(evidence));
    await this.pool.query(`INSERT INTO forge_recovery_restore_approvals(id,tenant_id,backup_id,target_database_hash,purpose,status,approved_by,expires_at,evidence_hash) VALUES($1,$2,$3,$4,'PRODUCTION_RESTORE','APPROVED',$5,$6,$7)`, [id, tenantId, backupId, targetHash(targetDatabaseUrl), actor, expiresAt, evidenceHash]);
    await this.audit({ tenantId, actor, action: 'RECOVERY_PRODUCTION_RESTORE_APPROVED', targetType: 'restore_approval', targetId: id, details: { backupId, generation: row.backup_generation, expiresAt: expiresAt.toISOString(), evidenceHash } });
    return { approvalId: id, status: 'APPROVED', backupId, generation: row.backup_generation, expiresAt: expiresAt.toISOString(), evidenceHash };
  }

  async assertProductionApproval({ tenantId, backupId, targetDatabaseUrl, approvalId }) {
    if (!approvalId) throw Object.assign(new Error('operator approval is required for production restoration'), { code: 'RECOVERY_APPROVAL_REQUIRED' });
    const result = await this.pool.query(`SELECT * FROM forge_recovery_restore_approvals WHERE id=$1 AND tenant_id=$2 AND backup_id=$3 AND target_database_hash=$4 AND purpose='PRODUCTION_RESTORE' AND status='APPROVED' AND expires_at>now()`, [approvalId, tenantId, backupId, targetHash(targetDatabaseUrl)]);
    if (!result.rowCount) throw Object.assign(new Error('production restore approval is missing, expired, revoked, or mismatched'), { code: 'RECOVERY_APPROVAL_INVALID' });
    await this.pool.query(`UPDATE forge_recovery_restore_approvals SET status='CONSUMED' WHERE id=$1 AND status='APPROVED'`, [approvalId]);
    return result.rows[0];
  }

  async restoreAndVerify(options = {}) {
    if (!options.productionRestore) return super.restoreAndVerify(options);
    await this.assertTenant(options.tenantId);
    if (process.env.FORGE_ENABLE_PRODUCTION_RESTORE !== 'true') throw Object.assign(new Error('production restore is disabled; set FORGE_ENABLE_PRODUCTION_RESTORE=true only during an approved cutover'), { code: 'PRODUCTION_RESTORE_DISABLED' });
    if (!process.env.FORGE_PRODUCTION_DATABASE_URL || options.targetDatabaseUrl !== process.env.FORGE_PRODUCTION_DATABASE_URL) throw Object.assign(new Error('production restore target mismatch'), { code: 'PRODUCTION_TARGET_MISMATCH' });
    if (!this.artifactArchive || !this.productionStorage) throw Object.assign(new Error('production artifact storage is required'), { code: 'RECOVERY_PRODUCTION_STORAGE_REQUIRED' });
    const approval = await this.assertProductionApproval(options);
    const startedAt = Date.now(); let extracted; let target; let operationId;
    try {
      const archive = await this.backup.verifyBackup({ archivePath: options.archivePath, signal: options.signal });
      extracted = await this.backup.extract(options.archivePath);
      const backupId = extracted.metadata.backupId;
      const record = await this.loadAuthorizedRecoveryPoint(options.tenantId, backupId);
      const fence = await this.recoveryEpoch();
      operationId = crypto.randomUUID();
      await this.pool.query(`INSERT INTO forge_restore_operations(id,backup_id,status,phase,dry_run,target_database,fencing_token,created_by,tenant_id,heartbeat_at,approval_id,production_restore,started_at) VALUES($1,$2,'RUNNING','PRODUCTION_PREFLIGHT',false,$3,$4,$5,$6,now(),$7,true,now())`, [operationId, backupId, redactDatabaseUrl(options.targetDatabaseUrl), String(fence), options.actor, options.tenantId, approval.id]);
      await this.createCheckpoint(operationId, 'PRODUCTION_PREFLIGHT', 'COMPLETED', { archiveSha256: archive.archiveSha256, manifestSha256: archive.metadataDigest, approvalId: approval.id });
      target = new Pool({ connectionString: options.targetDatabaseUrl, max: 4, connectionTimeoutMillis: 5000 });
      await target.query('SELECT 1');
      await this.backup.compatibility(target, extracted.metadata);
      await this.createCheckpoint(operationId, 'PRODUCTION_COMPATIBILITY', 'COMPLETED');
      await retryBounded(() => this.backup.runCommand('pg_restore', ['--exit-on-error','--single-transaction','--no-owner','--no-acl','--clean','--if-exists','--dbname',options.targetDatabaseUrl,extracted.dump], options.signal), { signal: options.signal, maxAttempts: Number(process.env.FORGE_RECOVERY_RETRY_ATTEMPTS || 3) });
      await this.createCheckpoint(operationId, 'PRODUCTION_DATABASE_RESTORE', 'COMPLETED');
      const artifactResult = await retryBounded(() => this.artifactArchive.restore({ archive: record.artifact_archive_path, targetStorage: this.productionStorage, tenantId: null, signal: options.signal }), { signal: options.signal, maxAttempts: Number(process.env.FORGE_RECOVERY_RETRY_ATTEMPTS || 3) });
      const artifactVerification = await this.artifactArchive.verifyRestored({ archive: record.artifact_archive_path, targetStorage: this.productionStorage, tenantId: null, signal: options.signal });
      const diagnostics = await this.backup.reconcile(target, String(fence));
      const verification = await verifyDatabaseInvariants(target, { tenantId: options.tenantId });
      if (!verification.ok) throw Object.assign(new Error('production restore invariant verification failed'), { code: 'RESTORE_VERIFICATION_FAILED', diagnostics: verification });
      const rtoMs = Date.now() - startedAt;
      await this.pool.query(`UPDATE forge_restore_operations SET status='SUCCEEDED',phase='PRODUCTION_VERIFIED',verification_status='PASS',artifact_restore_status='RESTORED',rto_ms=$2,rpo_seconds=$3,diagnostics=$4::jsonb,completed_at=now() WHERE id=$1`, [operationId, rtoMs, Math.max(0, Math.round((Date.now() - new Date(extracted.metadata.snapshot.snapshot_at).getTime()) / 1000)), JSON.stringify({ diagnostics, artifactResult, artifactVerification, verification, approvalId: approval.id })]);
      await this.audit({ tenantId: options.tenantId, actor: options.actor, action: 'RECOVERY_PRODUCTION_RESTORE_VERIFIED', targetType: 'restore', targetId: operationId, details: { approvalId: approval.id, rtoMs, diagnostics, verification } });
      return { id: operationId, status: 'SUCCEEDED', productionRestore: true, approvalId: approval.id, recoveryEpoch: fence, rtoMs, diagnostics, artifactResult, artifactVerification, verification };
    } catch (error) {
      if (operationId) { await this.pool.query(`UPDATE forge_restore_operations SET status='FAILED',phase='FAILED',verification_status='FAIL',error_code=$2,error_message=$3,diagnostics=$4::jsonb,completed_at=now() WHERE id=$1`, [operationId, error.code || 'PRODUCTION_RESTORE_FAILED', error.message, JSON.stringify(error.diagnostics || {})]).catch(() => {}); await this.createCheckpoint(operationId, 'FAILED', 'FAILED', { code: error.code || 'PRODUCTION_RESTORE_FAILED' }).catch(() => {}); }
      throw error;
    } finally { await target?.end?.().catch(() => {}); if (extracted) await require('node:fs/promises').rm(extracted.dir, { recursive: true, force: true }).catch(() => {}); }
  }
}

module.exports = { AssuredRecoveryControlPlane };
