BEGIN;

CREATE TABLE IF NOT EXISTS forge_search_index_active_scopes (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  active_generation_id text NOT NULL REFERENCES forge_search_index_generations(generation_id),
  generation_epoch bigint NOT NULL DEFAULT 1,
  schema_version integer NOT NULL DEFAULT 2,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id, project_id)
);
CREATE INDEX IF NOT EXISTS forge_search_index_active_scopes_generation_idx
  ON forge_search_index_active_scopes(active_generation_id);

INSERT INTO forge_search_index_active_scopes(tenant_id,project_id,active_generation_id)
SELECT t.id,NULL,'legacy-v1' FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM forge_search_index_active_scopes s WHERE s.tenant_id=t.id AND s.project_id IS NULL);

INSERT INTO forge_search_index_active_scopes(tenant_id,project_id,active_generation_id)
SELECT p.tenant_id,p.id,'legacy-v1' FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM forge_search_index_active_scopes s WHERE s.tenant_id=p.tenant_id AND s.project_id=p.id);

CREATE OR REPLACE FUNCTION forge_search_active_generation_trigger() RETURNS trigger AS $$
BEGIN
  IF NEW.state='ACTIVE' THEN
    INSERT INTO forge_search_index_active_scopes(tenant_id,project_id,active_generation_id,generation_epoch,schema_version,updated_at)
    VALUES(NEW.tenant_id,NEW.project_id,NEW.generation_id,1,NEW.schema_version,now())
    ON CONFLICT(tenant_id,project_id) DO UPDATE SET
      active_generation_id=EXCLUDED.active_generation_id,
      generation_epoch=forge_search_index_active_scopes.generation_epoch+1,
      schema_version=EXCLUDED.schema_version,
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
