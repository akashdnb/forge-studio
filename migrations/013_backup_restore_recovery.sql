BEGIN;

CREATE TABLE IF NOT EXISTS forge_backup_records (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','EXPIRED')),
  backup_format text NOT NULL DEFAULT 'forge-pg-custom-v1',
  database_name text,
  schema_fingerprint char(64),
  migration_fingerprint char(64),
  server_version text,
  wal_lsn text,
  snapshot_at timestamptz,
  backup_path text,
  metadata_path text,
  manifest_sha256 char(64),
  archive_sha256 char(64),
  bytes bigint CHECK (bytes IS NULL OR bytes >= 0),
  artifact_count integer NOT NULL DEFAULT 0 CHECK (artifact_count >= 0),
  verified_artifact_count integer NOT NULL DEFAULT 0 CHECK (verified_artifact_count >= 0),
  retention_expires_at timestamptz,
  created_by text NOT NULL DEFAULT 'system',
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_backup_records_status_idx ON forge_backup_records(status, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_backup_records_retention_idx ON forge_backup_records(retention_expires_at) WHERE retention_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS forge_restore_operations (
  id text PRIMARY KEY,
  backup_id text,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  phase text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  target_database text,
  fencing_token text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_restore_operations_status_idx ON forge_restore_operations(status, created_at DESC);

COMMIT;
