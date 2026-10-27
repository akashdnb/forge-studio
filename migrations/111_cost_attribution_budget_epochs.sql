BEGIN;

CREATE TABLE IF NOT EXISTS cost_rate_versions (
  id bigserial PRIMARY KEY,
  provider_type text NOT NULL,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  operation text NOT NULL,
  unit_type text NOT NULL CHECK (unit_type IN ('request','second','byte','input_unit','output_unit','cpu_ms','custom')),
  unit_price numeric(30,12) NOT NULL CHECK (unit_price >= 0),
  currency char(3) NOT NULL,
  normalized_currency char(3) NOT NULL,
  fx_rate_to_normalized numeric(30,12) NOT NULL DEFAULT 1 CHECK (fx_rate_to_normalized > 0),
  version text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_type,provider,model,operation,version)
);
CREATE INDEX IF NOT EXISTS cost_rate_versions_lookup_idx ON cost_rate_versions(provider_type,provider,model,operation,active,effective_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS cost_budget_epochs (
  id bigserial PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('GLOBAL','TENANT','PROJECT','EPISODE','RUN','PROVIDER')),
  scope_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  period_key text NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  hard_cost_limit numeric(30,8) CHECK (hard_cost_limit >= 0),
  soft_cost_limit numeric(30,8) CHECK (soft_cost_limit >= 0),
  hard_usage_limit numeric(30,8) CHECK (hard_usage_limit >= 0),
  soft_usage_limit numeric(30,8) CHECK (soft_usage_limit >= 0),
  soft_priority_floor integer NOT NULL DEFAULT 100 CHECK (soft_priority_floor >= 0),
  currency char(3) NOT NULL,
  config_version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE(scope_type,scope_id,period_key,currency,epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS cost_budget_epochs_active_idx ON cost_budget_epochs(scope_type,scope_id,period_key,currency) WHERE active=true;
CREATE INDEX IF NOT EXISTS cost_budget_epochs_scope_idx ON cost_budget_epochs(scope_type,scope_id,active,epoch DESC);

CREATE TABLE IF NOT EXISTS cost_reservations (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  run_id text,
  job_id text NOT NULL REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  provider_type text NOT NULL,
  provider text NOT NULL,
  model text,
  operation text NOT NULL,
  category text NOT NULL CHECK (category IN ('provider','runner','media','storage','publishing','workflow')),
  attempt integer NOT NULL CHECK (attempt > 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  estimated_units numeric(30,8) NOT NULL DEFAULT 0 CHECK (estimated_units >= 0),
  estimated_cost numeric(30,8) NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  price_version text NOT NULL,
  unit_price numeric(30,12) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  price_currency char(3) NOT NULL,
  normalized_currency char(3) NOT NULL,
  fx_rate_to_normalized numeric(30,12) NOT NULL DEFAULT 1 CHECK (fx_rate_to_normalized > 0),
  estimated_normalized_cost numeric(30,8) NOT NULL DEFAULT 0 CHECK (estimated_normalized_cost >= 0),
  budget_epoch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  release_epoch text,
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','COMMITTED','RELEASED','EXPIRED')),
  soft_exceeded boolean NOT NULL DEFAULT false,
  override_id text,
  expires_at timestamptz NOT NULL,
  committed_cost numeric(30,8),
  committed_normalized_cost numeric(30,8),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  released_at timestamptz,
  UNIQUE(job_id,attempt)
);
CREATE INDEX IF NOT EXISTS cost_reservations_active_idx ON cost_reservations(status,expires_at) WHERE status='HELD';
CREATE INDEX IF NOT EXISTS cost_reservations_tenant_idx ON cost_reservations(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS cost_reservations_job_idx ON cost_reservations(job_id,attempt);

CREATE TABLE IF NOT EXISTS cost_events (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  reservation_id text REFERENCES cost_reservations(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  run_id text,
  job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  provider_run_id text REFERENCES provider_runs(id) ON DELETE RESTRICT,
  category text NOT NULL CHECK (category IN ('provider','runner','media','storage','publishing','workflow')),
  provider_type text NOT NULL,
  provider text NOT NULL,
  model text,
  operation text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  usage_units numeric(30,8) NOT NULL DEFAULT 0 CHECK (usage_units >= 0),
  unit_type text NOT NULL,
  unit_price numeric(30,12) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  price_version text NOT NULL,
  price_currency char(3) NOT NULL,
  fx_rate_to_normalized numeric(30,12) NOT NULL DEFAULT 1 CHECK (fx_rate_to_normalized > 0),
  normalized_currency char(3) NOT NULL,
  actual_cost numeric(30,8) NOT NULL DEFAULT 0 CHECK (actual_cost >= 0),
  normalized_cost numeric(30,8) NOT NULL DEFAULT 0 CHECK (normalized_cost >= 0),
  currency char(3) NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','CANCELLED','REJECTED','EXPIRED')),
  release_epoch text,
  budget_epoch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  override_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_events_tenant_idx ON cost_events(tenant_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS cost_events_project_idx ON cost_events(project_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS cost_events_episode_idx ON cost_events(episode_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS cost_events_run_idx ON cost_events(run_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS cost_events_provider_idx ON cost_events(provider,model,operation,occurred_at DESC);
CREATE INDEX IF NOT EXISTS cost_events_budget_idx ON cost_events((budget_epoch_ids->>0),occurred_at DESC);

CREATE TABLE IF NOT EXISTS cost_budget_overrides (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK (scope_type IN ('GLOBAL','TENANT','PROJECT','EPISODE','RUN','PROVIDER')),
  scope_id text NOT NULL,
  target_job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  amount numeric(30,8) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  request_id text,
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,scope_type,scope_id,target_job_id,created_at)
);
CREATE INDEX IF NOT EXISTS cost_budget_overrides_active_idx ON cost_budget_overrides(tenant_id,currency,expires_at);

CREATE TABLE IF NOT EXISTS cost_adjustments (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  event_id text NOT NULL REFERENCES cost_events(id) ON DELETE RESTRICT,
  budget_epoch_id bigint REFERENCES cost_budget_epochs(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  run_id text,
  kind text NOT NULL CHECK (kind IN ('REFUND','RECONCILIATION','OVERRIDE')),
  amount numeric(30,8) NOT NULL,
  currency char(3) NOT NULL,
  normalized_amount numeric(30,8) NOT NULL,
  normalized_currency char(3) NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_adjustments_budget_idx ON cost_adjustments(budget_epoch_id,created_at DESC);
CREATE INDEX IF NOT EXISTS cost_adjustments_tenant_idx ON cost_adjustments(tenant_id,created_at DESC);

CREATE OR REPLACE FUNCTION forge_cost_events_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'cost events are immutable; append an adjustment instead'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cost_events_no_update ON cost_events;
CREATE TRIGGER cost_events_no_update BEFORE UPDATE OR DELETE ON cost_events FOR EACH ROW EXECUTE FUNCTION forge_cost_events_immutable();

CREATE OR REPLACE FUNCTION forge_cost_adjustments_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'cost adjustments are immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cost_adjustments_no_update ON cost_adjustments;
CREATE TRIGGER cost_adjustments_no_update BEFORE UPDATE OR DELETE ON cost_adjustments FOR EACH ROW EXECUTE FUNCTION forge_cost_adjustments_immutable();

CREATE OR REPLACE FUNCTION forge_cost_scope_guard() RETURNS trigger AS $$
DECLARE project_tenant text; episode_project text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id; IF project_tenant IS NULL OR project_tenant<>NEW.tenant_id THEN RAISE EXCEPTION 'cost tenant/project mismatch'; END IF; END IF;
  IF NEW.episode_id IS NOT NULL THEN SELECT project_id INTO episode_project FROM episodes WHERE id=NEW.episode_id; IF episode_project IS NULL OR (NEW.project_id IS NOT NULL AND episode_project<>NEW.project_id) THEN RAISE EXCEPTION 'cost episode/project mismatch'; END IF; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cost_reservation_scope_guard ON cost_reservations;
CREATE TRIGGER cost_reservation_scope_guard BEFORE INSERT OR UPDATE ON cost_reservations FOR EACH ROW EXECUTE FUNCTION forge_cost_scope_guard();
DROP TRIGGER IF EXISTS cost_event_scope_guard ON cost_events;
CREATE TRIGGER cost_event_scope_guard BEFORE INSERT OR UPDATE ON cost_events FOR EACH ROW EXECUTE FUNCTION forge_cost_scope_guard();

COMMIT;
