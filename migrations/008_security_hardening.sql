BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS tenant_id text;
INSERT INTO tenants(id,name,created_by)
SELECT DISTINCT 'tenant:' || created_by, 'Legacy tenant ' || created_by, created_by
FROM projects WHERE created_by IS NOT NULL
ON CONFLICT (id) DO NOTHING;
UPDATE projects SET tenant_id = COALESCE(tenant_id, 'tenant:' || created_by);
ALTER TABLE projects ALTER COLUMN tenant_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS projects_tenant_idx ON projects(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS security_token_revocations (
  jti text PRIMARY KEY,
  tenant_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_token_revocations_expiry_idx ON security_token_revocations(expires_at);

CREATE TABLE IF NOT EXISTS webhook_replay_keys (
  scope text NOT NULL,
  replay_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope, replay_key)
);
CREATE INDEX IF NOT EXISTS webhook_replay_keys_expiry_idx ON webhook_replay_keys(expires_at);

CREATE TABLE IF NOT EXISTS security_audit_events (
  id bigserial PRIMARY KEY,
  tenant_id text,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  request_id text,
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED','DENIED','FAILED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_audit_tenant_created_idx ON security_audit_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_project_created_idx ON security_audit_events(project_id, created_at DESC);

ALTER TABLE project_members ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE project_members pm SET tenant_id = p.tenant_id FROM projects p WHERE p.id = pm.project_id AND pm.tenant_id IS NULL;
ALTER TABLE project_members ALTER COLUMN tenant_id SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE project_members ADD CONSTRAINT project_members_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS project_members_actor_tenant_idx ON project_members(actor_id, tenant_id, project_id);

CREATE OR REPLACE FUNCTION forge_project_tenant_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.tenant_id = '' THEN NEW.tenant_id := 'tenant:' || NEW.created_by; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS project_tenant_guard ON projects;
CREATE TRIGGER project_tenant_guard BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION forge_project_tenant_guard();

CREATE OR REPLACE FUNCTION forge_project_member_tenant_guard() RETURNS trigger AS $$
DECLARE project_tenant text;
BEGIN
  SELECT tenant_id INTO project_tenant FROM projects WHERE id = NEW.project_id;
  IF project_tenant IS NULL OR NEW.tenant_id <> project_tenant THEN RAISE EXCEPTION 'project member tenant mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS project_member_tenant_guard ON project_members;
CREATE TRIGGER project_member_tenant_guard BEFORE INSERT OR UPDATE OF project_id,tenant_id ON project_members FOR EACH ROW EXECUTE FUNCTION forge_project_member_tenant_guard();

COMMIT;
