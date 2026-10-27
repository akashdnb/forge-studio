BEGIN;

CREATE TABLE IF NOT EXISTS provider_health_state (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  model text NOT NULL DEFAULT '',
  operation text NOT NULL,
  state text NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED','OPEN','HALF_OPEN')),
  success_count bigint NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count bigint NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  consecutive_failures bigint NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  latency_ewma_ms double precision NOT NULL DEFAULT 0 CHECK (latency_ewma_ms >= 0),
  opened_at timestamptz,
  cooldown_until timestamptz,
  probe_owner text,
  probe_until timestamptz,
  last_event_id text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_health_state_scope_uq ON provider_health_state(tenant_id, COALESCE(project_id,''), provider, model, operation);
CREATE INDEX IF NOT EXISTS provider_health_state_status_idx ON provider_health_state(state, cooldown_until, updated_at DESC);
CREATE INDEX IF NOT EXISTS provider_health_state_provider_idx ON provider_health_state(tenant_id, project_id, provider, operation, updated_at DESC);

CREATE TABLE IF NOT EXISTS provider_health_events (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  model text NOT NULL DEFAULT '',
  operation text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCESS','TRANSIENT_FAILURE','TIMEOUT','RATE_LIMIT','TERMINAL')),
  latency_ms bigint NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  error_class text,
  attempt_id text,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_health_events_window_idx ON provider_health_events(tenant_id, project_id, provider, model, operation, observed_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS provider_health_events_idempotency_idx ON provider_health_events(tenant_id, idempotency_key, observed_at DESC);

CREATE TABLE IF NOT EXISTS provider_routing_decisions (
  decision_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  model text NOT NULL DEFAULT '',
  operation text NOT NULL,
  credential_version text,
  release_epoch text,
  score double precision NOT NULL,
  state text NOT NULL CHECK (state IN ('CLOSED','HALF_OPEN')),
  rejected_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_routing_decisions_scope_idx ON provider_routing_decisions(tenant_id, project_id, operation, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_routing_decisions_idempotency_idx ON provider_routing_decisions(tenant_id, idempotency_key, created_at DESC);

COMMIT;
