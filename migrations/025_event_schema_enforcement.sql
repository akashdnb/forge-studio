BEGIN;

CREATE OR REPLACE FUNCTION forge_event_schema_registry_guard() RETURNS trigger AS $$
DECLARE
  family_row forge_event_schema_families%ROWTYPE;
  schema_row forge_event_schemas%ROWTYPE;
BEGIN
  SELECT * INTO family_row
  FROM forge_event_schema_families
  WHERE event_family=NEW.type
    AND (tenant_id=NEW.tenant_id OR tenant_id IS NULL)
  ORDER BY CASE WHEN tenant_id=NEW.tenant_id THEN 0 ELSE 1 END
  LIMIT 1;
  IF family_row.id IS NULL THEN
    RAISE EXCEPTION 'event schema family is not registered: %', NEW.type USING ERRCODE='23514';
  END IF;
  SELECT * INTO schema_row
  FROM forge_event_schemas
  WHERE family_id=family_row.id AND version=NEW.version;
  IF schema_row.id IS NULL THEN
    RAISE EXCEPTION 'event schema version is not registered: % v%', NEW.type, NEW.version USING ERRCODE='23514';
  END IF;
  IF schema_row.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'event schema version is not active: % v%', NEW.type, NEW.version USING ERRCODE='23514';
  END IF;
  NEW.schema := schema_row.schema;
  NEW.provenance := coalesce(NEW.provenance,'{}'::jsonb) || jsonb_build_object('schemaFingerprint',schema_row.fingerprint,'schemaRegistryId',schema_row.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS forge_event_schema_registry_guard ON forge_events;
CREATE TRIGGER forge_event_schema_registry_guard
  BEFORE INSERT ON forge_events
  FOR EACH ROW EXECUTE FUNCTION forge_event_schema_registry_guard();

CREATE INDEX IF NOT EXISTS forge_event_schema_lookup_idx
  ON forge_event_schema_families(event_family, tenant_id);

COMMIT;
