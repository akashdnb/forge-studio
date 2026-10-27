BEGIN;

CREATE TABLE IF NOT EXISTS forge_credential_access_leases (
  id text PRIMARY KEY,
  credential_id text NOT NULL REFERENCES forge_provider_credentials(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL DEFAULT '',
  workflow_id text,
  job_id text,
  attempt_id text,
  region text NOT NULL,
  execution_epoch text NOT NULL,
  scope jsonb NOT NULL,
  fencing_token bigint NOT NULL DEFAULT 1,
  state text NOT NULL CHECK (state IN ('HELD','RELEASED','EXPIRED','REVOKED')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  renewed_at timestamptz,
  released_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, project_id, purpose, provider, workflow_id, job_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS forge_credential_access_leases_active_idx ON forge_credential_access_leases(tenant_id, project_id, state, expires_at);
CREATE INDEX IF NOT EXISTS forge_credential_access_leases_expiry_idx ON forge_credential_access_leases(state, expires_at);
CREATE INDEX IF NOT EXISTS forge_credential_access_leases_credential_idx ON forge_credential_access_leases(credential_id, state, expires_at);

CREATE TABLE IF NOT EXISTS forge_credential_access_grants (
  grant_id text PRIMARY KEY,
  lease_id text NOT NULL REFERENCES forge_credential_access_leases(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  model text NOT NULL DEFAULT '',
  purpose text NOT NULL,
  region text NOT NULL,
  execution_epoch text NOT NULL,
  fencing_token bigint NOT NULL,
  credential_id text NOT NULL REFERENCES forge_provider_credentials(id) ON DELETE RESTRICT,
  credential_version bigint NOT NULL,
  scope jsonb NOT NULL,
  token_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE(token_hash)
);
CREATE INDEX IF NOT EXISTS forge_credential_access_grants_active_idx ON forge_credential_access_grants(tenant_id, project_id, provider, expires_at);

CREATE TABLE IF NOT EXISTS forge_credential_usage_attestations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  lease_id text REFERENCES forge_credential_access_leases(id) ON DELETE RESTRICT,
  grant_id text REFERENCES forge_credential_access_grants(grant_id) ON DELETE RESTRICT,
  credential_id text REFERENCES forge_provider_credentials(id) ON DELETE RESTRICT,
  credential_version bigint,
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL DEFAULT '',
  workflow_id text,
  job_id text,
  attempt_id text,
  region text NOT NULL,
  execution_epoch text NOT NULL,
  fencing_token bigint NOT NULL,
  operation text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('STARTED','SUCCEEDED','FAILED','DENIED','REVOKED','EXPIRED')),
  request_id text,
  provider_request_hash text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  attestation_hash text NOT NULL,
  attestation_signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_credential_attestations_attempt_op_uq ON forge_credential_usage_attestations(tenant_id, job_id, attempt_id, operation, outcome) WHERE job_id IS NOT NULL AND attempt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_credential_attestations_scope_idx ON forge_credential_usage_attestations(tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_credential_attestations_lease_idx ON forge_credential_usage_attestations(lease_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_credential_access_events (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  lease_id text,
  grant_id text,
  event_type text NOT NULL,
  reason text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_credential_access_events_scope_idx ON forge_credential_access_events(tenant_id, project_id, created_at DESC);

COMMIT;
