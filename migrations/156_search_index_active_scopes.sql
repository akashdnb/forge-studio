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

COMMIT;
