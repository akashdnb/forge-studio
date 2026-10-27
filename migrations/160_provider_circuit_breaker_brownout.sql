BEGIN;

CREATE TABLE IF NOT EXISTS provider_circuit_breaker_state (
  id bigserial PRIMARY KEY,
  tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  service text NOT NULL DEFAULT '',
  capability text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  impact_scope text NOT NULL DEFAULT 'TENANT' CHECK (impact_scope IN ('TENANT','PROJECT','CAPABILITY','REGION','GLOBAL')),
  state text NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED','OPEN','HALF_OPEN')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  rolling_successes integer NOT NULL DEFAULT 0 CHECK (rolling_successes >= 0),
  rolling_failures integer NOT NULL DEFAULT 0 CHECK (rolling_failures >= 0),
  rolling_timeouts integer NOT NULL DEFAULT 0 CHECK (rolling_timeouts >= 0),
  rolling_rate_limits integer NOT NULL DEFAULT 0 CHECK (rolling_rate_limits >= 0),
  rolling_malformed integer NOT NULL DEFAULT 0 CHECK (rolling_malformed >= 0),
  latency_ewma_ms double precision NOT NULL DEFAULT 0 CHECK (latency_ewma_ms >= 0),
  last_failure_at timestamptz,
  last_success_at timestamptz,
  opened_at timestamptz,
  open_until timestamptz,
  probe_owner text,
  probe_lease_until timestamptz,
  brownout_mode text NOT NULL DEFAULT 'NONE' CHECK (brownout_mode IN ('NONE','DEGRADED','DISABLED')),
  brownout_reason text,
  manual_override text NOT NULL DEFAULT 'NONE' CHECK (manual_override IN ('NONE','FORCE_OPEN','FORCE_CLOSED','FORCE_BROWNOUT')),
  override_expires_at timestamptz,
  incident_ref text,
  audit_ref text,
  config_version bigint NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_circuit_breaker_scope_uq
  ON provider_circuit_breaker_state(
    COALESCE(tenant_id,''), COALESCE(project_id,''), provider, service,
    capability, region, impact_scope
  );
CREATE INDEX IF NOT EXISTS provider_circuit_breaker_state_lookup_idx
  ON provider_circuit_breaker_state(provider, service, capability, region, state, open_until);
CREATE INDEX IF NOT EXISTS provider_circuit_breaker_state_tenant_idx
  ON provider_circuit_breaker_state(tenant_id, project_id, provider, capability, region, updated_at DESC);
CREATE INDEX IF NOT EXISTS provider_circuit_breaker_probe_idx
  ON provider_circuit_breaker_state(state, probe_lease_until);

CREATE TABLE IF NOT EXISTS provider_circuit_breaker_events (
  event_id text PRIMARY KEY,
  state_id bigint NOT NULL REFERENCES provider_circuit_breaker_state(id) ON DELETE CASCADE,
  tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  service text NOT NULL DEFAULT '',
  capability text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  event_type text NOT NULL CHECK (event_type IN (
    'SUCCESS','FAILURE','TIMEOUT','RATE_LIMIT','NETWORK_FAILURE','MALFORMED_RESPONSE',
    'OPEN','HALF_OPEN','CLOSED','PROBE_ACQUIRED','PROBE_SUCCESS','PROBE_FAILURE',
    'BROWNOUT_ON','BROWNOUT_OFF','MANUAL_OPEN','MANUAL_CLOSE','MANUAL_BROWNOUT','RESET','RECONFIGURED'
  )),
  previous_state text,
  next_state text,
  error_code text,
  latency_ms bigint CHECK (latency_ms IS NULL OR latency_ms >= 0),
  attempt_id text,
  idempotency_key text,
  incident_ref text,
  audit_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_circuit_breaker_events_state_idx
  ON provider_circuit_breaker_events(state_id, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_circuit_breaker_events_scope_idx
  ON provider_circuit_breaker_events(tenant_id, provider, capability, region, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_circuit_breaker_events_idempotency_idx
  ON provider_circuit_breaker_events(idempotency_key, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_circuit_breaker_recovery (
  recovery_id text PRIMARY KEY,
  state_id bigint NOT NULL REFERENCES provider_circuit_breaker_state(id) ON DELETE CASCADE,
  tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  capability text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  opened_at timestamptz NOT NULL,
  probe_started_at timestamptz,
  recovered_at timestamptz,
  final_state text NOT NULL CHECK (final_state IN ('OPEN','HALF_OPEN','CLOSED')),
  probe_owner text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_circuit_breaker_recovery_scope_idx
  ON provider_circuit_breaker_recovery(tenant_id, provider, capability, region, created_at DESC);

COMMIT;
