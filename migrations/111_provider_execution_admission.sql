BEGIN;
CREATE TABLE IF NOT EXISTS provider_execution_policies (
  id bigserial PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT, provider text, model text, operation text,
  priority integer NOT NULL DEFAULT 100 CHECK (priority>=0), weight numeric(12,4) NOT NULL DEFAULT 1 CHECK (weight>0),
  max_concurrency integer NOT NULL DEFAULT 8 CHECK (max_concurrency>0), rate_per_second numeric(18,6) NOT NULL DEFAULT 0 CHECK (rate_per_second>=0),
  burst integer NOT NULL DEFAULT 8 CHECK (burst>0), lease_ms integer NOT NULL DEFAULT 120000 CHECK (lease_ms BETWEEN 1000 AND 3600000),
  cooldown_ms integer NOT NULL DEFAULT 30000 CHECK (cooldown_ms BETWEEN 1000 AND 3600000), failure_threshold integer NOT NULL DEFAULT 5 CHECK (failure_threshold>0),
  failure_rate_threshold numeric(5,4) NOT NULL DEFAULT .5 CHECK (failure_rate_threshold BETWEEN 0 AND 1), half_open_max_calls integer NOT NULL DEFAULT 1 CHECK (half_open_max_calls>0),
  spend_limit_usd numeric(20,8), epoch bigint NOT NULL CHECK (epoch>0), enabled boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
  updated_by text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_execution_policy_active_uq ON provider_execution_policies(tenant_id,COALESCE(project_id,''),COALESCE(provider,''),COALESCE(model,''),COALESCE(operation,'')) WHERE active;
CREATE INDEX IF NOT EXISTS provider_execution_policy_lookup_idx ON provider_execution_policies(tenant_id,project_id,provider,model,operation,active,epoch DESC);
CREATE TABLE IF NOT EXISTS provider_admission_leases (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT, provider text NOT NULL, model text NOT NULL DEFAULT '', operation text NOT NULL,
  idempotency_key text NOT NULL UNIQUE, attempt integer NOT NULL DEFAULT 1, policy_epoch bigint NOT NULL, decision_id text NOT NULL,
  lease_until timestamptz NOT NULL, status text NOT NULL CHECK(status IN('HELD','SETTLED','RELEASED','EXPIRED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz
);
CREATE INDEX IF NOT EXISTS provider_admission_leases_active_idx ON provider_admission_leases(tenant_id,project_id,provider,model,operation,status,lease_until);
CREATE TABLE IF NOT EXISTS provider_admission_buckets (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL, model text NOT NULL DEFAULT '', operation text NOT NULL, tokens numeric(24,8) NOT NULL CHECK(tokens>=0), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(tenant_id,project_id,provider,model,operation)
);
CREATE TABLE IF NOT EXISTS provider_admission_decisions (
  decision_id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT, provider text NOT NULL, model text NOT NULL DEFAULT '', operation text NOT NULL,
  allowed boolean NOT NULL, reason text NOT NULL, policy_epoch bigint NOT NULL, priority integer NOT NULL DEFAULT 0, weight numeric(12,4) NOT NULL DEFAULT 1,
  concurrency_limit integer NOT NULL DEFAULT 0, rate_per_second numeric(18,6) NOT NULL DEFAULT 0, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_admission_decisions_scope_idx ON provider_admission_decisions(tenant_id,project_id,provider,operation,created_at DESC);
COMMIT;
