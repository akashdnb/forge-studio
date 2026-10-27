BEGIN;

CREATE OR REPLACE FUNCTION forge_schedule_fence_guard() RETURNS trigger AS $$
DECLARE current_epoch bigint;
BEGIN
  IF NEW.status = 'CLAIMED' OR (OLD.status = 'CLAIMED' AND NEW.status = 'TRIGGERED') THEN
    SELECT fencing_epoch INTO current_epoch FROM forge_scheduler_control WHERE id=true FOR SHARE;
    IF NEW.lease_fencing_epoch IS NULL OR NEW.lease_fencing_epoch <> current_epoch THEN
      RAISE EXCEPTION 'stale scheduler fencing epoch %; current epoch %', NEW.lease_fencing_epoch, current_epoch USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS forge_schedule_fence_guard ON forge_schedule_occurrences;
CREATE TRIGGER forge_schedule_fence_guard
BEFORE UPDATE ON forge_schedule_occurrences
FOR EACH ROW EXECUTE FUNCTION forge_schedule_fence_guard();

CREATE INDEX IF NOT EXISTS forge_schedule_occurrences_fence_idx ON forge_schedule_occurrences(lease_fencing_epoch, lease_until) WHERE status='CLAIMED';

COMMIT;
