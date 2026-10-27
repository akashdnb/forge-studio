BEGIN;

-- Serialize reservation admission per tenant/project/dimension at the database boundary.
-- This closes the classic read-then-insert race between independent API/worker processes.
CREATE OR REPLACE FUNCTION forge_quota_reservation_guard() RETURNS trigger AS $$
DECLARE scope_key text; lock_key bigint; limit_value numeric; held numeric; dry_run boolean;
BEGIN
  scope_key:=NEW.tenant_id||':'||COALESCE(NEW.project_id,'*')||':'||NEW.dimension;
  lock_key:=hashtext('forge-quota-reservation:'||scope_key);
  PERFORM pg_advisory_xact_lock(lock_key);

  IF NEW.project_id IS NOT NULL AND forge_quota_project_tenant(NEW.project_id)<>NEW.tenant_id THEN
    RAISE EXCEPTION 'quota tenant/project mismatch' USING ERRCODE='P0001';
  END IF;

  SELECT CASE NEW.dimension
    WHEN 'concurrent_jobs' THEN concurrent_jobs WHEN 'provider_executions' THEN provider_executions
    WHEN 'artifact_bytes' THEN artifact_bytes WHEN 'storage_operations' THEN storage_operations
    WHEN 'runner_executions' THEN runner_executions WHEN 'cpu_ms' THEN cpu_ms WHEN 'wall_time_ms' THEN wall_time_ms
  END, dry_run INTO limit_value,dry_run
  FROM forge_quota_policies WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND active=true ORDER BY version DESC LIMIT 1;
  IF limit_value IS NULL AND NEW.project_id IS NOT NULL THEN
    SELECT CASE NEW.dimension
      WHEN 'concurrent_jobs' THEN concurrent_jobs WHEN 'provider_executions' THEN provider_executions
      WHEN 'artifact_bytes' THEN artifact_bytes WHEN 'storage_operations' THEN storage_operations
      WHEN 'runner_executions' THEN runner_executions WHEN 'cpu_ms' THEN cpu_ms WHEN 'wall_time_ms' THEN wall_time_ms
    END, dry_run INTO limit_value,dry_run
    FROM forge_quota_policies WHERE tenant_id=NEW.tenant_id AND project_id IS NULL AND active=true ORDER BY version DESC LIMIT 1;
  END IF;
  IF limit_value IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(dry_run,false) THEN RETURN NEW; END IF;

  SELECT COALESCE(sum(amount),0) INTO held FROM forge_quota_reservations
  WHERE tenant_id=NEW.tenant_id AND project_id IS NOT DISTINCT FROM NEW.project_id AND dimension=NEW.dimension
    AND status='HELD' AND expires_at>now();
  IF held+NEW.amount>limit_value THEN
    RAISE EXCEPTION 'quota exceeded: % limit=% held=% requested=%',NEW.dimension,limit_value,held,NEW.amount USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_quota_reservation_guard ON forge_quota_reservations;
CREATE TRIGGER forge_quota_reservation_guard BEFORE INSERT ON forge_quota_reservations FOR EACH ROW EXECUTE FUNCTION forge_quota_reservation_guard();

COMMIT;
