BEGIN;

-- Repair databases whose migration ledger contains 008_tenant_isolation but
-- the schema is missing the column (for example after a partial DB restore).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id text;
CREATE INDEX IF NOT EXISTS projects_tenant_updated_idx ON projects(tenant_id, updated_at DESC);

COMMIT;
