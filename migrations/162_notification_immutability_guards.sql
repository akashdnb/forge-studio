BEGIN;

CREATE OR REPLACE FUNCTION forge_notification_intent_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.intent_key<>OLD.intent_key OR NEW.intent_version<>OLD.intent_version OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id OR NEW.source_type<>OLD.source_type OR NEW.template_name<>OLD.template_name OR NEW.template_version<>OLD.template_version OR NEW.payload<>OLD.payload OR NEW.priority<>OLD.priority OR NEW.dedupe_key<>OLD.dedupe_key OR NEW.quiet_hours<>OLD.quiet_hours OR NEW.escalation_policy<>OLD.escalation_policy OR NEW.created_by<>OLD.created_by THEN
    RAISE EXCEPTION 'notification intent identity and payload are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS forge_notification_intent_immutable_guard ON forge_notification_intents;
CREATE TRIGGER forge_notification_intent_immutable_guard BEFORE UPDATE ON forge_notification_intents FOR EACH ROW EXECUTE FUNCTION forge_notification_intent_immutable_guard();

CREATE OR REPLACE FUNCTION forge_notification_attempt_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'notification delivery attempts are immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS forge_notification_attempt_immutable_guard ON forge_notification_attempts;
CREATE TRIGGER forge_notification_attempt_immutable_guard BEFORE UPDATE OR DELETE ON forge_notification_attempts FOR EACH ROW EXECUTE FUNCTION forge_notification_attempt_immutable_guard();

COMMIT;
