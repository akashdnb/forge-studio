BEGIN;

CREATE TABLE IF NOT EXISTS incident_rules (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  rule_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  severity text NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR','CRITICAL')),
  threshold_seconds integer NOT NULL DEFAULT 900 CHECK (threshold_seconds >= 0),
  cooldown_seconds integer NOT NULL DEFAULT 300 CHECK (cooldown_seconds >= 0),
  max_events_per_window integer NOT NULL DEFAULT 20 CHECK (max_events_per_window BETWEEN 1 AND 10000),
  aggregation_window_seconds integer NOT NULL DEFAULT 300 CHECK (aggregation_window_seconds BETWEEN 1 AND 86400),
  escalation_policy jsonb NOT NULL DEFAULT '[]'::jsonb,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rule_key)
);
CREATE INDEX IF NOT EXISTS incident_rules_scope_idx ON incident_rules(tenant_id, enabled, rule_key);

CREATE TABLE IF NOT EXISTS incident_maintenance_windows (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  rule_key text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS incident_maintenance_active_idx ON incident_maintenance_windows(tenant_id, project_id, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS incident_escalation_policies (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  levels jsonb NOT NULL CHECK (jsonb_typeof(levels)='array'),
  enabled boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS operational_incidents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  rule_key text NOT NULL,
  fingerprint char(64) NOT NULL,
  group_key char(64) NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR','CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','SUPPRESSED')),
  title text NOT NULL,
  summary text NOT NULL,
  source_type text NOT NULL,
  source_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_id text,
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at timestamptz,
  resolved_by text,
  resolution_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  suppressed_count integer NOT NULL DEFAULT 0,
  current_escalation_level integer NOT NULL DEFAULT 0 CHECK (current_escalation_level >= 0),
  next_escalation_at timestamptz,
  last_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS operational_incidents_active_fingerprint_uq ON operational_incidents(tenant_id, fingerprint) WHERE status IN ('OPEN','ACKNOWLEDGED','SUPPRESSED');
CREATE INDEX IF NOT EXISTS operational_incidents_scope_idx ON operational_incidents(tenant_id, project_id, status, severity, updated_at DESC);
CREATE INDEX IF NOT EXISTS operational_incidents_group_idx ON operational_incidents(tenant_id, group_key, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS operational_incidents_escalation_idx ON operational_incidents(status, next_escalation_at) WHERE next_escalation_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS incident_occurrences (
  id bigserial PRIMARY KEY,
  incident_id text NOT NULL REFERENCES operational_incidents(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  fingerprint char(64) NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  source_id text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS incident_occurrences_incident_idx ON incident_occurrences(incident_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS incident_actions (
  id bigserial PRIMARY KEY,
  incident_id text NOT NULL REFERENCES operational_incidents(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('ACKNOWLEDGE','ASSIGN','SUPPRESS','UNSUPPRESS','RESOLVE','REOPEN','ESCALATE')),
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, actor_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS incident_actions_incident_idx ON incident_actions(incident_id, created_at DESC);

CREATE TABLE IF NOT EXISTS incident_notification_state (
  incident_id text PRIMARY KEY REFERENCES operational_incidents(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  last_event_id text,
  last_level integer NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_rate_buckets (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  group_key char(64) NOT NULL,
  window_start timestamptz NOT NULL,
  event_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, group_key, window_start)
);

CREATE INDEX IF NOT EXISTS incident_actions_idempotency_idx ON incident_actions(tenant_id, actor_id, idempotency_key);

CREATE OR REPLACE FUNCTION forge_incident_tenant_guard() RETURNS trigger AS $$
DECLARE project_tenant text;
BEGIN
  IF NEW.project_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id;
  IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'incident tenant does not match project' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS operational_incident_tenant_guard ON operational_incidents;
CREATE TRIGGER operational_incident_tenant_guard BEFORE INSERT OR UPDATE OF project_id,tenant_id ON operational_incidents FOR EACH ROW EXECUTE FUNCTION forge_incident_tenant_guard();

COMMIT;
