BEGIN;

-- Cross-system integrity ledger. Immutable domain rows are never rewritten by reconciliation;
-- findings, canonical snapshots, quarantine state and operator-approved repairs are durable evidence.
CREATE TABLE IF NOT EXISTS forge_integrity_runs (
  id text PRIMARY KEY,
  worker_id text NOT NULL,
  scope text NOT NULL DEFAULT 'global',
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','QUARANTINED')),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_fingerprint char(64),
  scanned_count integer NOT NULL DEFAULT 0,
  finding_count integer NOT NULL DEFAULT 0,
  repaired_count integer NOT NULL DEFAULT 0,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_integrity_runs_started_idx ON forge_integrity_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS forge_integrity_records (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES forge_integrity_runs(id) ON DELETE RESTRICT,
  domain text NOT NULL,
  record_key text NOT NULL,
  tenant_id text,
  project_id text,
  canonical_json jsonb NOT NULL,
  checksum char(64) NOT NULL,
  source_revision text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, domain, record_key)
);
CREATE INDEX IF NOT EXISTS forge_integrity_records_domain_idx ON forge_integrity_records(run_id, domain, record_key);
CREATE INDEX IF NOT EXISTS forge_integrity_records_scope_idx ON forge_integrity_records(tenant_id, project_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS forge_integrity_findings (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES forge_integrity_runs(id) ON DELETE RESTRICT,
  fingerprint char(64) NOT NULL UNIQUE,
  domain text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  tenant_id text,
  project_id text,
  severity text NOT NULL CHECK (severity IN ('INFO','WARN','ERROR','CRITICAL')),
  code text NOT NULL,
  expected_checksum char(64),
  observed_checksum char(64),
  repair_safety text NOT NULL CHECK (repair_safety IN ('SAFE','REVIEW','UNSAFE')),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','QUARANTINED','REPAIRED','ACKNOWLEDGED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_integrity_findings_run_idx ON forge_integrity_findings(run_id, domain, severity);
CREATE INDEX IF NOT EXISTS forge_integrity_findings_scope_idx ON forge_integrity_findings(tenant_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_integrity_quarantine (
  id text PRIMARY KEY,
  finding_id text NOT NULL UNIQUE REFERENCES forge_integrity_findings(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RELEASED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_by text,
  released_at timestamptz
);

CREATE TABLE IF NOT EXISTS forge_integrity_repairs (
  id text PRIMARY KEY,
  finding_id text NOT NULL REFERENCES forge_integrity_findings(id) ON DELETE RESTRICT,
  plan_fingerprint char(64) NOT NULL UNIQUE,
  action text NOT NULL,
  approval_token text NOT NULL,
  approved_by text NOT NULL,
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','NOOP','REJECTED','FAILED')),
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_integrity_repairs_finding_idx ON forge_integrity_repairs(finding_id, applied_at DESC);

-- Detect schema drift without treating the expected migration ledger as mutable history.
CREATE OR REPLACE VIEW forge_integrity_schema_shape AS
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       a.attname AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
       a.attnotnull AS not_null,
       a.attnum AS ordinal
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped;

COMMIT;
