BEGIN;

CREATE TABLE IF NOT EXISTS forge_rate_limit_policies (
  id bigserial PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('GLOBAL','TENANT','PROJECT')),
  tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  plan_version text NOT NULL DEFAULT 'default',
  route_class text NOT NULL,
  method text NOT NULL,
  sustained_rate numeric(20,6) NOT NULL CHECK (sustained_rate >= 0),
  burst_capacity numeric(20,6) NOT NULL CHECK (burst_capacity >= 0),
  concurrency_limit numeric(20,6) NOT NULL CHECK (concurrency_limit >= 0),
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 100000),
  enforcement_mode text NOT NULL DEFAULT 'ENFORCE' CHECK (enforcement_mode IN ('ENFORCE','SHADOW','DISABLED')),
  fail_mode text NOT NULL DEFAULT 'FAIL_CLOSED' CHECK (fail_mode IN ('FAIL_CLOSED','FAIL_OPEN')),
  effective_version bigint NOT NULL,
  trusted_bypass_scope text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope_type='GLOBAL' AND tenant_id IS NULL AND project_id IS NULL)
      OR (scope_type='TENANT' AND tenant_id IS NOT NULL AND project_id IS NULL)
      OR (scope_type='PROJECT' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_rate_limit_policy_active_uq
  ON forge_rate_limit_policies(scope_type,method,route_class,COALESCE(tenant_id,''),COALESCE(project_id,'')) WHERE active;
CREATE INDEX IF NOT EXISTS forge_rate_limit_policy_lookup_idx
  ON forge_rate_limit_policies(active,method,route_class,scope_type,tenant_id,project_id,effective_version DESC);
CREATE TABLE IF NOT EXISTS forge_rate_limit_policy_history (
  id bigserial PRIMARY KEY,
  policy_id bigint NOT NULL REFERENCES forge_rate_limit_policies(id) ON DELETE RESTRICT,
  tenant_id text,
  project_id text,
  effective_version bigint NOT NULL,
  snapshot jsonb NOT NULL,
  actor text NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS forge_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  policy_id bigint NOT NULL REFERENCES forge_rate_limit_policies(id) ON DELETE RESTRICT,
  scope_type text NOT NULL,
  tenant_id text,
  project_id text,
  route_class text NOT NULL,
  method text NOT NULL,
  tokens numeric(30,9) NOT NULL,
  last_refill_at timestamptz NOT NULL,
  active_concurrency bigint NOT NULL DEFAULT 0 CHECK (active_concurrency >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS forge_rate_limit_bucket_scope_idx ON forge_rate_limit_buckets(tenant_id,project_id,route_class,method);
CREATE TABLE IF NOT EXISTS forge_rate_limit_requests (
  request_key text PRIMARY KEY,
  tenant_id text,
  project_id text,
  method text NOT NULL,
  route_class text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED','DENIED','SHADOW','BYPASSED')),
  token_cost numeric(20,6) NOT NULL CHECK (token_cost >= 0),
  retry_after_seconds integer NOT NULL DEFAULT 0 CHECK (retry_after_seconds >= 0),
  policy_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS forge_rate_limit_requests_scope_idx ON forge_rate_limit_requests(tenant_id,project_id,started_at DESC);
CREATE INDEX IF NOT EXISTS forge_rate_limit_requests_route_idx ON forge_rate_limit_requests(route_class,method,started_at DESC);
CREATE TABLE IF NOT EXISTS forge_rate_limit_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('GLOBAL','TENANT','PROJECT')),
  tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  route_class text NOT NULL,
  method text NOT NULL,
  sustained_rate numeric(20,6) NOT NULL CHECK (sustained_rate >= 0),
  burst_capacity numeric(20,6) NOT NULL CHECK (burst_capacity >= 0),
  concurrency_limit numeric(20,6) NOT NULL CHECK (concurrency_limit >= 0),
  priority integer NOT NULL DEFAULT 100,
  enforcement_mode text NOT NULL DEFAULT 'ENFORCE' CHECK (enforcement_mode IN ('ENFORCE','SHADOW','DISABLED')),
  fail_mode text NOT NULL DEFAULT 'FAIL_CLOSED' CHECK (fail_mode IN ('FAIL_CLOSED','FAIL_OPEN')),
  effective_version bigint NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  expires_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((scope_type='GLOBAL' AND tenant_id IS NULL AND project_id IS NULL)
      OR (scope_type='TENANT' AND tenant_id IS NOT NULL AND project_id IS NULL)
      OR (scope_type='PROJECT' AND project_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS forge_rate_limit_override_lookup_idx ON forge_rate_limit_overrides(active,expires_at,scope_type,tenant_id,project_id,route_class,method);
CREATE TABLE IF NOT EXISTS forge_rate_limit_audit (
  id bigserial PRIMARY KEY,
  tenant_id text,
  project_id text,
  request_key text,
  method text NOT NULL,
  route_class text NOT NULL,
  outcome text NOT NULL,
  reason text,
  policy_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS forge_rate_limit_audit_scope_idx ON forge_rate_limit_audit(tenant_id,project_id,created_at DESC);
COMMIT;
