BEGIN;

CREATE TABLE IF NOT EXISTS forge_plans (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  lifecycle_state text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_state IN ('ACTIVE','ARCHIVED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forge_plan_versions (
  id text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES forge_plans(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version > 0),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED','ROLLED_BACK')),
  epoch bigint NOT NULL CHECK (epoch > 0),
  grandfatherable boolean NOT NULL DEFAULT true,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE(plan_id, version),
  UNIQUE(plan_id, content_hash),
  CHECK (expires_at IS NULL OR expires_at > effective_at)
);
CREATE INDEX IF NOT EXISTS forge_plan_versions_effective_idx ON forge_plan_versions(plan_id, effective_at DESC, version DESC);

CREATE TABLE IF NOT EXISTS forge_plan_entitlements (
  plan_version_id text NOT NULL REFERENCES forge_plan_versions(id) ON DELETE RESTRICT,
  capability text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  limit_value numeric(30,6),
  limit_unit text,
  overage_policy text NOT NULL DEFAULT 'DENY' CHECK (overage_policy IN ('DENY','GRACE','METER','ALLOW')),
  grace_limit numeric(30,6),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(plan_version_id, capability),
  CHECK (limit_value IS NULL OR limit_value >= 0),
  CHECK (grace_limit IS NULL OR grace_limit >= 0)
);
CREATE INDEX IF NOT EXISTS forge_plan_entitlements_capability_idx ON forge_plan_entitlements(capability, plan_version_id);

CREATE TABLE IF NOT EXISTS forge_tenant_plan_assignments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_version_id text NOT NULL REFERENCES forge_plan_versions(id) ON DELETE RESTRICT,
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  grace_until timestamptz,
  grandfather_existing_work boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','ACTIVE','SUPERSEDED','CANCELLED')),
  epoch bigint NOT NULL CHECK (epoch > 0),
  requested_by text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > effective_at),
  CHECK (grace_until IS NULL OR grace_until >= effective_at)
);
CREATE INDEX IF NOT EXISTS forge_tenant_plan_assignments_effective_idx ON forge_tenant_plan_assignments(tenant_id, effective_at DESC, epoch DESC);
CREATE UNIQUE INDEX IF NOT EXISTS forge_tenant_plan_one_active_idx ON forge_tenant_plan_assignments(tenant_id) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS forge_tenant_entitlement_overrides (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  capability text NOT NULL,
  enabled boolean,
  limit_value numeric(30,6),
  expires_at timestamptz,
  reason text NOT NULL,
  exception_kind text NOT NULL DEFAULT 'CONTROLLED' CHECK (exception_kind IN ('CONTROLLED','EMERGENCY')),
  revision bigint NOT NULL DEFAULT 1,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (enabled IS NOT NULL OR limit_value IS NOT NULL),
  CHECK (limit_value IS NULL OR limit_value >= 0)
);
CREATE INDEX IF NOT EXISTS forge_tenant_entitlement_overrides_idx ON forge_tenant_entitlement_overrides(tenant_id, capability, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_entitlement_kill_switches (
  capability text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  epoch bigint NOT NULL DEFAULT 1,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forge_entitlement_reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  capability text NOT NULL,
  amount numeric(30,6) NOT NULL CHECK (amount > 0),
  plan_version_id text NOT NULL REFERENCES forge_plan_versions(id) ON DELETE RESTRICT,
  assignment_id text REFERENCES forge_tenant_plan_assignments(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','SETTLED','RELEASED','EXPIRED','REJECTED')),
  actual_amount numeric(30,6),
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_entitlement_reservations_scope_idx ON forge_entitlement_reservations(tenant_id, capability, status, expires_at);
CREATE INDEX IF NOT EXISTS forge_entitlement_reservations_resource_idx ON forge_entitlement_reservations(resource_type, resource_id, status);

CREATE TABLE IF NOT EXISTS forge_entitlement_usage (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  capability text NOT NULL,
  amount numeric(30,6) NOT NULL CHECK (amount >= 0),
  plan_version_id text NOT NULL REFERENCES forge_plan_versions(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  resource_type text,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_entitlement_usage_scope_idx ON forge_entitlement_usage(tenant_id, capability, period_start);

CREATE TABLE IF NOT EXISTS forge_entitlement_audit (
  id bigserial PRIMARY KEY,
  tenant_id text,
  project_id text,
  actor text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED','DENIED','FAILED')),
  capability text,
  plan_version_id text,
  assignment_id text,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_entitlement_audit_scope_idx ON forge_entitlement_audit(tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION forge_entitlement_reservation_scope_guard() RETURNS trigger AS $$
DECLARE project_tenant text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id;
    IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN
      RAISE EXCEPTION 'entitlement reservation tenant/project mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_entitlement_reservation_scope ON forge_entitlement_reservations;
CREATE TRIGGER forge_entitlement_reservation_scope BEFORE INSERT OR UPDATE OF tenant_id,project_id ON forge_entitlement_reservations FOR EACH ROW EXECUTE FUNCTION forge_entitlement_reservation_scope_guard();

CREATE OR REPLACE FUNCTION forge_entitlement_assignment_guard() RETURNS trigger AS $$
DECLARE pv_status text;
BEGIN
  SELECT status INTO pv_status FROM forge_plan_versions WHERE id=NEW.plan_version_id;
  IF pv_status IS NULL OR pv_status='DRAFT' THEN RAISE EXCEPTION 'plan version must be activated before assignment'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_entitlement_assignment_guard ON forge_tenant_plan_assignments;
CREATE TRIGGER forge_entitlement_assignment_guard BEFORE INSERT OR UPDATE OF plan_version_id ON forge_tenant_plan_assignments FOR EACH ROW EXECUTE FUNCTION forge_entitlement_assignment_guard();

COMMIT;
