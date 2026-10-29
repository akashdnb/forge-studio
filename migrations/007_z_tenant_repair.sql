BEGIN;

-- Repair tenant isolation for databases that already applied the earlier
-- migrations before the tenant bootstrap was introduced.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id text;
CREATE INDEX IF NOT EXISTS projects_tenant_updated_idx ON projects(tenant_id, updated_at DESC);

COMMIT;
