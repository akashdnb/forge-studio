BEGIN;

-- Derive durable tenant identity from authoritative ownership before enforcing limits.
-- Existing callers do not need to know about the governance columns, and cannot spoof them.
CREATE OR REPLACE FUNCTION forge_quota_job_tenant_guard() RETURNS trigger AS $$
DECLARE t text; project_limit numeric; tenant_limit numeric; active_count numeric;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    t:=forge_quota_project_tenant(NEW.project_id);
    IF t IS NULL THEN RAISE EXCEPTION 'project tenant not found' USING ERRCODE='P0001'; END IF;
    NEW.tenant_id:=t;
  ELSE
    NEW.tenant_id:=COALESCE(NEW.tenant_id,'tenant:system');
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
DECLARE t text; scope_project_id text; project_limit numeric; tenant_limit numeric; active_count numeric;
BEGIN
  IF NEW.episode_id IS NOT NULL THEN
    SELECT p.tenant_id,p.id INTO t,scope_project_id FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=NEW.episode_id;
    IF t IS NULL THEN RAISE EXCEPTION 'provider project tenant not found' USING ERRCODE='P0001'; END IF;
    NEW.tenant_id:=t;
  ELSE
    NEW.tenant_id:=COALESCE(NEW.tenant_id,'tenant:system');
  END IF;
  IF TG_OP='INSERT' AND NEW.episode_id IS NOT NULL THEN
    SELECT provider_executions INTO project_limit FROM forge_quota_policies WHERE tenant_id=NEW.tenant_id AND project_id=scope_project_id AND active=true ORDER BY version DESC LIMIT 1;
    SELECT provider_executions INTO tenant_limit FROM forge_quota_policies WHERE tenant_id=NEW.tenant_id AND project_id IS NULL AND active=true ORDER BY version DESC LIMIT 1;
    IF project_limit IS NOT NULL THEN
      SELECT count(*) INTO active_count FROM provider_runs r JOIN episodes e ON e.id=r.episode_id WHERE r.tenant_id=NEW.tenant_id AND e.project_id=scope_project_id AND r.status IN ('QUEUED','RUNNING');
      IF active_count+1>project_limit THEN RAISE EXCEPTION 'quota exceeded: project provider_executions limit=%',project_limit USING ERRCODE='P0001'; END IF;
    ELSIF tenant_limit IS NOT NULL THEN
      SELECT count(*) INTO active_count FROM provider_runs WHERE tenant_id=NEW.tenant_id AND status IN ('QUEUED','RUNNING');
      IF active_count+1>tenant_limit THEN RAISE EXCEPTION 'quota exceeded: tenant provider_executions limit=%',tenant_limit USING ERRCODE='P0001'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_provider_guard ON provider_runs;
CREATE TRIGGER forge_quota_provider_guard BEFORE INSERT OR UPDATE OF episode_id,tenant_id ON provider_runs FOR EACH ROW EXECUTE FUNCTION forge_quota_provider_guard();

CREATE OR REPLACE FUNCTION forge_quota_storage_guard() RETURNS trigger AS $$
DECLARE t text; lim numeric; used numeric;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    t:=forge_quota_project_tenant(NEW.project_id);
    IF t IS NULL THEN RAISE EXCEPTION 'storage project tenant not found' USING ERRCODE='P0001'; END IF;
    NEW.tenant_id:=t;
  ELSE
    NEW.tenant_id:=COALESCE(NEW.tenant_id,'tenant:system');
  END IF;
  lim:=forge_quota_limit(NEW.tenant_id,NEW.project_id,'artifact_bytes');
  IF lim IS NULL THEN lim:=forge_quota_limit(NEW.tenant_id,NULL,'artifact_bytes'); END IF;
  IF lim IS NOT NULL THEN
    SELECT COALESCE(sum(size_bytes),0) INTO used FROM storage_objects WHERE tenant_id=NEW.tenant_id AND (NEW.project_id IS NULL OR project_id=NEW.project_id) AND id<>COALESCE(NEW.id,'');
    IF used+COALESCE(NEW.size_bytes,0)>lim THEN RAISE EXCEPTION 'quota exceeded: artifact_bytes limit=%',lim USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_storage_guard ON storage_objects;
CREATE TRIGGER forge_quota_storage_guard BEFORE INSERT OR UPDATE OF size_bytes,project_id,tenant_id ON storage_objects FOR EACH ROW EXECUTE FUNCTION forge_quota_storage_guard();

CREATE OR REPLACE FUNCTION forge_quota_execution_guard() RETURNS trigger AS $$
DECLARE t text; lim numeric; active_count numeric;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    t:=forge_quota_project_tenant(NEW.project_id);
    IF t IS NULL THEN RAISE EXCEPTION 'runner project tenant not found' USING ERRCODE='P0001'; END IF;
    NEW.tenant_key:=t;
  END IF;
  IF NEW.project_id IS NOT NULL THEN
    lim:=forge_quota_limit(NEW.tenant_key,NEW.project_id,'runner_executions');
    IF lim IS NULL THEN lim:=forge_quota_limit(NEW.tenant_key,NULL,'runner_executions'); END IF;
    IF TG_OP='INSERT' AND lim IS NOT NULL THEN
      SELECT count(*) INTO active_count FROM forge_execution_runs WHERE tenant_key=NEW.tenant_key AND status IN ('DISPATCHING','QUEUED','IN_PROGRESS');
      IF active_count+1>lim THEN RAISE EXCEPTION 'quota exceeded: runner_executions limit=%',lim USING ERRCODE='P0001'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_execution_guard ON forge_execution_runs;
CREATE TRIGGER forge_quota_execution_guard BEFORE INSERT OR UPDATE OF project_id,tenant_key,status ON forge_execution_runs FOR EACH ROW EXECUTE FUNCTION forge_quota_execution_guard();

COMMIT;
