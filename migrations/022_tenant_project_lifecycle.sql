BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_lifecycle_state_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_lifecycle_state_check CHECK (lifecycle_state IN ('ACTIVE','SUSPENDED','ARCHIVED','DELETION_REQUESTED','DELETION_IN_PROGRESS','DELETED','LEGAL_HOLD','SAFETY_HOLD'));
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_lifecycle_state_check;
ALTER TABLE projects ADD CONSTRAINT projects_lifecycle_state_check CHECK (lifecycle_state IN ('ACTIVE','SUSPENDED','ARCHIVED','DELETION_REQUESTED','DELETION_IN_PROGRESS','DELETED','LEGAL_HOLD','SAFETY_HOLD'));
CREATE INDEX IF NOT EXISTS tenants_lifecycle_idx ON tenants(lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS projects_tenant_lifecycle_idx ON projects(tenant_id, lifecycle_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS tenant_retention_policies (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1,
  policy jsonb NOT NULL DEFAULT '{"defaultDays":365,"artifactDays":90,"jobDays":30,"eventDays":730}'::jsonb,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lifecycle_holds (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('LEGAL','SAFETY','EXCEPTION')),
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  released_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS lifecycle_holds_scope_idx ON lifecycle_holds(tenant_id, project_id, active);

CREATE TABLE IF NOT EXISTS deletion_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  reason text NOT NULL,
  confirmation_hash char(64) NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','CONFIRMED','PLANNED','RUNNING','BLOCKED','CANCELLED','COMPLETED','FAILED')),
  plan_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deletion_requests_scope_idx ON deletion_requests(tenant_id, project_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS deletion_plans (
  id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE REFERENCES deletion_requests(id) ON DELETE RESTRICT,
  revision bigint NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('DRY_RUN','READY','BLOCKED','RUNNING','COMPLETED','FAILED')),
  target_count integer NOT NULL DEFAULT 0,
  eligible_count integer NOT NULL DEFAULT 0,
  blocked_count integer NOT NULL DEFAULT 0,
  impact jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint char(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS deletion_plan_items (
  id bigserial PRIMARY KEY,
  plan_id text NOT NULL REFERENCES deletion_plans(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  project_id text,
  external_ref text,
  action text NOT NULL CHECK (action IN ('DELETE','QUARANTINE','PRESERVE','BLOCK')),
  reason text NOT NULL,
  dependency_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','BLOCKED','FAILED','SKIPPED')),
  last_error jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS deletion_plan_items_ready_idx ON deletion_plan_items(plan_id, status, ordinal);

CREATE TABLE IF NOT EXISTS deletion_audit_evidence (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL REFERENCES deletion_requests(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  project_id text,
  actor text NOT NULL,
  event text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deletion_audit_evidence_scope_idx ON deletion_audit_evidence(tenant_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lifecycle_reconciliation (
  id text PRIMARY KEY,
  tenant_id text,
  project_id text,
  run_at timestamptz NOT NULL DEFAULT now(),
  orphan_count integer NOT NULL DEFAULT 0,
  retention_drift_count integer NOT NULL DEFAULT 0,
  blocked_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Preserve immutable evidence while allowing lifecycle roots to disappear. Historical audit rows are retained with a null resource pointer.
DO $$ BEGIN
  ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_project_id_fkey;
  ALTER TABLE audit_events ADD CONSTRAINT audit_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE security_audit_events DROP CONSTRAINT IF EXISTS security_audit_events_project_id_fkey;
  ALTER TABLE security_audit_events ADD CONSTRAINT security_audit_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE deletion_requests DROP CONSTRAINT IF EXISTS deletion_requests_project_id_fkey;
  ALTER TABLE deletion_requests ADD CONSTRAINT deletion_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE lifecycle_holds DROP CONSTRAINT IF EXISTS lifecycle_holds_project_id_fkey;
  ALTER TABLE lifecycle_holds ADD CONSTRAINT lifecycle_holds_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

CREATE OR REPLACE FUNCTION forge_lifecycle_guard_job() RETURNS trigger AS $$
DECLARE s text; ts text;
BEGIN
  IF NEW.project_id IS NULL THEN RETURN NEW; END IF;
  SELECT lifecycle_state, tenant_id INTO s, ts FROM projects WHERE id=NEW.project_id FOR SHARE;
  IF s IS NULL THEN RAISE EXCEPTION 'project not found for job'; END IF;
  IF s <> 'ACTIVE' THEN RAISE EXCEPTION 'project lifecycle blocks new work: %', s; END IF;
  IF EXISTS (SELECT 1 FROM lifecycle_holds h WHERE h.tenant_id=ts AND h.active AND h.kind IN ('LEGAL','SAFETY')) THEN
    RAISE EXCEPTION 'tenant hold blocks new work';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_lifecycle_job_guard ON forge_jobs;
CREATE TRIGGER forge_lifecycle_job_guard BEFORE INSERT ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_lifecycle_guard_job();

CREATE OR REPLACE FUNCTION forge_lifecycle_guard_project() RETURNS trigger AS $$
BEGIN
  IF NEW.lifecycle_state IN ('DELETED','DELETION_IN_PROGRESS') AND OLD.lifecycle_state NOT IN ('DELETED','DELETION_IN_PROGRESS') THEN
    IF EXISTS (SELECT 1 FROM forge_jobs j WHERE j.project_id=NEW.id AND j.status IN ('QUEUED','RUNNING')) THEN
      RAISE EXCEPTION 'project has active jobs';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_lifecycle_project_guard ON projects;
CREATE TRIGGER forge_lifecycle_project_guard BEFORE UPDATE OF lifecycle_state ON projects FOR EACH ROW EXECUTE FUNCTION forge_lifecycle_guard_project();

COMMIT;
