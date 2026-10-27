-- Immutable usage metering, billing, quota and reconciliation foundation.
-- All monetary quantities use NUMERIC; no floating point accounting.

CREATE TABLE IF NOT EXISTS usage_pricing_versions (
  id BIGSERIAL PRIMARY KEY,
  pricing_version TEXT NOT NULL UNIQUE,
  provider_type TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  unit TEXT NOT NULL,
  rate NUMERIC(30,12) NOT NULL CHECK (rate >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  effective_at TIMESTAMPTZ NOT NULL,
  supersedes_pricing_version TEXT REFERENCES usage_pricing_versions(pricing_version),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_ledger_heads (
  tenant_id TEXT PRIMARY KEY,
  sequence BIGINT NOT NULL DEFAULT 0,
  last_event_id UUID,
  last_integrity_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_ledger_events (
  event_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  job_id TEXT,
  attempt INTEGER,
  provider_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  operation TEXT NOT NULL,
  dimension TEXT NOT NULL,
  quantity NUMERIC(30,12) NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  rate NUMERIC(30,12) NOT NULL CHECK (rate >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount NUMERIC(30,12) NOT NULL,
  pricing_version TEXT NOT NULL REFERENCES usage_pricing_versions(pricing_version),
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('USAGE','RESERVATION','RELEASE','REFUND','CREDIT','ADJUSTMENT','REPRICE','DISCREPANCY')),
  source TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  sequence BIGINT NOT NULL,
  previous_integrity_hash TEXT,
  integrity_hash TEXT NOT NULL,
  canonical_payload JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sequence)
);
CREATE INDEX IF NOT EXISTS usage_ledger_events_tenant_time_idx ON usage_ledger_events(tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_ledger_events_project_time_idx ON usage_ledger_events(project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_ledger_events_run_idx ON usage_ledger_events(run_id);
CREATE INDEX IF NOT EXISTS usage_ledger_events_dimension_idx ON usage_ledger_events(tenant_id, dimension, currency);

CREATE TABLE IF NOT EXISTS usage_quota_policies (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('hour','day','month','lifetime')),
  soft_limit NUMERIC(30,12),
  hard_limit NUMERIC(30,12),
  grace_quantity NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (grace_quantity >= 0),
  currency CHAR(3),
  enabled BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, dimension, period),
  CHECK (soft_limit IS NULL OR soft_limit >= 0),
  CHECK (hard_limit IS NULL OR hard_limit >= 0),
  CHECK (hard_limit IS NULL OR soft_limit IS NULL OR hard_limit >= soft_limit)
);

CREATE TABLE IF NOT EXISTS usage_quota_reservations (
  reservation_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  dimension TEXT NOT NULL,
  quantity NUMERIC(30,12) NOT NULL CHECK (quantity > 0),
  currency CHAR(3),
  status TEXT NOT NULL CHECK (status IN ('HELD','CONSUMED','RELEASED','EXPIRED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_event_id UUID REFERENCES usage_ledger_events(event_id),
  released_event_id UUID REFERENCES usage_ledger_events(event_id)
);
CREATE INDEX IF NOT EXISTS usage_quota_reservations_active_idx ON usage_quota_reservations(tenant_id, dimension, status) WHERE status='HELD';

CREATE TABLE IF NOT EXISTS usage_reconciliation_runs (
  reconciliation_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','MATCHED','DISCREPANCY','FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS usage_reconciliation_items (
  id BIGSERIAL PRIMARY KEY,
  reconciliation_id UUID NOT NULL REFERENCES usage_reconciliation_runs(reconciliation_id),
  external_event_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  operation TEXT NOT NULL,
  quantity NUMERIC(30,12) NOT NULL,
  unit TEXT NOT NULL,
  currency CHAR(3),
  external_amount NUMERIC(30,12),
  internal_quantity NUMERIC(30,12),
  internal_amount NUMERIC(30,12),
  disposition TEXT NOT NULL CHECK (disposition IN ('MATCHED','MISSING_INTERNAL','EXTERNAL_ONLY','QUANTITY_MISMATCH','AMOUNT_MISMATCH','DUPLICATE')),
  resolved_event_id UUID REFERENCES usage_ledger_events(event_id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (reconciliation_id, external_event_id)
);

CREATE TABLE IF NOT EXISTS usage_adjustment_requests (
  adjustment_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT,
  reason TEXT NOT NULL,
  quantity NUMERIC(30,12) NOT NULL,
  amount NUMERIC(30,12) NOT NULL,
  currency CHAR(3) NOT NULL,
  target_event_id UUID REFERENCES usage_ledger_events(event_id),
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED')),
  approval_note TEXT,
  applied_event_id UUID REFERENCES usage_ledger_events(event_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS usage_billing_rollups (
  tenant_id TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  dimension TEXT NOT NULL,
  currency CHAR(3) NOT NULL,
  quantity NUMERIC(30,12) NOT NULL DEFAULT 0,
  net_amount NUMERIC(30,12) NOT NULL DEFAULT 0,
  event_count BIGINT NOT NULL DEFAULT 0,
  recalculation_version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_start, period_end, dimension, currency)
);

-- Database-level immutability: ledger rows cannot be updated or deleted.
CREATE OR REPLACE FUNCTION forbid_usage_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage ledger is append-only: % is forbidden for event %', TG_OP, COALESCE(OLD.event_id::text, NEW.event_id::text);
END;
$$;
DROP TRIGGER IF EXISTS usage_ledger_immutable_update ON usage_ledger_events;
DROP TRIGGER IF EXISTS usage_ledger_immutable_delete ON usage_ledger_events;
CREATE TRIGGER usage_ledger_immutable_update BEFORE UPDATE ON usage_ledger_events FOR EACH ROW EXECUTE FUNCTION forbid_usage_ledger_mutation();
CREATE TRIGGER usage_ledger_immutable_delete BEFORE DELETE ON usage_ledger_events FOR EACH ROW EXECUTE FUNCTION forbid_usage_ledger_mutation();

-- Prevent retroactive changes to pricing identities/rates. New pricing gets a new version.
CREATE OR REPLACE FUNCTION forbid_pricing_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pricing versions are immutable; create a new pricing_version';
END;
$$;
DROP TRIGGER IF EXISTS usage_pricing_immutable_update ON usage_pricing_versions;
DROP TRIGGER IF EXISTS usage_pricing_immutable_delete ON usage_pricing_versions;
CREATE TRIGGER usage_pricing_immutable_update BEFORE UPDATE ON usage_pricing_versions FOR EACH ROW EXECUTE FUNCTION forbid_pricing_mutation();
CREATE TRIGGER usage_pricing_immutable_delete BEFORE DELETE ON usage_pricing_versions FOR EACH ROW EXECUTE FUNCTION forbid_pricing_mutation();

CREATE OR REPLACE VIEW usage_ledger_daily AS
SELECT tenant_id, date_trunc('day', occurred_at) AS day, dimension, currency,
       SUM(CASE WHEN event_type IN ('REFUND','CREDIT','ADJUSTMENT') THEN amount ELSE amount END) AS net_amount,
       SUM(quantity) FILTER (WHERE event_type='USAGE') AS usage_quantity,
       COUNT(*) AS event_count
FROM usage_ledger_events
GROUP BY tenant_id, date_trunc('day', occurred_at), dimension, currency;
