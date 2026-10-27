BEGIN;

CREATE OR REPLACE FUNCTION forge_mirror_security_audit() RETURNS trigger AS $$
BEGIN
  INSERT INTO security_audit_events(project_id,actor,action,target_type,target_id,request_id,outcome,details)
  VALUES(NEW.project_id,NEW.actor,NEW.action,NEW.target_type,NEW.target_id,NEW.request_id,'ALLOWED',COALESCE(NEW.details,'{}'::jsonb));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_security_mirror ON audit_events;
CREATE TRIGGER audit_events_security_mirror AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION forge_mirror_security_audit();

COMMIT;
