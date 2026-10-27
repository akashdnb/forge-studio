BEGIN;

-- Production tenant/project resource governance. Policies are hierarchical: project
-- values override tenant values when non-null. All accounting is keyed by immutable
-- tenant/project identity and uses PostgreSQL transactions for cross-process safety.
CREATE TABLE IF NOT EXISTS forge_quota_policies (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  dry_run boolean NOT NULL DEFAULT false,
  requests_per_minute bigint,
  request_burst bigint,
  concurrent_jobs bigint,
  provider_executions bigint,
  artifact_bytes bigint,
  storage_operations bigint,
  runner_executions bigint,
  cpu_ms bigint,
  wall_time_ms bigint,
  reset_interval_seconds integer NOT NULL DEFAULT 86400,
  fairness_weight numeric(12,4) NOT NULL DEFAULT 1,
  sensitive_fail_closed boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requests_per_minute IS NULL OR requests_per_minute >= 0),
  CHECK (request_burst IS NULL OR request_burst >= 0),
  CHECK (concurrent_jobs IS NULL OR concurrent_jobs >= 0),
  CHECK (provider_executions IS NULL OR provider_executions >= 0),
  CHECK (artifact_bytes IS NULL OR artifact_bytes >= 0),
  CHECK (storage_operations IS NULL OR storage_operations >= 0),
  CHECK (runner_executions IS NULL OR runner_executions >= 0),
  CHECK (cpu_ms IS NULL OR cpu_ms >= 0),
  CHECK (wall_time_ms IS NULL OR wall_time_ms >= 0),
  CHECK (reset_interval_seconds BETWEEN 60 AND 31536000),
  CHECK (fairness_weight > 0 AND fairness_weight <= 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_quota_policy_tenant_uq ON forge_quota_policies(tenant_id) WHERE project_id IS NULL AND active;
CREATE UNIQUE INDEX IF NOT EXISTS forge_quota_policy_project_uq ON forge_quota_policies(tenant_id,project_id) WHERE project_id IS NOT NULL AND active;
CREATE INDEX IF NOT EXISTS forge_quota_policy_scope_idx ON forge_quota_policies(tenant_id,project_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS forge_quota_policy_history (
  id bigserial PRIMARY KEY, policy_id bigint NOT NULL REFERENCES forge_quota_policies(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text, version bigint NOT NULL,
  snapshot jsonb NOT NULL, actor text NOT NULL, request_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_quota_policy_history_scope_idx ON forge_quota_policy_history(tenant_id,project_id,created_at DESC);
CREATE TABLE IF NOT EXISTS forge_quota_reservations (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  dimension text NOT NULL CHECK (dimension IN ('concurrent_jobs','provider_executions','artifact_bytes','storage_operations','runner_executions','cpu_ms','wall_time_ms')),
  amount numeric(30,0) NOT NULL CHECK (amount >= 0), idempotency_key text NOT NULL UNIQUE, resource_type text NOT NULL, resource_id text NOT NULL,
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','SETTLED','RELEASED','EXPIRED')), policy_version bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL, actual_amount numeric(30,0), metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz, released_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_quota_reservations_active_idx ON forge_quota_reservations(tenant_id,project_id,dimension,status,expires_at) WHERE status='HELD';
CREATE INDEX IF NOT EXISTS forge_quota_reservations_expiry_idx ON forge_quota_reservations(expires_at) WHERE status='HELD';
CREATE INDEX IF NOT EXISTS forge_quota_reservations_resource_idx ON forge_quota_reservations(resource_type,resource_id,status);
CREATE TABLE IF NOT EXISTS forge_quota_usage (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text,
  dimension text NOT NULL CHECK (dimension IN ('requests','provider_executions','artifact_bytes','storage_operations','runner_executions','cpu_ms','wall_time_ms')),
  period_start timestamptz NOT NULL, consumed numeric(30,0) NOT NULL DEFAULT 0 CHECK (consumed >= 0), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,project_id,dimension,period_start)
);
CREATE INDEX IF NOT EXISTS forge_quota_usage_scope_idx ON forge_quota_usage(tenant_id,project_id,dimension,period_start DESC);
CREATE TABLE IF NOT EXISTS forge_quota_usage_events (
  id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text,
  dimension text NOT NULL CHECK (dimension IN ('requests','provider_executions','artifact_bytes','storage_operations','runner_executions','cpu_ms','wall_time_ms')),
  amount numeric(30,0) NOT NULL CHECK (amount >= 0), resource_type text NOT NULL, resource_id text NOT NULL, period_start timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(dimension,resource_type,resource_id)
);
CREATE INDEX IF NOT EXISTS forge_quota_usage_events_scope_idx ON forge_quota_usage_events(tenant_id,project_id,dimension,period_start DESC);
CREATE TABLE IF NOT EXISTS forge_quota_rate_buckets (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, operation text NOT NULL, bucket_key text NOT NULL,
  tokens numeric(30,6) NOT NULL, last_refill_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,operation,bucket_key)
);
CREATE INDEX IF NOT EXISTS forge_quota_rate_bucket_updated_idx ON forge_quota_rate_buckets(updated_at);
CREATE TABLE IF NOT EXISTS forge_quota_fairness (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT, served_count numeric(30,6) NOT NULL DEFAULT 0,
  weight numeric(12,4) NOT NULL DEFAULT 1, last_claim_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS forge_quota_audit (
  id bigserial PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text, actor text NOT NULL,
  action text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('ALLOWED','DENIED','DRY_RUN','FAILED')), dimension text,
  amount numeric(30,0), policy_version bigint, request_id text, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_quota_audit_scope_idx ON forge_quota_audit(tenant_id,project_id,created_at DESC);

INSERT INTO tenants(id,name,created_by) VALUES ('tenant:system','Forge System','migration-runner'),('tenant:anonymous','Anonymous Admission','migration-runner') ON CONFLICT(id) DO NOTHING;

ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE forge_jobs j SET tenant_id=p.tenant_id FROM projects p WHERE p.id=j.project_id AND j.tenant_id IS NULL;
UPDATE forge_jobs SET tenant_id='tenant:system' WHERE tenant_id IS NULL;
ALTER TABLE forge_jobs ALTER COLUMN tenant_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE forge_jobs ADD CONSTRAINT forge_jobs_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS forge_jobs_tenant_claim_idx ON forge_jobs(tenant_id,status,priority,created_at);

ALTER TABLE provider_runs ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE provider_runs r SET tenant_id=p.tenant_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=r.episode_id AND r.tenant_id IS NULL;
UPDATE provider_runs SET tenant_id='tenant:system' WHERE tenant_id IS NULL;
ALTER TABLE provider_runs ALTER COLUMN tenant_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE provider_runs ADD CONSTRAINT provider_runs_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS provider_runs_tenant_status_idx ON provider_runs(tenant_id,status,created_at);

ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE storage_objects s SET tenant_id=p.tenant_id FROM projects p WHERE p.id=s.project_id AND s.tenant_id IS NULL;
UPDATE storage_objects SET tenant_id='tenant:system' WHERE tenant_id IS NULL;
ALTER TABLE storage_objects ALTER COLUMN tenant_id SET NOT NULL;
DO $$ BEGIN ALTER TABLE storage_objects ADD CONSTRAINT storage_objects_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS storage_objects_tenant_idx ON storage_objects(tenant_id,project_id,created_at DESC);

CREATE OR REPLACE FUNCTION forge_quota_project_tenant(p_project_id text) RETURNS text AS $$ DECLARE t text; BEGIN SELECT tenant_id INTO t FROM projects WHERE id=p_project_id; RETURN t; END; $$ LANGUAGE plpgsql STABLE;
CREATE OR REPLACE FUNCTION forge_quota_limit(p_tenant_id text,p_project_id text,p_dimension text) RETURNS numeric AS $$ DECLARE v numeric; BEGIN
SELECT CASE p_dimension WHEN 'concurrent_jobs' THEN concurrent_jobs WHEN 'provider_executions' THEN provider_executions WHEN 'artifact_bytes' THEN artifact_bytes WHEN 'storage_operations' THEN storage_operations WHEN 'runner_executions' THEN runner_executions WHEN 'cpu_ms' THEN cpu_ms WHEN 'wall_time_ms' THEN wall_time_ms END INTO v FROM forge_quota_policies WHERE tenant_id=p_tenant_id AND project_id=p_project_id AND active=true ORDER BY version DESC LIMIT 1;
IF v IS NOT NULL OR p_project_id IS NULL THEN RETURN v; END IF;
SELECT CASE p_dimension WHEN 'concurrent_jobs' THEN concurrent_jobs WHEN 'provider_executions' THEN provider_executions WHEN 'artifact_bytes' THEN artifact_bytes WHEN 'storage_operations' THEN storage_operations WHEN 'runner_executions' THEN runner_executions WHEN 'cpu_ms' THEN cpu_ms WHEN 'wall_time_ms' THEN wall_time_ms END INTO v FROM forge_quota_policies WHERE tenant_id=p_tenant_id AND project_id IS NULL AND active=true ORDER BY version DESC LIMIT 1; RETURN v; END; $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION forge_quota_job_tenant_guard() RETURNS trigger AS $$ DECLARE t text; lim numeric; active_count numeric; BEGIN
IF NEW.project_id IS NOT NULL THEN t:=forge_quota_project_tenant(NEW.project_id); IF t IS NULL OR NEW.tenant_id<>t THEN RAISE EXCEPTION 'quota tenant/project mismatch'; END IF; END IF;
IF TG_OP='INSERT' AND NEW.project_id IS NOT NULL THEN lim:=forge_quota_limit(NEW.tenant_id,NEW.project_id,'concurrent_jobs'); IF lim IS NULL THEN lim:=forge_quota_limit(NEW.tenant_id,NULL,'concurrent_jobs'); END IF; IF lim IS NOT NULL THEN SELECT count(*) INTO active_count FROM forge_jobs WHERE tenant_id=NEW.tenant_id AND status IN ('QUEUED','RUNNING') AND project_id=NEW.project_id; IF active_count+1>lim THEN RAISE EXCEPTION 'quota exceeded: concurrent_jobs limit=%',lim; END IF; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_job_tenant_guard ON forge_jobs; CREATE TRIGGER forge_quota_job_tenant_guard BEFORE INSERT OR UPDATE OF project_id,tenant_id ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_quota_job_tenant_guard();

CREATE OR REPLACE FUNCTION forge_quota_provider_guard() RETURNS trigger AS $$ DECLARE t text; lim numeric; active_count numeric; BEGIN
IF NEW.episode_id IS NOT NULL THEN SELECT p.tenant_id INTO t FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=NEW.episode_id; IF t IS NULL OR NEW.tenant_id<>t THEN RAISE EXCEPTION 'provider tenant mismatch'; END IF; END IF;
IF TG_OP='INSERT' AND NEW.episode_id IS NOT NULL THEN lim:=forge_quota_limit(NEW.tenant_id,NULL,'provider_executions'); IF lim IS NOT NULL THEN SELECT count(*) INTO active_count FROM provider_runs WHERE tenant_id=NEW.tenant_id AND status IN ('QUEUED','RUNNING'); IF active_count+1>lim THEN RAISE EXCEPTION 'quota exceeded: provider_executions limit=%',lim; END IF; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_provider_guard ON provider_runs; CREATE TRIGGER forge_quota_provider_guard BEFORE INSERT OR UPDATE OF episode_id,tenant_id ON provider_runs FOR EACH ROW EXECUTE FUNCTION forge_quota_provider_guard();

CREATE OR REPLACE FUNCTION forge_quota_storage_guard() RETURNS trigger AS $$ DECLARE lim numeric; used numeric; BEGIN
IF NEW.project_id IS NOT NULL AND forge_quota_project_tenant(NEW.project_id)<>NEW.tenant_id THEN RAISE EXCEPTION 'storage tenant/project mismatch'; END IF; lim:=forge_quota_limit(NEW.tenant_id,NEW.project_id,'artifact_bytes'); IF lim IS NULL THEN lim:=forge_quota_limit(NEW.tenant_id,NULL,'artifact_bytes'); END IF; IF lim IS NOT NULL THEN SELECT COALESCE(sum(size_bytes),0) INTO used FROM storage_objects WHERE tenant_id=NEW.tenant_id AND (NEW.project_id IS NULL OR project_id=NEW.project_id) AND id<>COALESCE(NEW.id,''); IF used+COALESCE(NEW.size_bytes,0)>lim THEN RAISE EXCEPTION 'quota exceeded: artifact_bytes limit=%',lim; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_storage_guard ON storage_objects; CREATE TRIGGER forge_quota_storage_guard BEFORE INSERT OR UPDATE OF size_bytes,project_id,tenant_id ON storage_objects FOR EACH ROW EXECUTE FUNCTION forge_quota_storage_guard();

CREATE OR REPLACE FUNCTION forge_quota_storage_event() RETURNS trigger AS $$ DECLARE lim numeric; used numeric; BEGIN
IF TG_OP='INSERT' THEN lim:=forge_quota_limit(NEW.tenant_id,NEW.project_id,'storage_operations'); IF lim IS NULL THEN lim:=forge_quota_limit(NEW.tenant_id,NULL,'storage_operations'); END IF; IF lim IS NOT NULL THEN SELECT COALESCE(sum(amount),0) INTO used FROM forge_quota_usage_events WHERE tenant_id=NEW.tenant_id AND dimension='storage_operations' AND period_start=date_trunc('day',now()) AND (NEW.project_id IS NULL OR project_id=NEW.project_id); IF used+1>lim THEN RAISE EXCEPTION 'quota exceeded: storage_operations limit=%',lim; END IF; END IF; INSERT INTO forge_quota_usage_events(id,tenant_id,project_id,dimension,amount,resource_type,resource_id,period_start) VALUES('storage:'||NEW.id,NEW.tenant_id,NEW.project_id,'storage_operations',1,'storage_object',NEW.id,date_trunc('day',now())) ON CONFLICT(dimension,resource_type,resource_id) DO NOTHING; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_storage_event ON storage_objects; CREATE TRIGGER forge_quota_storage_event AFTER INSERT ON storage_objects FOR EACH ROW EXECUTE FUNCTION forge_quota_storage_event();

CREATE OR REPLACE FUNCTION forge_quota_execution_guard() RETURNS trigger AS $$ DECLARE t text; lim numeric; active_count numeric; BEGIN
IF NEW.project_id IS NOT NULL THEN t:=forge_quota_project_tenant(NEW.project_id); IF t IS NOT NULL AND COALESCE(NEW.tenant_key,'')<>t THEN RAISE EXCEPTION 'runner tenant/project mismatch'; END IF; lim:=forge_quota_limit(t,NEW.project_id,'runner_executions'); IF lim IS NULL THEN lim:=forge_quota_limit(t,NULL,'runner_executions'); END IF; IF TG_OP='INSERT' AND lim IS NOT NULL THEN SELECT count(*) INTO active_count FROM forge_execution_runs WHERE tenant_key=t AND status IN ('DISPATCHING','QUEUED','IN_PROGRESS'); IF active_count+1>lim THEN RAISE EXCEPTION 'quota exceeded: runner_executions limit=%',lim; END IF; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_execution_guard ON forge_execution_runs; CREATE TRIGGER forge_quota_execution_guard BEFORE INSERT OR UPDATE OF project_id,tenant_key,status ON forge_execution_runs FOR EACH ROW EXECUTE FUNCTION forge_quota_execution_guard();
CREATE INDEX IF NOT EXISTS forge_quota_jobs_fair_idx ON forge_jobs(tenant_id,status,priority,created_at) WHERE status='QUEUED';
COMMIT;
