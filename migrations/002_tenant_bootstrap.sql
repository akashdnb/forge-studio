BEGIN;

-- Tenant isolation is referenced by later production migrations and the API.
-- Bootstrap it immediately after the initial schema so all later migrations
-- can safely assume the project tenant boundary exists.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id text;
CREATE INDEX IF NOT EXISTS projects_tenant_updated_idx ON projects(tenant_id, updated_at DESC);

COMMIT;
