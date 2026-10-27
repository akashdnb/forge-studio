BEGIN;

ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS runtime_snapshot jsonb;
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS runtime_snapshot_hash char(64);
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS runtime_policy_versions jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS runtime_policy_versions (
  scope_type text NOT NULL CHECK (scope_type IN ('SYSTEM','TENANT','PROJECT','PROVIDER')),
  scope_id text NOT NULL,
  namespace text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('DRAFT','ACTIVE','RETIRED')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (scope_type, scope_id, namespace, version)
);
CREATE INDEX IF NOT EXISTS runtime_policy_active_idx ON runtime_policy_versions(scope_type, scope_id, namespace, state, version DESC);

CREATE TABLE IF NOT EXISTS runtime_policy_heads (
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  namespace text NOT NULL,
  current_version bigint NOT NULL CHECK (current_version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_id, namespace)
);

CREATE TABLE IF NOT EXISTS runtime_feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  rollout_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  targets jsonb NOT NULL DEFAULT '{}'::jsonb,
  kill_switch boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_secrets (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  provider text,
  name text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','RETIRED','REVOKED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_secrets_scope_unique_idx ON runtime_secrets(tenant_id, project_id, provider, name);
CREATE INDEX IF NOT EXISTS runtime_secrets_scope_idx ON runtime_secrets(tenant_id, project_id, provider, name, status);

CREATE TABLE IF NOT EXISTS runtime_config_audit (
  id bigserial PRIMARY KEY,
  tenant_id text,
  project_id text,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runtime_config_audit_scope_idx ON runtime_config_audit(tenant_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runtime_boot_snapshots (
  id bigserial PRIMARY KEY,
  boot_id text NOT NULL,
  service text NOT NULL,
  environment text NOT NULL,
  config_fingerprint char(64) NOT NULL,
  env_fingerprint char(64) NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runtime_boot_snapshots_service_idx ON runtime_boot_snapshots(service, observed_at DESC);

CREATE TABLE IF NOT EXISTS runtime_worker_snapshots (
  id bigserial PRIMARY KEY,
  worker_id text NOT NULL,
  tenant_id text,
  runtime_fingerprint char(64) NOT NULL,
  policy_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runtime_worker_snapshots_worker_idx ON runtime_worker_snapshots(worker_id, observed_at DESC);

COMMIT;
