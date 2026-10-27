BEGIN;

ALTER TABLE publish_runs
  ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS publish_request_id text,
  ADD COLUMN IF NOT EXISTS release_epoch bigint,
  ADD COLUMN IF NOT EXISTS package_hash char(64),
  ADD COLUMN IF NOT EXISTS gate_fingerprint char(64),
  ADD COLUMN IF NOT EXISTS quarantine_reason text;

UPDATE publish_runs p SET project_id=e.project_id, tenant_id=pr.tenant_id FROM episodes e JOIN projects pr ON pr.id=e.project_id WHERE p.episode_id=e.id AND (p.project_id IS NULL OR p.tenant_id IS NULL);
CREATE INDEX IF NOT EXISTS publish_runs_tenant_project_idx ON publish_runs(tenant_id,project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS publish_runs_request_idx ON publish_runs(publish_request_id);

CREATE TABLE IF NOT EXISTS publish_requests (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT, episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  destination text NOT NULL, request_version integer NOT NULL DEFAULT 1 CHECK (request_version > 0), idempotency_key text NOT NULL UNIQUE,
  package_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT, package_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT, package_hash char(64) NOT NULL,
  render_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT, render_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT, render_hash char(64) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, gate_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, gate_fingerprint char(64) NOT NULL, release_epoch bigint,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','UPLOADING','PUBLISHED','FAILED','CANCELLED','RECONCILIATION_REQUIRED','QUARANTINED')),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS publish_requests_scope_idx ON publish_requests(tenant_id,project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS publish_requests_reconcile_idx ON publish_requests(status,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS publish_requests_package_destination_uq ON publish_requests(destination,package_artifact_id,package_version_id,idempotency_key);

CREATE TABLE IF NOT EXISTS publish_attempts (
  id text PRIMARY KEY, request_id text NOT NULL REFERENCES publish_requests(id) ON DELETE RESTRICT, attempt_no integer NOT NULL CHECK (attempt_no > 0),
  status text NOT NULL CHECK (status IN ('QUEUED','UPLOADING','SUCCEEDED','FAILED','CANCELLED','UNCERTAIN','QUARANTINED')),
  operation_key text NOT NULL UNIQUE, provider_request_key text NOT NULL UNIQUE, external_receipt_id text, upload_session_uri text,
  provider_status integer, provider_reason text, release_epoch bigint, lease_token text, error jsonb, diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz, finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(request_id,attempt_no)
);
CREATE INDEX IF NOT EXISTS publish_attempts_request_idx ON publish_attempts(request_id,attempt_no DESC);
CREATE INDEX IF NOT EXISTS publish_attempts_receipt_idx ON publish_attempts(external_receipt_id);
CREATE INDEX IF NOT EXISTS publish_attempts_uncertain_idx ON publish_attempts(status,created_at);

CREATE TABLE IF NOT EXISTS publish_receipts (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  request_id text NOT NULL REFERENCES publish_requests(id) ON DELETE RESTRICT, attempt_id text REFERENCES publish_attempts(id) ON DELETE RESTRICT,
  destination text NOT NULL, external_id text NOT NULL, external_url text, receipt_state text NOT NULL CHECK (receipt_state IN ('OBSERVED','PUBLISHED','DELETED','UNKNOWN')),
  package_hash char(64) NOT NULL, provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb, observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(destination,external_id), UNIQUE(destination,request_id,external_id)
);
CREATE INDEX IF NOT EXISTS publish_receipts_scope_idx ON publish_receipts(tenant_id,project_id,observed_at DESC);

CREATE TABLE IF NOT EXISTS publish_rate_buckets (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, destination text NOT NULL, window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0), PRIMARY KEY(tenant_id,destination,window_start)
);

CREATE TABLE IF NOT EXISTS publish_quarantine (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  request_id text NOT NULL REFERENCES publish_requests(id) ON DELETE RESTRICT, reason text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz, released_by text
);
CREATE INDEX IF NOT EXISTS publish_quarantine_scope_idx ON publish_quarantine(tenant_id,project_id,created_at DESC);

CREATE OR REPLACE FUNCTION forge_publish_tenant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_tenant text;
BEGIN
  SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id;
  IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN RAISE EXCEPTION 'publish tenant does not match project' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS publish_request_tenant_guard ON publish_requests;
CREATE TRIGGER publish_request_tenant_guard BEFORE INSERT OR UPDATE OF project_id,tenant_id ON publish_requests FOR EACH ROW EXECUTE FUNCTION forge_publish_tenant_guard();
DROP TRIGGER IF EXISTS publish_receipt_tenant_guard ON publish_receipts;
CREATE TRIGGER publish_receipt_tenant_guard BEFORE INSERT OR UPDATE OF project_id,tenant_id ON publish_receipts FOR EACH ROW EXECUTE FUNCTION forge_publish_tenant_guard();
DROP TRIGGER IF EXISTS publish_quarantine_tenant_guard ON publish_quarantine;
CREATE TRIGGER publish_quarantine_tenant_guard BEFORE INSERT OR UPDATE OF project_id,tenant_id ON publish_quarantine FOR EACH ROW EXECUTE FUNCTION forge_publish_tenant_guard();

CREATE OR REPLACE FUNCTION forge_publish_receipt_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.destination IS DISTINCT FROM OLD.destination OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.package_hash IS DISTINCT FROM OLD.package_hash) THEN
    RAISE EXCEPTION 'publish receipt identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS publish_receipt_identity_guard ON publish_receipts;
CREATE TRIGGER publish_receipt_identity_guard BEFORE UPDATE ON publish_receipts FOR EACH ROW EXECUTE FUNCTION forge_publish_receipt_identity_guard();

COMMIT;
