BEGIN;

-- Bind every authoritative usage event to the immutable plan/rating context that admitted it.
ALTER TABLE usage_ledger_events ADD COLUMN IF NOT EXISTS plan_version_id TEXT REFERENCES forge_plan_versions(id) ON DELETE RESTRICT;
ALTER TABLE usage_ledger_events ADD COLUMN IF NOT EXISTS plan_assignment_id TEXT REFERENCES forge_tenant_plan_assignments(id) ON DELETE RESTRICT;
ALTER TABLE usage_ledger_events ADD COLUMN IF NOT EXISTS reservation_id UUID;
ALTER TABLE usage_ledger_events ADD COLUMN IF NOT EXISTS source_execution_ref TEXT;
ALTER TABLE usage_ledger_events ADD COLUMN IF NOT EXISTS correction_of_event_id UUID REFERENCES usage_ledger_events(event_id) ON DELETE RESTRICT;
ALTER TABLE usage_ledger_events ADD COLUMN IF NOT EXISTS evidence_fingerprint TEXT;
CREATE INDEX IF NOT EXISTS usage_ledger_events_plan_idx ON usage_ledger_events(tenant_id, plan_version_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_ledger_events_source_execution_idx ON usage_ledger_events(tenant_id, source_execution_ref);
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_events_evidence_fingerprint_idx ON usage_ledger_events(tenant_id, evidence_fingerprint) WHERE evidence_fingerprint IS NOT NULL;

-- Billing reservations are distinct from entitlement reservations: they freeze the plan and price used for rating.
CREATE TABLE IF NOT EXISTS usage_billing_reservations (
  reservation_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  run_id TEXT,
  job_id TEXT,
  attempt INTEGER,
  dimension TEXT NOT NULL,
  unit TEXT NOT NULL,
  reserved_quantity NUMERIC(30,12) NOT NULL CHECK (reserved_quantity > 0),
  reserved_amount NUMERIC(30,12) NOT NULL CHECK (reserved_amount >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  plan_version_id TEXT NOT NULL REFERENCES forge_plan_versions(id) ON DELETE RESTRICT,
  plan_assignment_id TEXT REFERENCES forge_tenant_plan_assignments(id) ON DELETE RESTRICT,
  pricing_version TEXT NOT NULL REFERENCES usage_pricing_versions(pricing_version) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('HELD','COMMITTED','PARTIALLY_COMMITTED','RELEASED','REFUNDED','EXPIRED')),
  idempotency_key TEXT NOT NULL UNIQUE,
  source_execution_ref TEXT,
  provider_reference TEXT,
  committed_quantity NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (committed_quantity >= 0),
  committed_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (committed_amount >= 0),
  refunded_quantity NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (refunded_quantity >= 0),
  refunded_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS usage_billing_reservations_scope_idx ON usage_billing_reservations(tenant_id, dimension, status, expires_at);
CREATE INDEX IF NOT EXISTS usage_billing_reservations_execution_idx ON usage_billing_reservations(tenant_id, source_execution_ref);

CREATE TABLE IF NOT EXISTS usage_billing_evidence (
  evidence_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN ('WORKFLOW','JOB','PROVIDER','RUNNER','ARTIFACT','EGRESS','PUBLISHING','EXPORT','IMPORT')),
  source_id TEXT NOT NULL,
  source_execution_ref TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  dimension TEXT NOT NULL,
  quantity NUMERIC(30,12) NOT NULL CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  amount NUMERIC(30,12),
  currency CHAR(3),
  provider TEXT,
  provider_reference TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  matched_event_id UUID REFERENCES usage_ledger_events(event_id) ON DELETE RESTRICT,
  disposition TEXT NOT NULL DEFAULT 'UNMATCHED' CHECK (disposition IN ('UNMATCHED','MATCHED','DUPLICATE','UNDER_BILLED','OVER_BILLED','IGNORED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_billing_evidence_scope_idx ON usage_billing_evidence(tenant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS usage_billing_evidence_source_idx ON usage_billing_evidence(source_type, source_id);
CREATE INDEX IF NOT EXISTS usage_billing_evidence_disposition_idx ON usage_billing_evidence(tenant_id, disposition);

CREATE TABLE IF NOT EXISTS usage_billing_discrepancies (
  discrepancy_id UUID PRIMARY KEY,
  reconciliation_id UUID NOT NULL REFERENCES usage_reconciliation_runs(reconciliation_id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  evidence_id UUID REFERENCES usage_billing_evidence(evidence_id) ON DELETE RESTRICT,
  ledger_event_id UUID REFERENCES usage_ledger_events(event_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('MISSING_LEDGER','DUPLICATE_LEDGER','UNDER_BILLED','OVER_BILLED','STALE_PLAN','STALE_PRICE','ORPHAN_RESERVATION','FAILED_SIDE_EFFECT')),
  expected_quantity NUMERIC(30,12),
  actual_quantity NUMERIC(30,12),
  expected_amount NUMERIC(30,12),
  actual_amount NUMERIC(30,12),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','CORRECTED','WAIVED')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS usage_billing_discrepancies_scope_idx ON usage_billing_discrepancies(tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_billing_corrections (
  correction_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  target_event_id UUID NOT NULL REFERENCES usage_ledger_events(event_id) ON DELETE RESTRICT,
  correction_event_id UUID REFERENCES usage_ledger_events(event_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','REJECTED','APPLIED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS usage_billing_corrections_target_idx ON usage_billing_corrections(target_event_id);

-- Tenant-scoped integrity guards prevent accidental cross-tenant linkage even when operator code is bypassed.
CREATE OR REPLACE FUNCTION usage_billing_reservation_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_tenant TEXT;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id;
    IF project_tenant IS NULL OR project_tenant<>NEW.tenant_id THEN RAISE EXCEPTION 'billing reservation tenant/project mismatch'; END IF;
  END IF;
  IF NEW.plan_assignment_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM forge_tenant_plan_assignments a WHERE a.id=NEW.plan_assignment_id AND a.tenant_id=NEW.tenant_id AND a.plan_version_id=NEW.plan_version_id) THEN
      RAISE EXCEPTION 'billing reservation plan assignment mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS usage_billing_reservation_scope ON usage_billing_reservations;
CREATE TRIGGER usage_billing_reservation_scope BEFORE INSERT OR UPDATE OF tenant_id,project_id,plan_version_id,plan_assignment_id ON usage_billing_reservations FOR EACH ROW EXECUTE FUNCTION usage_billing_reservation_scope_guard();

-- Never mutate or delete billing reservations after terminal state; state transitions are append-only at the ledger level.
CREATE OR REPLACE FUNCTION forbid_terminal_billing_reservation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('COMMITTED','PARTIALLY_COMMITTED','RELEASED','REFUNDED','EXPIRED') AND (NEW.status<>OLD.status OR NEW.committed_quantity<>OLD.committed_quantity OR NEW.refunded_quantity<>OLD.refunded_quantity OR NEW.committed_amount<>OLD.committed_amount OR NEW.refunded_amount<>OLD.refunded_amount) THEN
    RAISE EXCEPTION 'terminal billing reservation cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS usage_billing_reservation_terminal_guard ON usage_billing_reservations;
CREATE TRIGGER usage_billing_reservation_terminal_guard BEFORE UPDATE ON usage_billing_reservations FOR EACH ROW EXECUTE FUNCTION forbid_terminal_billing_reservation_mutation();

COMMIT;
