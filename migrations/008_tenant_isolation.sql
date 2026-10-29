BEGIN;

-- Projects are the tenant boundary used by the production API and scheduler.
-- Keep the column nullable for legacy databases; newly-created projects are
-- required to receive the authenticated tenant id from the API layer.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id text;
CREATE INDEX IF NOT EXISTS projects_tenant_updated_idx ON projects(tenant_id, updated_at DESC);

COMMIT;
