BEGIN;
CREATE OR REPLACE FUNCTION forge_compensation_skip_empty_steps() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='COMPENSATING' AND OLD.status IS DISTINCT FROM NEW.status THEN UPDATE forge_compensation_steps s SET status='SKIPPED',finished_at=COALESCE(finished_at,now()) WHERE s.plan_id=NEW.id AND s.status IN ('PENDING','FAILED') AND NOT EXISTS(SELECT 1 FROM forge_compensation_side_effects e WHERE e.step_id=s.id); END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS forge_compensation_skip_empty_steps ON forge_compensation_plans;CREATE TRIGGER forge_compensation_skip_empty_steps AFTER UPDATE OF status ON forge_compensation_plans FOR EACH ROW EXECUTE FUNCTION forge_compensation_skip_empty_steps();
COMMIT;
