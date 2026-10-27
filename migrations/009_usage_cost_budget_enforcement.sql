-- Durable usage, cost, quota and budget enforcement primitives.
-- Usage events are immutable and reservations are the concurrency gate for expensive work.
BEGIN;

CREATE TABLE IF NOT EXISTS usage_pricing (
  id bigserial PRIMARY KEY,
  provider_type text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL DEFAULT '',
  operation text NOT NULL,
  unit_type text NOT NULL CHECK (unit_type IN ('request','second','byte','input_unit','output_unit','custom')),
  unit_price numeric(30,12) NOT NULL CHECK (unit_price >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  config_version text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_type, provider, model, operation, config_version)
);
CREATE INDEX IF NOT EXISTS usage_pricing_lookup_idx ON usage_pricing(provider_type, provider, model, operation, active, effective_at DESC);

CREATE TABLE IF NOT EXISTS usage_budgets (
  id bigserial PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('EPISODE','PROJECT','PROVIDER','GLOBAL')),
  scope_id text NOT NULL,
  period_key text NOT NULL DEFAULT 'lifetime',
  hard_cost_limit numeric(30,8) CHECK (hard_cost_limit >= 0),
  hard_usage_limit numeric(30,8) CHECK (hard_usage_limit >= 0),
  soft_cost_limit numeric(30,8) CHECK (soft_cost_limit >= 0),
  soft_usage_limit numeric(30,8) CHECK (soft_usage_limit >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','EXHAUSTED','DISABLED')),
  config_version text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(scope_type, scope_id, period_key, currency)
);
CREATE INDEX IF NOT EXISTS usage_budgets_scope_idx ON usage_budgets(scope_type, scope_id, state);

CREATE TABLE IF NOT EXISTS usage_reservations (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  provider_type text NOT NULL,
  provider text NOT NULL,
  model text,
  operation text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  estimated_units numeric(30,8) NOT NULL DEFAULT 0 CHECK (estimated_units >= 0),
  estimated_cost numeric(30,8) NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','SETTLED','RELEASED','EXPIRED')),
  terminal_reason text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE(job_id, attempt)
);
CREATE INDEX IF NOT EXISTS usage_reservations_active_idx ON usage_reservations(status, expires_at) WHERE status = 'HELD';
CREATE INDEX IF NOT EXISTS usage_reservations_episode_idx ON usage_reservations(episode_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  provider_run_id text REFERENCES provider_runs(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  stage text,
  provider_type text NOT NULL,
  provider text NOT NULL,
  model text,
  operation text NOT NULL,
  execution_attempt integer NOT NULL DEFAULT 1 CHECK (execution_attempt > 0),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  input_artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms bigint CHECK (duration_ms >= 0),
  input_bytes bigint CHECK (input_bytes >= 0),
  output_bytes bigint CHECK (output_bytes >= 0),
  usage_units numeric(30,8) NOT NULL DEFAULT 0 CHECK (usage_units >= 0),
  normalized_cost_units numeric(30,8) NOT NULL DEFAULT 0 CHECK (normalized_cost_units >= 0),
  estimated_cost numeric(30,8) CHECK (estimated_cost >= 0),
  actual_cost numeric(30,8) CHECK (actual_cost >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  outcome text NOT NULL CHECK (outcome IN ('SUCCEEDED','FAILED','CANCELLED','REJECTED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_episode_idx ON usage_events(episode_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_project_idx ON usage_events(project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_provider_idx ON usage_events(provider, model, operation, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_job_idx ON usage_events(job_id, execution_attempt);

CREATE OR REPLACE FUNCTION forge_usage_events_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'usage events are immutable'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS usage_events_no_update ON usage_events;
CREATE TRIGGER usage_events_no_update BEFORE UPDATE OR DELETE ON usage_events FOR EACH ROW EXECUTE FUNCTION forge_usage_events_immutable();

CREATE OR REPLACE FUNCTION forge_usage_reservation_consistency() RETURNS trigger AS $$
BEGIN
  IF NEW.episode_id IS NOT NULL AND NEW.project_id IS NULL THEN RAISE EXCEPTION 'usage reservation with episode requires project'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS usage_reservation_consistency ON usage_reservations;
CREATE TRIGGER usage_reservation_consistency BEFORE INSERT OR UPDATE ON usage_reservations FOR EACH ROW EXECUTE FUNCTION forge_usage_reservation_consistency();

COMMIT;
