BEGIN;
ALTER TABLE forge_execution_runs
  DROP CONSTRAINT IF EXISTS forge_execution_runs_backend_check;
ALTER TABLE forge_execution_runs
  ADD CONSTRAINT forge_execution_runs_backend_check CHECK (backend IN ('github-actions','public-github-actions','local'));
ALTER TABLE forge_execution_runs
  ADD COLUMN IF NOT EXISTS release_epoch bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS runner_source_sha char(40),
  ADD COLUMN IF NOT EXISTS security_policy_version text NOT NULL DEFAULT 'forge-public-runner-v2',
  ADD COLUMN IF NOT EXISTS callback_nonce char(64),
  ADD COLUMN IF NOT EXISTS fenced_at timestamptz,
  ADD COLUMN IF NOT EXISTS fence_reason text,
  ADD COLUMN IF NOT EXISTS result_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS result_signature text;

CREATE UNIQUE INDEX IF NOT EXISTS forge_execution_callback_nonce_uq ON forge_execution_runs(callback_nonce) WHERE callback_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_execution_release_epoch_idx ON forge_execution_runs(release_epoch,status,updated_at);
CREATE INDEX IF NOT EXISTS forge_execution_runner_source_idx ON forge_execution_runs(runner_source_sha,status,updated_at) WHERE runner_source_sha IS NOT NULL;

CREATE TABLE IF NOT EXISTS forge_runner_security_events (
  id bigserial PRIMARY KEY,
  execution_id text REFERENCES forge_execution_runs(id) ON DELETE SET NULL,
  job_id text REFERENCES forge_jobs(id) ON DELETE SET NULL,
  project_id text,
  tenant_key text,
  event_code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO','WARN','HIGH','CRITICAL')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_runner_security_events_lookup_idx ON forge_runner_security_events(tenant_key,project_id,event_code,created_at DESC);
CREATE INDEX IF NOT EXISTS forge_runner_security_events_execution_idx ON forge_runner_security_events(execution_id,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_runner_security_counters (
  bucket_start timestamptz NOT NULL,
  event_code text NOT NULL,
  tenant_key text NOT NULL DEFAULT '',
  count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(bucket_start,event_code,tenant_key)
);

CREATE OR REPLACE FUNCTION forge_fence_public_execution(p_execution_id text, p_reason text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE forge_execution_runs
     SET status = CASE WHEN status IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT','STALE') THEN status ELSE 'STALE' END,
         fenced_at = COALESCE(fenced_at, now()),
         fence_reason = COALESCE(fence_reason, p_reason),
         updated_at = now()
   WHERE id = p_execution_id;
END;
$$;
COMMIT;
