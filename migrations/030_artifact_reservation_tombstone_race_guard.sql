BEGIN;
CREATE OR REPLACE FUNCTION forge_artifact_reservation_insert() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM artifact_content_objects
    WHERE id=NEW.object_id
      AND tenant_id=NEW.tenant_id
      AND status IN ('READY','QUARANTINED')
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'content object unavailable for reservation'; END IF;
  IF NEW.state='HELD' THEN
    UPDATE artifact_content_objects SET reservation_count=reservation_count+1 WHERE id=NEW.object_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
