BEGIN;

CREATE TABLE IF NOT EXISTS ops_command_idempotency (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor, idempotency_key)
);
CREATE INDEX IF NOT EXISTS ops_command_idempotency_created_idx ON ops_command_idempotency(created_at DESC);

CREATE TABLE IF NOT EXISTS ops_confirmation_tokens (
  token_hash char(64) PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  action text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ops_confirmation_tokens_expiry_idx ON ops_confirmation_tokens(expires_at);
CREATE INDEX IF NOT EXISTS ops_confirmation_tokens_scope_idx ON ops_confirmation_tokens(tenant_id, actor, action, expires_at);

CREATE TABLE IF NOT EXISTS ops_controls (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  resource_type text NOT NULL CHECK (resource_type IN ('worker','provider')),
  resource_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS ops_controls_enabled_idx ON ops_controls(tenant_id, resource_type, enabled);

CREATE OR REPLACE FUNCTION forge_guard_disabled_provider() RETURNS trigger AS $$
DECLARE disabled boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM ops_controls c
    WHERE c.tenant_id=(SELECT p.tenant_id FROM projects p JOIN episodes e ON e.project_id=p.id WHERE e.id=NEW.episode_id)
      AND c.resource_type='provider' AND c.resource_id=NEW.provider AND c.enabled=false
  ) INTO disabled;
  IF disabled THEN RAISE EXCEPTION 'provider is disabled by operations control plane' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS provider_run_disabled_guard ON provider_runs;
CREATE TRIGGER provider_run_disabled_guard
BEFORE INSERT OR UPDATE OF provider ON provider_runs
FOR EACH ROW EXECUTE FUNCTION forge_guard_disabled_provider();

CREATE OR REPLACE FUNCTION forge_apply_worker_control() RETURNS trigger AS $$
BEGIN
  IF NEW.resource_type='worker' AND NEW.enabled=false THEN
    UPDATE forge_jobs j
       SET status='QUEUED',
           worker_id='FENCED:' || NEW.resource_id || ':' || NEW.updated_at::text,
           leased_until=NULL,
           dispatch_token=NULL,
           dispatch_generation=dispatch_generation+1,
           available_at=now(),
           updated_at=now(),
           last_schedule_reason=NEW.reason
     FROM projects p
    WHERE j.status='RUNNING'
      AND j.worker_id=NEW.resource_id
      AND j.project_id=p.id
      AND p.tenant_id=NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS worker_control_fence ON ops_controls;
CREATE TRIGGER worker_control_fence
AFTER INSERT OR UPDATE OF enabled,reason ON ops_controls
FOR EACH ROW EXECUTE FUNCTION forge_apply_worker_control();

CREATE OR REPLACE FUNCTION forge_confirmation_token_single_use() RETURNS trigger AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'confirmation token already consumed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS confirmation_token_single_use ON ops_confirmation_tokens;
CREATE TRIGGER confirmation_token_single_use
BEFORE UPDATE OF consumed_at ON ops_confirmation_tokens
FOR EACH ROW EXECUTE FUNCTION forge_confirmation_token_single_use();

COMMIT;
