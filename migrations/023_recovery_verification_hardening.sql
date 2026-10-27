BEGIN;
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS schema_fingerprint char(64);
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS manifest_version integer NOT NULL DEFAULT 1;
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS content_root char(64);
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS encryption_key_id text;
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS integrity_status text NOT NULL DEFAULT 'VERIFIED' CHECK (integrity_status IN ('PENDING','VERIFIED','FAILED','EXPIRED'));
ALTER TABLE forge_backup_records ADD COLUMN IF NOT EXISTS source_release_id text;
CREATE INDEX IF NOT EXISTS forge_backup_records_tenant_created_idx ON forge_backup_records(tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS forge_backup_records_archive_sha_idx ON forge_backup_records(archive_sha256) WHERE archive_sha256 IS NOT NULL;
ALTER TABLE forge_restore_operations ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE forge_restore_operations ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0);
ALTER TABLE forge_restore_operations ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE forge_restore_operations ADD COLUMN IF NOT EXISTS checkpoint_seq integer NOT NULL DEFAULT 0 CHECK (checkpoint_seq >= 0);
ALTER TABLE forge_restore_operations ADD COLUMN IF NOT EXISTS target_schema_fingerprint char(64);
ALTER TABLE forge_restore_operations ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','PASS','FAIL'));
CREATE INDEX IF NOT EXISTS forge_restore_operations_tenant_idx ON forge_restore_operations(tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS forge_restore_operations_active_idx ON forge_restore_operations(backup_id, target_database, status) WHERE status = 'RUNNING';
CREATE TABLE IF NOT EXISTS forge_recovery_checkpoints (
  operation_id text NOT NULL REFERENCES forge_restore_operations(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  phase text NOT NULL,
  status text NOT NULL CHECK (status IN ('STARTED','COMPLETED','FAILED','CANCELLED')),
  checkpoint_hash char(64) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(operation_id, sequence)
);
CREATE INDEX IF NOT EXISTS forge_recovery_checkpoints_phase_idx ON forge_recovery_checkpoints(phase, created_at DESC);
CREATE TABLE IF NOT EXISTS forge_recovery_epoch (id boolean PRIMARY KEY DEFAULT true CHECK (id), epoch bigint NOT NULL CHECK (epoch >= 0), updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO forge_recovery_epoch(id, epoch) VALUES(true, 0) ON CONFLICT (id) DO NOTHING;
CREATE OR REPLACE FUNCTION forge_next_recovery_epoch() RETURNS bigint AS $$
DECLARE next_epoch bigint;
BEGIN
  UPDATE forge_recovery_epoch SET epoch = epoch + 1, updated_at = now() WHERE id = true RETURNING epoch INTO next_epoch;
  RETURN next_epoch;
END;
$$ LANGUAGE plpgsql;
COMMIT;
