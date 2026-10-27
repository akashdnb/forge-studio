BEGIN;

-- Close two bypass classes left intentionally out of the first migration: tenant-wide
-- concurrent-job enforcement when no project override exists, and durable CPU/wall-time
-- consumption derived from the immutable terminal job result.
CREATE OR REPLACE FUNCTION forge_quota_job_tenant_guard() RETURNS trigger AS $$
DECLARE t text; project_limit numeric; tenant_limit numeric; active_count numeric;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    t:=forge_quota_project_tenant(NEW.project_id);
    IF t IS NULL OR NEW.tenant_id<>t THEN RAISE EXCEPTION 'quota tenant/project mismatch'; END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.project_id IS NOT NULL THEN
    SELECT concurrent_jobs INTO project_limit FROM forge_quota_policies WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND active=true ORDER BY version DESC LIMIT 1;
    SELECT concurrent_jobs INTO tenant_limit FROM forge_quota_policies WHERE tenant_id=NEW.tenant_id AND project_id IS NULL AND active=true ORDER BY version DESC LIMIT 1;
    IF project_limit IS NOT NULL THEN
      SELECT count(*) INTO active_count FROM forge_jobs WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND status IN ('QUEUED','RUNNING');
      IF active_count+1>project_limit THEN RAISE EXCEPTION 'quota exceeded: project concurrent_jobs limit=%',project_limit USING ERRCODE='P0001'; END IF;
    ELSIF tenant_limit IS NOT NULL THEN
      SELECT count(*) INTO active_count FROM forge_jobs WHERE tenant_id=NEW.tenant_id AND status IN ('QUEUED','RUNNING');
      IF active_count+1>tenant_limit THEN RAISE EXCEPTION 'quota exceeded: tenant concurrent_jobs limit=%',tenant_limit USING ERRCODE='P0001'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_job_tenant_guard ON forge_jobs;
CREATE TRIGGER forge_quota_job_tenant_guard BEFORE INSERT OR UPDATE OF project_id,tenant_id ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_quota_job_tenant_guard();

CREATE OR REPLACE FUNCTION forge_quota_provider_guard() RETURNS trigger AS $$
DECLARE t text; project_limit numeric; tenant_limit numeric; active_count numeric; project_id text;
BEGIN
  IF NEW.episode_id IS NOT NULL THEN
    SELECT p.tenant_id,p.id INTO t,project_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=NEW.episode_id;
    IF t IS NULL OR NEW.tenant_id<>t THEN RAISE EXCEPTION 'provider tenant mismatch'; END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.episode_id IS NOT NULL THEN
    SELECT provider_executions INTO project_limit FROM forge_quota_policies WHERE tenant_id=NEW.tenant_id AND project_id=project_id AND active=true ORDER BY version DESC LIMIT 1;
    SELECT provider_executions INTO tenant_limit FROM forge_quota_policies WHERE tenant_id=NEW.tenant_id AND project_id IS NULL AND active=true ORDER BY version DESC LIMIT 1;
    IF project_limit IS NOT NULL THEN
      SELECT count(*) INTO active_count FROM provider_runs r JOIN episodes e ON e.id=r.episode_id WHERE r.tenant_id=NEW.tenant_id AND e.project_id=project_id AND r.status IN ('QUEUED','RUNNING');
      IF active_count+1>project_limit THEN RAISE EXCEPTION 'quota exceeded: project provider_executions limit=%',project_limit; END IF;
    ELSIF tenant_limit IS NOT NULL THEN
      SELECT count(*) INTO active_count FROM provider_runs WHERE tenant_id=NEW.tenant_id AND status IN ('QUEUED','RUNNING');
      IF active_count+1>tenant_limit THEN RAISE EXCEPTION 'quota exceeded: tenant provider_executions limit=%',tenant_limit; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_provider_guard ON provider_runs;
CREATE TRIGGER forge_quota_provider_guard BEFORE INSERT OR UPDATE OF episode_id,tenant_id ON provider_runs FOR EACH ROW EXECUTE FUNCTION forge_quota_provider_guard();

CREATE OR REPLACE FUNCTION forge_quota_job_terminal_usage() RETURNS trigger AS $$
DECLARE t text; interval_seconds integer; start_at timestamptz; wall_ms bigint; cpu_ms_value bigint;
BEGIN
  IF OLD.status NOT IN ('SUCCEEDED','FAILED','CANCELLED') AND NEW.status IN ('SUCCEEDED','FAILED','CANCELLED') THEN
    t:=NEW.tenant_id;
    SELECT COALESCE(reset_interval_seconds,86400) INTO interval_seconds FROM forge_quota_policies WHERE tenant_id=t AND project_id IS NULL AND active=true ORDER BY version DESC LIMIT 1;
    interval_seconds:=GREATEST(60,LEAST(COALESCE(interval_seconds,86400),31536000));
    start_at:=to_timestamp(floor(extract(epoch FROM now())/interval_seconds)*interval_seconds);
    wall_ms:=GREATEST(0,COALESCE((NEW.result->'usageAccounting'->>'durationMs')::bigint,0));
    cpu_ms_value:=GREATEST(0,COALESCE((NEW.result->'usageAccounting'->>'cpuMs')::bigint,wall_ms));
    IF wall_ms>0 THEN INSERT INTO forge_quota_usage_events(id,tenant_id,project_id,dimension,amount,resource_type,resource_id,period_start,metadata) VALUES('job:'||NEW.id||':wall_time_ms',t,NEW.project_id,'wall_time_ms',wall_ms,'job',NEW.id,start_at,jsonb_build_object('status',NEW.status)) ON CONFLICT(dimension,resource_type,resource_id) DO NOTHING; END IF;
    IF cpu_ms_value>0 THEN INSERT INTO forge_quota_usage_events(id,tenant_id,project_id,dimension,amount,resource_type,resource_id,period_start,metadata) VALUES('job:'||NEW.id||':cpu_ms',t,NEW.project_id,'cpu_ms',cpu_ms_value,'job',NEW.id,start_at,jsonb_build_object('status',NEW.status)) ON CONFLICT(dimension,resource_type,resource_id) DO NOTHING; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_job_terminal_usage ON forge_jobs;
CREATE TRIGGER forge_quota_job_terminal_usage AFTER UPDATE OF status,result ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_quota_job_terminal_usage();

COMMIT;
