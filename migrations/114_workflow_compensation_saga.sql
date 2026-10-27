BEGIN;
CREATE OR REPLACE FUNCTION forge_compensation_release_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='SUCCEEDED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE usage_reservations r SET status='RELEASED',terminal_reason='SAGA_COMPENSATED',settled_at=COALESCE(settled_at,now())
    WHERE r.status='HELD' AND EXISTS(SELECT 1 FROM forge_compensation_side_effects e WHERE e.step_id=NEW.id AND e.job_id=r.job_id AND e.attempt=r.attempt);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS forge_compensation_release_reservation ON forge_compensation_steps;
CREATE TRIGGER forge_compensation_release_reservation AFTER UPDATE OF status ON forge_compensation_steps FOR EACH ROW EXECUTE FUNCTION forge_compensation_release_reservation();
COMMIT;
