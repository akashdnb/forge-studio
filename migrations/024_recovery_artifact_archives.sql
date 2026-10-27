BEGIN;
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS artifact_archive_path text;
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS artifact_archive_sha256 char(64);
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS artifact_archive_bytes bigint CHECK (artifact_archive_bytes IS NULL OR artifact_archive_bytes >= 0);
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS artifact_archive_format text NOT NULL DEFAULT 'forge-artifacts-v1';
ALTER TABLE forge_restore_operations ADD COLUMN IF NOT EXISTS artifact_restore_status text NOT NULL DEFAULT 'PENDING' CHECK (artifact_restore_status IN ('PENDING','RESTORED','FAILED','SKIPPED'));
CREATE UNIQUE INDEX IF NOT EXISTS forge_backup_records_artifact_archive_sha_idx ON forge_backup_records(artifact_archive_sha256) WHERE artifact_archive_sha256 IS NOT NULL;
COMMIT;
