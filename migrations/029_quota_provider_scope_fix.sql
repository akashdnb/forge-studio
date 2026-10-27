BEGIN;

-- Resolve provider project scope through an explicitly named PL/pgSQL variable so
-- project overrides cannot be shadowed by the providers table's project_id column.
CREATE OR REPLACE FUNCTION forge_quota_provider_guard() RETURNS trigger AS $$
DECLARE t text; scope_project_id text; project_limit numeric; tenant_limit numeric; active_count numeric;
BEGIN
  IF NEW.episode_id IS NOT NULL THEN
    SELECT p.tenant_id,p.id INTO t,scope_project_id
    FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=NEW.episode_id;
    IF t IS NULL OR NEW.tenant_id<>t THEN RAISE EXCEPTION 'provider tenant mismatch' USING ERRCODE='P0001'; END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.episode_id IS NOT NULL THEN
    SELECT provider_executions INTO project_limit FROM forge_quota_policies
      WHERE tenant_id=NEW.tenant_id AND project_id=scope_project_id AND active=true ORDER BY version DESC LIMIT 1;
    SELECT provider_executions INTO tenant_limit FROM forge_quota_policies
      WHERE tenant_id=NEW.tenant_id AND project_id IS NULL AND active=true ORDER BY version DESC LIMIT 1;
    IF project_limit IS NOT NULL THEN
      SELECT count(*) INTO active_count FROM provider_runs r JOIN episodes e ON e.id=r.episode_id
        WHERE r.tenant_id=NEW.tenant_id AND e.project_id=scope_project_id AND r.status IN ('QUEUED','RUNNING');
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

COMMIT;
