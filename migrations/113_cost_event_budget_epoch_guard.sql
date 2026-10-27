BEGIN;
CREATE OR REPLACE FUNCTION forge_cost_event_budget_epoch_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.budget_epoch_id IS NULL AND jsonb_array_length(COALESCE(NEW.budget_epoch_ids,'[]'::jsonb)) > 0 THEN
    NEW.budget_epoch_id := (NEW.budget_epoch_ids->>0)::bigint;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS cost_event_budget_epoch_guard ON cost_events;
CREATE TRIGGER cost_event_budget_epoch_guard BEFORE INSERT ON cost_events FOR EACH ROW EXECUTE FUNCTION forge_cost_event_budget_epoch_guard();
COMMIT;
