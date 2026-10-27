BEGIN;
ALTER TABLE forge_execution_runs
  ADD COLUMN IF NOT EXISTS project_id text,
  ADD COLUMN IF NOT EXISTS tenant_key text,
  ADD COLUMN IF NOT EXISTS attempt_id text,
  ADD COLUMN IF NOT EXISTS manifest_version text,
  ADD COLUMN IF NOT EXISTS manifest_hash text,
  ADD COLUMN IF NOT EXISTS manifest_signature text,
  ADD COLUMN IF NOT EXISTS manifest_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS result_hash text,
  ADD COLUMN IF NOT EXISTS result_artifact_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS callback_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS runner_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS capacity_class text;
CREATE UNIQUE INDEX IF NOT EXISTS forge_execution_attempt_id_uq ON forge_execution_runs(attempt_id) WHERE attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_execution_tenant_active_idx ON forge_execution_runs(tenant_key,status,updated_at) WHERE status IN ('DISPATCHING','QUEUED','IN_PROGRESS');
CREATE INDEX IF NOT EXISTS forge_execution_manifest_expiry_idx ON forge_execution_runs(manifest_expires_at) WHERE manifest_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_execution_capacity_idx ON forge_execution_runs(capacity_class,status,updated_at) WHERE status IN ('DISPATCHING','QUEUED','IN_PROGRESS');
COMMIT;
