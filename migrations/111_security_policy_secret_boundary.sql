BEGIN;

CREATE TABLE IF NOT EXISTS security_policy_versions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  version bigint NOT NULL,
  policy jsonb NOT NULL,
  policy_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);
CREATE INDEX IF NOT EXISTS security_policy_versions_latest_idx ON security_policy_versions(tenant_id, version DESC);

INSERT INTO security_policy_versions(tenant_id, version, policy, policy_hash, created_by)
SELECT t.id, 1,
  '{"version":1,"defaultRole":"VIEWER","operations":{"read":"VIEWER","write":"EDITOR","workflow":"EDITOR","approval":"OWNER","publish":"OWNER","credentials":"OWNER","operator":"OWNER","export":"OWNER","diagnostics":"OWNER","webhook_manage":"OWNER","artifact_delete":"OWNER","recovery":"OWNER"},"capabilityAudiences":["provider-adapter","internal-runner"]}'::jsonb,
  encode(digest('{"version":1,"defaultRole":"VIEWER","operations":{"read":"VIEWER","write":"EDITOR","workflow":"EDITOR","approval":"OWNER","publish":"OWNER","credentials":"OWNER","operator":"OWNER","export":"OWNER","diagnostics":"OWNER","webhook_manage":"OWNER","artifact_delete":"OWNER","recovery":"OWNER"},"capabilityAudiences":["provider-adapter","internal-runner"]}', 'sha256'),'hex'),
  'system'
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM security_policy_versions p WHERE p.tenant_id=t.id);

CREATE OR REPLACE FUNCTION forge_seed_security_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO security_policy_versions(tenant_id,version,policy,policy_hash,created_by)
  VALUES(NEW.id,1,'{"version":1,"defaultRole":"VIEWER","operations":{"read":"VIEWER","write":"EDITOR","workflow":"EDITOR","approval":"OWNER","publish":"OWNER","credentials":"OWNER","operator":"OWNER","export":"OWNER","diagnostics":"OWNER","webhook_manage":"OWNER","artifact_delete":"OWNER","recovery":"OWNER"},"capabilityAudiences":["provider-adapter","internal-runner"]}'::jsonb,encode(digest(NEW.id || ':security-policy:v1','sha256'),'hex'),'system')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_security_policy_seed ON tenants;
CREATE TRIGGER tenant_security_policy_seed AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION forge_seed_security_policy();

CREATE TABLE IF NOT EXISTS security_policy_decisions (
  id bigserial PRIMARY KEY,
  tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED','DENIED','FAILED')),
  reason text NOT NULL,
  policy_version bigint,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_policy_decisions_scope_idx ON security_policy_decisions(tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_policy_decisions_target_idx ON security_policy_decisions(target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security_capability_tokens (
  token_digest text PRIMARY KEY,
  jti text NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  subject text NOT NULL,
  audience text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  action text NOT NULL,
  policy_version bigint,
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 32),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  issued_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS security_capability_expiry_idx ON security_capability_tokens(expires_at);
CREATE INDEX IF NOT EXISTS security_capability_resource_idx ON security_capability_tokens(tenant_id, project_id, resource_type, resource_id, action);

CREATE TABLE IF NOT EXISTS security_secret_scan_events (
  id bigserial PRIMARY KEY,
  tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  boundary text NOT NULL,
  operation text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('BLOCKED','REDACTED')),
  finding_count integer NOT NULL,
  finding_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_secret_scan_scope_idx ON security_secret_scan_events(tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION forge_security_capability_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_tenant text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id;
    IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN RAISE EXCEPTION 'security capability tenant/project mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS security_capability_scope_guard ON security_capability_tokens;
CREATE TRIGGER security_capability_scope_guard BEFORE INSERT OR UPDATE OF tenant_id,project_id ON security_capability_tokens FOR EACH ROW EXECUTE FUNCTION forge_security_capability_scope_guard();

CREATE OR REPLACE FUNCTION forge_security_decision_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_tenant text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id;
    IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN RAISE EXCEPTION 'security decision tenant/project mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS security_policy_decision_scope_guard ON security_policy_decisions;
CREATE TRIGGER security_policy_decision_scope_guard BEFORE INSERT OR UPDATE OF tenant_id,project_id ON security_policy_decisions FOR EACH ROW EXECUTE FUNCTION forge_security_decision_scope_guard();

CREATE OR REPLACE FUNCTION forge_security_secret_scan_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_tenant text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id;
    IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN RAISE EXCEPTION 'security scan tenant/project mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS security_secret_scan_scope_guard ON security_secret_scan_events;
CREATE TRIGGER security_secret_scan_scope_guard BEFORE INSERT OR UPDATE OF tenant_id,project_id ON security_secret_scan_events FOR EACH ROW EXECUTE FUNCTION forge_security_secret_scan_scope_guard();

CREATE INDEX IF NOT EXISTS security_audit_request_idx ON security_audit_events(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_action_idx ON security_audit_events(tenant_id, action, created_at DESC);

COMMIT;
