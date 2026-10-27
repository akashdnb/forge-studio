-- Immutable artifact lifecycle ledger. This never mutates artifact content or provenance rows.
BEGIN;

ALTER TABLE storage_objects DROP CONSTRAINT IF EXISTS storage_objects_status_check;
ALTER TABLE storage_objects ADD CONSTRAINT storage_objects_status_check CHECK (status IN ('READY','CORRUPT','MISSING','DELETED'));

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

-- The lifecycle row is the serialization point for artifact references. Reference writers
-- acquire the same row lock and reject new reachability once deletion is pending/deleted.
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

CREATE OR REPLACE FUNCTION forge_guard_artifact_reference() RETURNS trigger AS $$
DECLARE blocked boolean;
BEGIN
  IF TG_TABLE_NAME = 'version_dependencies' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l JOIN artifacts a ON a.id=l.artifact_id WHERE l.state IN ('DELETION_PENDING','DELETED') AND a.version_id IN (NEW.version_id, NEW.depends_on_version_id)) INTO blocked;
  ELSIF TG_TABLE_NAME = 'approvals' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l JOIN artifacts a ON a.id=l.artifact_id WHERE l.state IN ('DELETION_PENDING','DELETED') AND a.version_id=NEW.target_version_id) INTO blocked;
  ELSIF TG_TABLE_NAME = 'qa_results' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l JOIN artifacts a ON a.id=l.artifact_id WHERE l.state IN ('DELETION_PENDING','DELETED') AND (a.version_id=NEW.version_id OR a.id=NEW.artifact_id)) INTO blocked;
  ELSIF TG_TABLE_NAME = 'publish_runs' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l JOIN artifacts a ON a.id=l.artifact_id WHERE l.state IN ('DELETION_PENDING','DELETED') AND (a.version_id IN (NEW.render_version_id,NEW.package_version_id) OR a.id IN (NEW.render_artifact_id,NEW.package_artifact_id))) INTO blocked;
  ELSIF TG_TABLE_NAME = 'episode_packages' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l JOIN artifacts a ON a.id=l.artifact_id WHERE l.state IN ('DELETION_PENDING','DELETED') AND (a.version_id IN (NEW.final_media_version_id,NEW.version_id) OR a.id=NEW.final_media_artifact_id)) INTO blocked;
  ELSIF TG_TABLE_NAME = 'episodes' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l JOIN artifacts a ON a.id=l.artifact_id WHERE l.state IN ('DELETION_PENDING','DELETED') AND (a.id IN (NEW.current_render_id,NEW.approved_render_id) OR NEW.current_versions::text LIKE '%'||a.version_id||'%')) INTO blocked;
  ELSIF TG_TABLE_NAME = 'artifacts' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l JOIN artifacts a ON a.id=l.artifact_id WHERE l.state IN ('DELETION_PENDING','DELETED') AND NEW.input_version_ids ? a.version_id) INTO blocked;
  ELSIF TG_TABLE_NAME = 'forge_jobs' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l WHERE l.state IN ('DELETION_PENDING','DELETED') AND (NEW.payload::text LIKE '%'||l.artifact_id||'%' OR NEW.result::text LIKE '%'||l.artifact_id||'%')) INTO blocked;
  ELSIF TG_TABLE_NAME = 'provider_runs' THEN
    SELECT EXISTS (SELECT 1 FROM artifact_lifecycle_records l WHERE l.state IN ('DELETION_PENDING','DELETED') AND (NEW.input_version_ids::text LIKE '%'||(SELECT a.version_id FROM artifacts a WHERE a.id=l.artifact_id)||'%' OR NEW.result_artifact_ids ? l.artifact_id)) INTO blocked;
  END IF;
  IF blocked THEN RAISE EXCEPTION 'artifact reference is blocked by lifecycle state' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_lifecycle_guard_version_dependencies ON version_dependencies;
CREATE TRIGGER artifact_lifecycle_guard_version_dependencies BEFORE INSERT OR UPDATE ON version_dependencies FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();
DROP TRIGGER IF EXISTS artifact_lifecycle_guard_approvals ON approvals;
CREATE TRIGGER artifact_lifecycle_guard_approvals BEFORE INSERT OR UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();
DROP TRIGGER IF EXISTS artifact_lifecycle_guard_qa_results ON qa_results;
CREATE TRIGGER artifact_lifecycle_guard_qa_results BEFORE INSERT OR UPDATE ON qa_results FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();
DROP TRIGGER IF EXISTS artifact_lifecycle_guard_publish_runs ON publish_runs;
CREATE TRIGGER artifact_lifecycle_guard_publish_runs BEFORE INSERT OR UPDATE ON publish_runs FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();
DROP TRIGGER IF EXISTS artifact_lifecycle_guard_episode_packages ON episode_packages;
CREATE TRIGGER artifact_lifecycle_guard_episode_packages BEFORE INSERT OR UPDATE ON episode_packages FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();
DROP TRIGGER IF EXISTS artifact_lifecycle_guard_episodes ON episodes;
CREATE TRIGGER artifact_lifecycle_guard_episodes BEFORE INSERT OR UPDATE ON episodes FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();
DROP TRIGGER IF EXISTS artifact_lifecycle_guard_artifact_refs ON artifacts;
CREATE TRIGGER artifact_lifecycle_guard_artifact_refs BEFORE INSERT OR UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();
DROP TRIGGER IF EXISTS artifact_lifecycle_guard_jobs ON forge_jobs;
CREATE TRIGGER artifact_lifecycle_guard_jobs BEFORE INSERT OR UPDATE ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();
DROP TRIGGER IF EXISTS artifact_lifecycle_guard_provider_runs ON provider_runs;
CREATE TRIGGER artifact_lifecycle_guard_provider_runs BEFORE INSERT OR UPDATE ON provider_runs FOR EACH ROW EXECUTE FUNCTION forge_guard_artifact_reference();

COMMIT;
