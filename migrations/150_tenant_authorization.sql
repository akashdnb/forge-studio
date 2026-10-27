BEGIN;

CREATE TABLE IF NOT EXISTS auth_tenant_epochs (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auth_tenant_epochs(tenant_id,epoch) SELECT id,1 FROM tenants ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS auth_subjects (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subject_type text NOT NULL CHECK (subject_type IN ('USER','SERVICE')),
  subject_id text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','DELETED')),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,subject_type,subject_id)
);
CREATE INDEX IF NOT EXISTS auth_subjects_status_idx ON auth_subjects(tenant_id,status,subject_type);

CREATE TABLE IF NOT EXISTS authorization_policy_versions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version > 0),
  policy jsonb NOT NULL,
  policy_hash char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,version)
);
CREATE INDEX IF NOT EXISTS authorization_policy_latest_idx ON authorization_policy_versions(tenant_id,version DESC);

CREATE TABLE IF NOT EXISTS auth_role_assignments (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subject_type text NOT NULL CHECK (subject_type IN ('USER','SERVICE')),
  subject_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('VIEWER','EDITOR','OWNER')),
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  resource_type text,
  resource_id text,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  valid_from timestamptz,
  valid_until timestamptz,
  created_by text NOT NULL,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text,
  UNIQUE(id),
  CONSTRAINT auth_role_assignment_subject_fk FOREIGN KEY(tenant_id,subject_type,subject_id) REFERENCES auth_subjects(tenant_id,subject_type,subject_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS auth_role_assignments_lookup_idx ON auth_role_assignments(tenant_id,subject_type,subject_id,status,project_id,resource_type,resource_id);
CREATE INDEX IF NOT EXISTS auth_role_assignments_project_idx ON auth_role_assignments(tenant_id,project_id,status);

CREATE TABLE IF NOT EXISTS auth_assignment_events (
  id bigserial PRIMARY KEY,
  assignment_id text NOT NULL REFERENCES auth_role_assignments(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  event text NOT NULL CHECK (event IN ('ASSIGNED','REVOKED')),
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_assignment_events_scope_idx ON auth_assignment_events(tenant_id,subject_id,created_at DESC);
CREATE OR REPLACE FUNCTION forge_auth_assignment_event_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE at text;
BEGIN SELECT tenant_id INTO at FROM auth_role_assignments WHERE id=NEW.assignment_id; IF at IS NULL OR at<>NEW.tenant_id THEN RAISE EXCEPTION 'authorization assignment event tenant mismatch'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS auth_assignment_event_scope_guard ON auth_assignment_events;
CREATE TRIGGER auth_assignment_event_scope_guard BEFORE INSERT OR UPDATE OF assignment_id,tenant_id ON auth_assignment_events FOR EACH ROW EXECUTE FUNCTION forge_auth_assignment_event_scope_guard();

CREATE TABLE IF NOT EXISTS auth_sessions (
  jti text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subject_type text NOT NULL CHECK (subject_type IN ('USER','SERVICE')),
  subject_id text NOT NULL,
  tenant_epoch bigint NOT NULL,
  subject_epoch bigint NOT NULL,
  policy_version bigint NOT NULL,
  scopes jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CONSTRAINT auth_session_subject_fk FOREIGN KEY(tenant_id,subject_type,subject_id) REFERENCES auth_subjects(tenant_id,subject_type,subject_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS auth_sessions_subject_idx ON auth_sessions(tenant_id,subject_type,subject_id,expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_service_identities (
  service_id text PRIMARY KEY,
  tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  project_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_service_identities_tenant_idx ON auth_service_identities(tenant_id,status);

CREATE OR REPLACE FUNCTION forge_auth_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pt text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT tenant_id INTO pt FROM projects WHERE id=NEW.project_id;
    IF pt IS NULL OR pt <> NEW.tenant_id THEN RAISE EXCEPTION 'authorization tenant/project mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS auth_assignment_scope_guard ON auth_role_assignments;
CREATE TRIGGER auth_assignment_scope_guard BEFORE INSERT OR UPDATE OF tenant_id,project_id ON auth_role_assignments FOR EACH ROW EXECUTE FUNCTION forge_auth_scope_guard();

CREATE OR REPLACE FUNCTION forge_auth_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'authorization evidence is immutable'; END $$;
DROP TRIGGER IF EXISTS auth_policy_immutable_guard ON authorization_policy_versions;
CREATE TRIGGER auth_policy_immutable_guard BEFORE UPDATE OR DELETE ON authorization_policy_versions FOR EACH ROW EXECUTE FUNCTION forge_auth_immutable_guard();
DROP TRIGGER IF EXISTS auth_assignment_event_immutable_guard ON auth_assignment_events;
CREATE TRIGGER auth_assignment_event_immutable_guard BEFORE UPDATE OR DELETE ON auth_assignment_events FOR EACH ROW EXECUTE FUNCTION forge_auth_immutable_guard();

CREATE OR REPLACE FUNCTION forge_auth_seed_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb := '{"version":1,"defaultRole":"VIEWER","operations":{"read":"VIEWER","write":"EDITOR","workflow":"EDITOR","approval":"OWNER","publish":"OWNER","credentials":"OWNER","operator":"OWNER","export":"OWNER","diagnostics":"OWNER","webhook_manage":"OWNER","artifact_delete":"OWNER","recovery":"OWNER","policy_read":"OWNER","policy_write":"OWNER","role_manage":"OWNER","service_manage":"OWNER"},"denyByDefault":true}'::jsonb;
BEGIN
  INSERT INTO authorization_policy_versions(id,tenant_id,version,policy,policy_hash,created_by)
  VALUES(gen_random_uuid()::text,NEW.id,1,p,encode(digest(p::text,'sha256'),'hex'),'system') ON CONFLICT(tenant_id,version) DO NOTHING;
  INSERT INTO auth_tenant_epochs(tenant_id,epoch) VALUES(NEW.id,1) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS auth_tenant_seed ON tenants;
CREATE TRIGGER auth_tenant_seed AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION forge_auth_seed_policy();

INSERT INTO authorization_policy_versions(id,tenant_id,version,policy,policy_hash,created_by)
SELECT gen_random_uuid()::text,t.id,1,
'{"version":1,"defaultRole":"VIEWER","operations":{"read":"VIEWER","write":"EDITOR","workflow":"EDITOR","approval":"OWNER","publish":"OWNER","credentials":"OWNER","operator":"OWNER","export":"OWNER","diagnostics":"OWNER","webhook_manage":"OWNER","artifact_delete":"OWNER","recovery":"OWNER","policy_read":"OWNER","policy_write":"OWNER","role_manage":"OWNER","service_manage":"OWNER"},"denyByDefault":true}'::jsonb,
encode(digest('{"version":1,"defaultRole":"VIEWER","operations":{"read":"VIEWER","write":"EDITOR","workflow":"EDITOR","approval":"OWNER","publish":"OWNER","credentials":"OWNER","operator":"OWNER","export":"OWNER","diagnostics":"OWNER","webhook_manage":"OWNER","artifact_delete":"OWNER","recovery":"OWNER","policy_read":"OWNER","policy_write":"OWNER","role_manage":"OWNER","service_manage":"OWNER"},"denyByDefault":true}'::text,'sha256'),'hex'),'system'
FROM tenants t WHERE NOT EXISTS(SELECT 1 FROM authorization_policy_versions p WHERE p.tenant_id=t.id);

INSERT INTO auth_subjects(tenant_id,subject_type,subject_id,display_name,status,created_by)
SELECT DISTINCT pm.tenant_id,'USER',pm.actor_id,pm.actor_id,'ACTIVE','migration' FROM project_members pm
ON CONFLICT(tenant_id,subject_type,subject_id) DO NOTHING;
INSERT INTO auth_role_assignments(id,tenant_id,subject_type,subject_id,role,project_id,revision,status,created_by,reason)
SELECT 'legacy:'||pm.tenant_id||':'||pm.project_id||':'||pm.actor_id,pm.tenant_id,'USER',pm.actor_id,pm.role,pm.project_id,1,'ACTIVE','migration','legacy project_members compatibility'
FROM project_members pm
WHERE NOT EXISTS(SELECT 1 FROM auth_role_assignments a WHERE a.id='legacy:'||pm.tenant_id||':'||pm.project_id||':'||pm.actor_id);

INSERT INTO auth_subjects(tenant_id,subject_type,subject_id,display_name,status,created_by)
SELECT id,'USER',created_by,created_by,'ACTIVE','migration' FROM tenants
ON CONFLICT(tenant_id,subject_type,subject_id) DO NOTHING;
INSERT INTO auth_role_assignments(id,tenant_id,subject_type,subject_id,role,revision,status,created_by,reason)
SELECT 'legacy-tenant-owner:'||t.id,t.id,'USER',t.created_by,'OWNER',1,'ACTIVE','migration','legacy tenant creator owner compatibility'
FROM tenants t WHERE NOT EXISTS(SELECT 1 FROM auth_role_assignments a WHERE a.id='legacy-tenant-owner:'||t.id);

DROP TRIGGER IF EXISTS security_policy_decisions_immutable_guard ON security_policy_decisions;
CREATE TRIGGER security_policy_decisions_immutable_guard BEFORE UPDATE OR DELETE ON security_policy_decisions FOR EACH ROW EXECUTE FUNCTION forge_auth_immutable_guard();

ALTER TABLE auth_service_identities ALTER COLUMN tenant_id DROP NOT NULL;
INSERT INTO auth_service_identities(service_id,tenant_id,display_name,status,capabilities,created_by)
VALUES('forge-worker-runtime',NULL,'Forge runtime worker','ACTIVE','["job:claim","job:heartbeat","job:complete","artifact:read","artifact:write","provider:execute","runner:execute"]'::jsonb,'system')
ON CONFLICT(service_id) DO NOTHING;

COMMIT;
