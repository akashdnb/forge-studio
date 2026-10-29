BEGIN;

-- Add the tenant boundary immediately after the initial schema migration.
-- The distinct migration name guarantees this repair is applied even when
-- older migration ledgers already contain the previous tenant bootstrap name.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id text;
CREATE INDEX IF NOT EXISTS projects_tenant_updated_idx ON projects(tenant_id, updated_at DESC);

COMMIT;
