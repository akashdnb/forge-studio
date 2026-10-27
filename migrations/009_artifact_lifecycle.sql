-- Immutable artifact lifecycle ledger. This never mutates artifact content or provenance rows.
BEGIN;

CREATE TABLE IF NOT EXISTS artifact_lifecycle_records (
  artifact_id text PRIMARY KEY REFERENCES artifacts(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'RETAINED' CHECK (state IN ('RETAINED','QUARANTINED','DELETION_PENDING','DELETED','PROTECTED')),
  reference_count integer NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
  protected_reason text,
  candidate_at timestamptz,
  quarantine_at timestamptz,
  deletion_pending_at timestamptz,
  deleted_at timestamptz,
  last_evaluated_at timestamptz,
  last_run_id text,
  last_error jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_lifecycle_state_idx ON artifact_lifecycle_records(state, candidate_at, updated_at);
CREATE INDEX IF NOT EXISTS artifact_lifecycle_project_state_idx ON artifact_lifecycle_records(project_id, state, updated_at);

CREATE TABLE IF NOT EXISTS artifact_lifecycle_runs (
  id text PRIMARY KEY,
  worker_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','SKIPPED_CONCURRENT')),
  mode text NOT NULL CHECK (mode IN ('ENFORCE','DRY_RUN')),
  reason text NOT NULL,
  scan_limit integer NOT NULL CHECK (scan_limit > 0),
  scanned_count integer NOT NULL DEFAULT 0,
  protected_count integer NOT NULL DEFAULT 0,
  quarantined_count integer NOT NULL DEFAULT 0,
  deletion_pending_count integer NOT NULL DEFAULT 0,
  deleted_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS artifact_lifecycle_runs_started_idx ON artifact_lifecycle_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS artifact_lifecycle_events (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES artifact_lifecycle_runs(id) ON DELETE RESTRICT,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('EVALUATED','PROTECTED','QUARANTINED','DELETION_PENDING','DELETED','DELETE_RETRY','DELETE_FAILED','SKIPPED','DRY_RUN')),
  from_state text,
  to_state text,
  reference_count integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_lifecycle_events_artifact_idx ON artifact_lifecycle_events(artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS artifact_lifecycle_events_run_idx ON artifact_lifecycle_events(run_id, created_at);

CREATE TABLE IF NOT EXISTS artifact_holds (
  id text PRIMARY KEY,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  hold_type text NOT NULL CHECK (hold_type IN ('LEGAL','SAFETY','RECOVERY','MANUAL')),
  reason text NOT NULL,
  expires_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS artifact_holds_active_idx ON artifact_holds(artifact_id, released_at, expires_at);

-- Once an object is deletion-pending/deleted, new artifact rows may not reuse it.
-- This prevents a late writer from racing a provider-side delete.
CREATE OR REPLACE FUNCTION forge_guard_artifact_lifecycle() RETURNS trigger AS $$
DECLARE lifecycle_state text;
BEGIN
  SELECT state INTO lifecycle_state FROM artifact_lifecycle_records WHERE artifact_id = NEW.id FOR UPDATE;
  IF lifecycle_state IN ('DELETION_PENDING','DELETED') THEN
    RAISE EXCEPTION 'artifact is no longer writable: %', NEW.id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS artifact_lifecycle_guard ON artifacts;
CREATE TRIGGER artifact_lifecycle_guard
BEFORE UPDATE ON artifacts
FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_lifecycle();

COMMIT;
