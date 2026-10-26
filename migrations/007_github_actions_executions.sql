BEGIN;

CREATE TABLE IF NOT EXISTS forge_execution_runs (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES forge_jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt >= 1),
  backend text NOT NULL CHECK (backend IN ('github-actions','local')),
  worker_type text NOT NULL,
  workflow_name text NOT NULL,
  correlation_id text NOT NULL UNIQUE,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'DISPATCHING' CHECK (status IN ('DISPATCHING','QUEUED','IN_PROGRESS','COMPLETED','FAILED','CANCELLED','TIMED_OUT','STALE')),
  github_run_id text,
  github_run_attempt integer,
  workflow_ref text,
  runner_profile text,
  input_manifest_uri text,
  output_manifest_uri text,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_reconciled_at timestamptz,
  heartbeat_at timestamptz,
  timeout_at timestamptz,
  failure_code text,
  failure_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, attempt),
  UNIQUE (job_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS forge_execution_active_idx
  ON forge_execution_runs(status, updated_at)
  WHERE status IN ('DISPATCHING','QUEUED','IN_PROGRESS');
CREATE INDEX IF NOT EXISTS forge_execution_job_idx
  ON forge_execution_runs(job_id, attempt DESC);
CREATE INDEX IF NOT EXISTS forge_execution_github_run_idx
  ON forge_execution_runs(github_run_id)
  WHERE github_run_id IS NOT NULL;

COMMIT;
