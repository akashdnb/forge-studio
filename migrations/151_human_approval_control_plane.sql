BEGIN;

CREATE TABLE IF NOT EXISTS approval_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  resource_version_id text,
  action text NOT NULL,
  risk_class text NOT NULL CHECK (risk_class IN ('MEDIUM','HIGH','CRITICAL')),
  requested_by text NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  policy_version bigint NOT NULL,
  policy_hash char(64) NOT NULL,
  required_roles jsonb NOT NULL,
  quorum integer NOT NULL CHECK (quorum > 0),
  separation_of_duties boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ESCALATED','APPROVED','REJECTED','EXPIRED','REVOKED','STALE')),
  approval_epoch bigint NOT NULL DEFAULT 1 CHECK (approval_epoch > 0),
  escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  expires_at timestamptz NOT NULL,
  escalation_at timestamptz NOT NULL,
  reason text NOT NULL DEFAULT '',
  break_glass boolean NOT NULL DEFAULT false,
  break_glass_expires_at timestamptz,
  break_glass_reason text,
  revoked_at timestamptz,
  revoked_by text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT break_glass OR (break_glass_expires_at IS NOT NULL AND break_glass_reason IS NOT NULL AND length(break_glass_reason) > 0)),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (jsonb_typeof(required_roles) = 'array')
);
CREATE INDEX IF NOT EXISTS approval_requests_scope_idx ON approval_requests(tenant_id,project_id,resource_type,resource_id,created_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_pending_idx ON approval_requests(status,expires_at) WHERE status IN ('PENDING','ESCALATED');
CREATE INDEX IF NOT EXISTS approval_requests_action_idx ON approval_requests(tenant_id,action,status,created_at DESC);

CREATE TABLE IF NOT EXISTS approval_decisions (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
  approval_epoch bigint NOT NULL,
  approver_id text NOT NULL,
  approver_role text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash char(64) NOT NULL,
  previous_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,approval_epoch,approver_id)
);
CREATE INDEX IF NOT EXISTS approval_decisions_request_idx ON approval_decisions(request_id,approval_epoch,created_at);

CREATE TABLE IF NOT EXISTS approval_events (
  request_id text NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
  sequence bigserial NOT NULL,
  approval_epoch bigint NOT NULL,
  event text NOT NULL,
  actor text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(request_id,sequence)
);
CREATE INDEX IF NOT EXISTS approval_events_request_idx ON approval_events(request_id,sequence);

CREATE TABLE IF NOT EXISTS approval_consumptions (
  request_id text PRIMARY KEY REFERENCES approval_requests(id) ON DELETE RESTRICT,
  consumed_by text NOT NULL,
  action text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION forge_approval_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'approval evidence is immutable'; END $$;
DROP TRIGGER IF EXISTS approval_decisions_immutable_guard ON approval_decisions;
CREATE TRIGGER approval_decisions_immutable_guard BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION forge_approval_immutable_guard();
DROP TRIGGER IF EXISTS approval_events_immutable_guard ON approval_events;
CREATE TRIGGER approval_events_immutable_guard BEFORE UPDATE OR DELETE ON approval_events FOR EACH ROW EXECUTE FUNCTION forge_approval_immutable_guard();
DROP TRIGGER IF EXISTS approval_consumptions_immutable_guard ON approval_consumptions;
CREATE TRIGGER approval_consumptions_immutable_guard BEFORE UPDATE OR DELETE ON approval_consumptions FOR EACH ROW EXECUTE FUNCTION forge_approval_immutable_guard();

CREATE OR REPLACE FUNCTION forge_approval_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.resource_type<>OLD.resource_type OR NEW.resource_id<>OLD.resource_id OR NEW.resource_version_id IS DISTINCT FROM OLD.resource_version_id OR NEW.action<>OLD.action OR NEW.risk_class<>OLD.risk_class OR NEW.requested_by<>OLD.requested_by OR NEW.snapshot<>OLD.snapshot OR NEW.snapshot_hash<>OLD.snapshot_hash OR NEW.request_hash<>OLD.request_hash OR NEW.policy_version<>OLD.policy_version OR NEW.policy_hash<>OLD.policy_hash OR NEW.required_roles<>OLD.required_roles OR NEW.quorum<>OLD.quorum OR NEW.separation_of_duties<>OLD.separation_of_duties THEN
    RAISE EXCEPTION 'approval request immutable binding cannot change';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS approval_snapshot_guard ON approval_requests;
CREATE TRIGGER approval_snapshot_guard BEFORE UPDATE ON approval_requests FOR EACH ROW EXECUTE FUNCTION forge_approval_snapshot_guard();

CREATE OR REPLACE FUNCTION forge_approval_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pt text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT tenant_id INTO pt FROM projects WHERE id=NEW.project_id;
    IF pt IS NULL OR pt<>NEW.tenant_id THEN RAISE EXCEPTION 'approval tenant/project mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS approval_scope_guard ON approval_requests;
CREATE TRIGGER approval_scope_guard BEFORE INSERT OR UPDATE OF tenant_id,project_id ON approval_requests FOR EACH ROW EXECUTE FUNCTION forge_approval_scope_guard();

COMMIT;
