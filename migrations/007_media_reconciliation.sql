-- Durable, auditable reconciliation state. Reconciliation never mutates immutable
-- artifact/version rows; it records deterministic repairs and diagnostics instead.
BEGIN;
CREATE TABLE IF NOT EXISTS forge_reconciliation_runs (
  id text PRIMARY KEY,
  worker_id text NOT NULL,
  scope text NOT NULL DEFAULT 'media',
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  scanned_count integer NOT NULL DEFAULT 0,
  repaired_count integer NOT NULL DEFAULT 0,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS forge_reconciliation_runs_started_idx ON forge_reconciliation_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS forge_reconciliation_repairs (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES forge_reconciliation_runs(id) ON DELETE RESTRICT,
  fingerprint char(64) NOT NULL,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  artifact_id text REFERENCES artifacts(id) ON DELETE RESTRICT,
  action text NOT NULL,
  from_state text,
  to_state text,
  severity text NOT NULL CHECK (severity IN ('INFO','RECOVERABLE','PERMANENT','CONFLICT')),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(fingerprint)
);
CREATE INDEX IF NOT EXISTS forge_reconciliation_repairs_job_idx ON forge_reconciliation_repairs(job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_reconciliation_repairs_artifact_idx ON forge_reconciliation_repairs(artifact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS forge_jobs_reconciliation_scan_idx
  ON forge_jobs(status, updated_at DESC, finished_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_reconciliation_scan_idx
  ON artifacts(episode_id, kind, version_id, created_at DESC);
COMMIT;
