BEGIN;

CREATE TABLE IF NOT EXISTS forge_provider_capabilities (
  provider text NOT NULL,
  capability text NOT NULL,
  model text NOT NULL DEFAULT '',
  media_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, capability, model)
);

CREATE TABLE IF NOT EXISTS forge_provider_credentials (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  credential_name text NOT NULL,
  version bigint NOT NULL CHECK(version > 0),
  status text NOT NULL CHECK(status IN ('ACTIVE','OVERLAP','RETIRED','REVOKED','EXPIRED')),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  overlap_until timestamptz,
  expires_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, project_id, provider, credential_name, version)
);
CREATE INDEX IF NOT EXISTS forge_provider_credentials_select_idx ON forge_provider_credentials(tenant_id, project_id, provider, credential_name, status, version DESC);
DROP INDEX IF EXISTS forge_provider_credentials_active_uq;
CREATE UNIQUE INDEX IF NOT EXISTS forge_provider_credentials_active_uq ON forge_provider_credentials(tenant_id, project_id, provider, credential_name) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS forge_provider_credential_leases (
  id text PRIMARY KEY,
  credential_id text NOT NULL REFERENCES forge_provider_credentials(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  version bigint NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  release_epoch text,
  state text NOT NULL CHECK(state IN ('HELD','RELEASED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(credential_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS forge_provider_credential_leases_expiry_idx ON forge_provider_credential_leases(state, expires_at);

CREATE TABLE IF NOT EXISTS forge_provider_credential_audit (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  action text NOT NULL,
  credential_id text,
  provider text,
  version bigint,
  request_id text,
  idempotency_key text,
  outcome text NOT NULL CHECK(outcome IN ('SUCCEEDED','REJECTED','FAILED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_provider_credential_audit_idempotency_uq ON forge_provider_credential_audit(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_provider_credential_audit_scope_idx ON forge_provider_credential_audit(tenant_id, project_id, created_at DESC);

COMMIT;
