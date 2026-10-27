BEGIN;

CREATE TABLE IF NOT EXISTS provider_circuit_states (
  provider text NOT NULL,
  operation text NOT NULL,
  state text NOT NULL CHECK (state IN ('CLOSED','OPEN','HALF_OPEN')),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  opened_at timestamptz,
  half_open_calls integer NOT NULL DEFAULT 0 CHECK (half_open_calls >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, operation)
);
CREATE INDEX IF NOT EXISTS provider_circuit_states_state_idx ON provider_circuit_states(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS provider_reliability_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  operation text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('ATTEMPT','RETRY','CIRCUIT_OPEN','CIRCUIT_HALF_OPEN','CIRCUIT_CLOSED','FAILOVER','QUARANTINED','PROBE_SUCCESS','PROBE_FAILURE','RATE_LIMITED','TIMEOUT','MALFORMED_RESPONSE','AUTH_FAILURE')),
  attempt_id text,
  idempotency_key text,
  normalized_error_code text,
  retry_after_ms integer,
  latency_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_reliability_events_lookup_idx ON provider_reliability_events(provider, operation, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_reliability_events_idempotency_idx ON provider_reliability_events(idempotency_key, created_at DESC);

COMMIT;
