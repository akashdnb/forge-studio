BEGIN;

CREATE TABLE IF NOT EXISTS forge_notification_intents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  intent_key text NOT NULL,
  intent_version integer NOT NULL DEFAULT 1 CHECK (intent_version > 0),
  source_event_id text,
  source_type text NOT NULL,
  template_name text NOT NULL,
  template_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SCHEDULED','RUNNING','PARTIAL','SUCCEEDED','FAILED','CANCELLED','EXPIRED','QUARANTINED')),
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz,
  quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  escalation_policy jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  cancellation_requested_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deadline_at IS NULL OR deadline_at >= scheduled_at),
  UNIQUE (tenant_id, intent_key, intent_version),
  UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS forge_notification_intents_claim_idx ON forge_notification_intents(status,scheduled_at,priority,created_at) WHERE status IN ('QUEUED','SCHEDULED','PARTIAL','RUNNING');
CREATE INDEX IF NOT EXISTS forge_notification_intents_scope_idx ON forge_notification_intents(tenant_id,project_id,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_notification_recipients (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  intent_id text NOT NULL REFERENCES forge_notification_intents(id) ON DELETE RESTRICT,
  recipient_key text NOT NULL,
  address jsonb NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  locale text NOT NULL DEFAULT 'en',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPPRESSED','INVALID')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(intent_id,recipient_key)
);
CREATE INDEX IF NOT EXISTS forge_notification_recipients_scope_idx ON forge_notification_recipients(tenant_id,recipient_key,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_notification_deliveries (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  intent_id text NOT NULL REFERENCES forge_notification_intents(id) ON DELETE RESTRICT,
  recipient_id text NOT NULL REFERENCES forge_notification_recipients(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK (channel IN ('webhook','email','push','sms','voice')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','LEASED','SENT','FAILED','RETRY','DEAD_LETTER','QUARANTINED','CANCELLED','EXPIRED','SUPPRESSED')),
  provider_route text,
  provider_request_key text NOT NULL,
  dedupe_key text NOT NULL,
  idempotency_key text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 32),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz,
  lease_token text,
  fencing_token bigint NOT NULL DEFAULT 0,
  lease_until timestamptz,
  last_error_code text,
  last_error text,
  suppression_reason text,
  quarantine_reason text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,dedupe_key),
  UNIQUE(provider_request_key)
);
CREATE INDEX IF NOT EXISTS forge_notification_delivery_claim_idx ON forge_notification_deliveries(status,next_attempt_at,priority) WHERE status IN ('QUEUED','RETRY');
CREATE INDEX IF NOT EXISTS forge_notification_delivery_scope_idx ON forge_notification_deliveries(tenant_id,project_id,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_notification_attempts (
  id bigserial PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES forge_notification_deliveries(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL,
  provider_route text,
  request_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SENT','FAILED','RATE_LIMITED','CIRCUIT_OPEN','TIMEOUT','SUPPRESSED','QUARANTINED')),
  provider_status integer,
  retry_after_ms integer,
  error_code text,
  error_message text,
  request_hash char(64),
  response_hash char(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(delivery_id,attempt_no)
);
CREATE INDEX IF NOT EXISTS forge_notification_attempts_delivery_idx ON forge_notification_attempts(delivery_id,attempt_no DESC);

CREATE TABLE IF NOT EXISTS forge_notification_preferences (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  recipient_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('webhook','email','push','sms','voice')),
  enabled boolean NOT NULL DEFAULT true,
  rank integer NOT NULL DEFAULT 100,
  quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,recipient_key,channel)
);

CREATE TABLE IF NOT EXISTS forge_notification_suppressions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  recipient_key text,
  channel text CHECK (channel IS NULL OR channel IN ('webhook','email','push','sms','voice')),
  template_name text,
  reason text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS forge_notification_suppressions_lookup_idx ON forge_notification_suppressions(tenant_id,project_id,recipient_key,channel,starts_at,ends_at);

CREATE TABLE IF NOT EXISTS forge_notification_audit (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  intent_id text,
  delivery_id text,
  actor_id text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_notification_audit_scope_idx ON forge_notification_audit(tenant_id,project_id,created_at DESC);

CREATE OR REPLACE FUNCTION forge_notification_outbox(p_source_key text,p_source_type text,p_tenant_id text,p_project_id text,p_payload jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO forge_outbox(topic,aggregate_type,aggregate_id,payload,tenant_id,project_id)
  VALUES('notification.requested',p_source_type,p_source_key,p_payload,p_tenant_id,p_project_id)
  ON CONFLICT DO NOTHING;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS forge_notification_outbox_source_uq ON forge_outbox(topic,aggregate_type,aggregate_id) WHERE topic='notification.requested';

CREATE OR REPLACE FUNCTION forge_job_notification_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('SUCCEEDED','FAILED','CANCELLED') AND OLD.status IS DISTINCT FROM NEW.status AND NEW.project_id IS NOT NULL THEN
    PERFORM forge_notification_outbox('job:'||NEW.id||':'||NEW.status||':'||NEW.attempts,'job',p.tenant_id,NEW.project_id,jsonb_build_object('sourceId',NEW.id,'sourceType','job','status',NEW.status,'kind',NEW.kind,'attempts',NEW.attempts,'episodeId',NEW.episode_id,'result',COALESCE(NEW.result,'{}'::jsonb),'error',COALESCE(NEW.error,'{}'::jsonb)));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS forge_job_notification_trigger ON forge_jobs;
CREATE TRIGGER forge_job_notification_trigger AFTER UPDATE OF status ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_job_notification_trigger();

CREATE OR REPLACE FUNCTION forge_approval_notification_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM forge_notification_outbox('approval:'||NEW.id||':'||NEW.approval_epoch||':'||NEW.status,'approval',NEW.tenant_id,NEW.project_id,jsonb_build_object('sourceId',NEW.id,'sourceType','approval','status',NEW.status,'action',NEW.action,'riskClass',NEW.risk_class,'requestedBy',NEW.requested_by,'resourceType',NEW.resource_type,'resourceId',NEW.resource_id,'approvalEpoch',NEW.approval_epoch));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS forge_approval_notification_trigger ON approval_requests;
CREATE TRIGGER forge_approval_notification_trigger AFTER UPDATE OF status ON approval_requests FOR EACH ROW EXECUTE FUNCTION forge_approval_notification_trigger();

CREATE OR REPLACE FUNCTION forge_incident_notification_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.severity IS DISTINCT FROM OLD.severity OR NEW.current_escalation_level IS DISTINCT FROM OLD.current_escalation_level THEN
    PERFORM forge_notification_outbox('incident:'||NEW.id||':'||NEW.status||':'||NEW.current_escalation_level||':'||NEW.occurrence_count,'incident',NEW.tenant_id,NEW.project_id,jsonb_build_object('sourceId',NEW.id,'sourceType','incident','status',NEW.status,'severity',NEW.severity,'title',NEW.title,'summary',NEW.summary,'ownerId',NEW.owner_id,'escalationLevel',NEW.current_escalation_level,'occurrenceCount',NEW.occurrence_count));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS forge_incident_notification_trigger ON operational_incidents;
CREATE TRIGGER forge_incident_notification_trigger AFTER INSERT OR UPDATE OF status,severity,current_escalation_level ON operational_incidents FOR EACH ROW EXECUTE FUNCTION forge_incident_notification_trigger();

CREATE OR REPLACE FUNCTION forge_publish_notification_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('PUBLISHED','FAILED','CANCELLED','QUARANTINED','RECONCILIATION_REQUIRED') AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM forge_notification_outbox('publish:'||NEW.id||':'||NEW.status,'publish',NEW.tenant_id,NEW.project_id,jsonb_build_object('sourceId',NEW.id,'sourceType','publish','status',NEW.status,'destination',NEW.destination,'episodeId',NEW.episode_id,'packageHash',NEW.package_hash,'quarantineReason',NEW.quarantine_reason));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS forge_publish_notification_trigger ON publish_runs;
CREATE TRIGGER forge_publish_notification_trigger AFTER UPDATE OF status ON publish_runs FOR EACH ROW EXECUTE FUNCTION forge_publish_notification_trigger();

CREATE OR REPLACE FUNCTION forge_provider_outage_notification_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.state IS DISTINCT FROM OLD.state OR NEW.brownout_mode IS DISTINCT FROM OLD.brownout_mode) AND (NEW.state IN ('OPEN','HALF_OPEN') OR NEW.brownout_mode <> 'NONE') THEN
    PERFORM forge_notification_outbox('provider:'||NEW.id||':'||NEW.state_version||':'||NEW.brownout_mode,'provider_outage',NEW.tenant_id,NEW.project_id,jsonb_build_object('sourceId',NEW.id::text,'sourceType','provider_outage','provider',NEW.provider,'service',NEW.service,'capability',NEW.capability,'region',NEW.region,'state',NEW.state,'brownoutMode',NEW.brownout_mode,'reason',NEW.brownout_reason,'stateVersion',NEW.state_version));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS forge_provider_outage_notification_trigger ON provider_circuit_breaker_state;
CREATE TRIGGER forge_provider_outage_notification_trigger AFTER UPDATE OF state,brownout_mode ON provider_circuit_breaker_state FOR EACH ROW EXECUTE FUNCTION forge_provider_outage_notification_trigger();

COMMIT;
