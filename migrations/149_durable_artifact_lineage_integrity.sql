BEGIN;

CREATE TABLE IF NOT EXISTS artifact_lineage_edges (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  child_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  parent_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  child_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  parent_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  relation text NOT NULL CHECK (relation IN ('DERIVED_FROM','TRANSCODED_FROM','GENERATED_FROM','PACKAGED_FROM','EXPORTED_FROM','RESTORED_FROM')),
  evidence_digest char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_artifact_id, parent_artifact_id, relation),
  CHECK (child_artifact_id <> parent_artifact_id)
);
CREATE INDEX IF NOT EXISTS artifact_lineage_child_idx ON artifact_lineage_edges(tenant_id, project_id, child_artifact_id, created_at);
CREATE INDEX IF NOT EXISTS artifact_lineage_parent_idx ON artifact_lineage_edges(tenant_id, project_id, parent_artifact_id, created_at);

CREATE OR REPLACE FUNCTION forge_artifact_lineage_guard() RETURNS trigger AS $$
DECLARE child_scope record; parent_scope record; cycle_found boolean;
BEGIN
  SELECT a.id,a.version_id,e.episode_id,e.project_id,p.tenant_id INTO child_scope
    FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
    WHERE a.id=NEW.child_artifact_id FOR SHARE;
  SELECT a.id,a.version_id,e.episode_id,e.project_id,p.tenant_id INTO parent_scope
    FROM artifacts a JOIN episodes e ON e.id=a.episode_id JOIN projects p ON p.id=e.project_id
    WHERE a.id=NEW.parent_artifact_id FOR SHARE;
  IF child_scope.id IS NULL OR parent_scope.id IS NULL THEN RAISE EXCEPTION 'artifact lineage endpoint not found'; END IF;
  IF child_scope.tenant_id <> NEW.tenant_id OR child_scope.project_id <> NEW.project_id
     OR parent_scope.tenant_id <> NEW.tenant_id OR parent_scope.project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'artifact lineage crosses tenant/project boundary';
  END IF;
  IF child_scope.version_id <> NEW.child_version_id OR parent_scope.version_id <> NEW.parent_version_id THEN
    RAISE EXCEPTION 'artifact lineage version does not match artifact';
  END IF;
  IF child_scope.episode_id <> parent_scope.episode_id THEN
    RAISE EXCEPTION 'artifact lineage cannot cross episodes';
  END IF;
  WITH RECURSIVE walk(id) AS (
    SELECT NEW.parent_artifact_id
    UNION
    SELECT e.parent_artifact_id FROM artifact_lineage_edges e JOIN walk w ON w.id=e.child_artifact_id
      WHERE e.tenant_id=NEW.tenant_id AND e.project_id=NEW.project_id
  ) SELECT EXISTS(SELECT 1 FROM walk WHERE id=NEW.child_artifact_id) INTO cycle_found;
  IF cycle_found THEN RAISE EXCEPTION 'artifact lineage cycle rejected'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS artifact_lineage_scope_guard ON artifact_lineage_edges;
CREATE TRIGGER artifact_lineage_scope_guard BEFORE INSERT OR UPDATE ON artifact_lineage_edges
FOR EACH ROW EXECUTE FUNCTION forge_artifact_lineage_guard();

CREATE TABLE IF NOT EXISTS artifact_integrity_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  scan_limit integer NOT NULL CHECK (scan_limit > 0),
  scanned_count bigint NOT NULL DEFAULT 0,
  verified_count bigint NOT NULL DEFAULT 0,
  missing_count bigint NOT NULL DEFAULT 0,
  corrupt_count bigint NOT NULL DEFAULT 0,
  quarantined_count bigint NOT NULL DEFAULT 0,
  repaired_count bigint NOT NULL DEFAULT 0,
  cursor_created_at timestamptz,
  cursor_artifact_id text,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS artifact_integrity_runs_scope_idx ON artifact_integrity_runs(tenant_id, project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS artifact_integrity_findings (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES artifact_integrity_runs(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  object_id text,
  finding text NOT NULL CHECK (finding IN ('VERIFIED','MISSING','CORRUPT','METADATA_MISMATCH','BROKEN_LINEAGE','REPAIRED')),
  expected_sha256 char(64),
  observed_sha256 char(64),
  expected_size_bytes bigint,
  observed_size_bytes bigint,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','QUARANTINED','REPAIRED','IGNORED')),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(run_id, artifact_id, finding)
);
CREATE INDEX IF NOT EXISTS artifact_integrity_findings_open_idx ON artifact_integrity_findings(tenant_id, project_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact_integrity_repairs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  finding_id text REFERENCES artifact_integrity_findings(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('REBUILD_LEDGER_REF','REBUILD_STORAGE_METADATA','RESTORE_FROM_RECOVERY','RETRY_VERIFY','QUARANTINE')),
  state text NOT NULL CHECK (state IN ('REQUESTED','APPROVED','RUNNING','SUCCEEDED','FAILED','QUARANTINED','CANCELLED')),
  idempotency_key text NOT NULL,
  actor text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS artifact_integrity_repairs_scope_idx ON artifact_integrity_repairs(tenant_id, project_id, state, created_at DESC);

COMMIT;
