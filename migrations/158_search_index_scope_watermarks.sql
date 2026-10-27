BEGIN;

ALTER TABLE forge_search_index_active_scopes
  ADD COLUMN IF NOT EXISTS last_applied_event_id bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_state text;

UPDATE forge_search_index_active_scopes s
SET last_applied_event_id=COALESCE((SELECT g.last_applied_event_id FROM forge_search_index_generations g WHERE g.generation_id=s.active_generation_id),0),
    last_verified_at=now();

CREATE OR REPLACE FUNCTION forge_search_active_generation_trigger() RETURNS trigger AS $$
BEGIN
  IF NEW.state='ACTIVE' THEN
    INSERT INTO forge_search_index_active_scopes(tenant_id,project_id,active_generation_id,generation_epoch,schema_version,last_applied_event_id,last_verified_at,updated_at)
    VALUES(NEW.tenant_id,NEW.project_id,NEW.generation_id,1,NEW.schema_version,NEW.last_applied_event_id,now(),now())
    ON CONFLICT(tenant_id,project_id) DO UPDATE SET
      active_generation_id=EXCLUDED.active_generation_id,
      generation_epoch=forge_search_index_active_scopes.generation_epoch+1,
      schema_version=EXCLUDED.schema_version,
      last_applied_event_id=EXCLUDED.last_applied_event_id,
      last_verified_at=EXCLUDED.last_verified_at,
      failure_state=NULL,
      updated_at=now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_search_active_generation_trigger ON forge_search_index_generations;
CREATE TRIGGER forge_search_active_generation_trigger
AFTER INSERT OR UPDATE OF state ON forge_search_index_generations
FOR EACH ROW EXECUTE FUNCTION forge_search_active_generation_trigger();

COMMIT;
