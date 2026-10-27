BEGIN;

CREATE TABLE IF NOT EXISTS forge_crypto_key_epochs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id text,
  purpose text NOT NULL CHECK (purpose IN ('provider-credential','runtime-secret','webhook-secret','capability-token','export-secret','audit-sensitive','artifact-content','runner-secret')),
  epoch bigint NOT NULL CHECK (epoch > 0),
  status text NOT NULL CHECK (status IN ('ACTIVE','RETIRING','RETIRED','REVOKED')),
  wrapped_key bytea NOT NULL,
  wrap_nonce bytea NOT NULL,
  wrap_auth_tag bytea NOT NULL,
  key_fingerprint text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retiring_at timestamptz,
  retirement_requested_at timestamptz,
  retired_at timestamptz,
  revoked_at timestamptz,
  rotation_reason text,
  revocation_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, purpose, epoch),
  CHECK (length(wrapped_key) = 32),
  CHECK (length(wrap_nonce) = 12),
  CHECK (length(wrap_auth_tag) = 16)
);
DROP INDEX IF EXISTS forge_crypto_active_epoch_uq;
CREATE UNIQUE INDEX forge_crypto_active_epoch_uq ON forge_crypto_key_epochs(tenant_id, COALESCE(project_id, ''), purpose) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS forge_crypto_epoch_lookup_idx ON forge_crypto_key_epochs(tenant_id, project_id, purpose, epoch DESC);
CREATE INDEX IF NOT EXISTS forge_crypto_status_idx ON forge_crypto_key_epochs(status, updated_at);

CREATE TABLE IF NOT EXISTS forge_crypto_key_audit (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  purpose text NOT NULL,
  epoch bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('CREATE','ROTATE','REVOKE','RETIRE','REENCRYPT','RESTORE_VALIDATE')),
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_crypto_key_audit_scope_idx ON forge_crypto_key_audit(tenant_id, project_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_crypto_reencryption_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id text,
  purpose text NOT NULL,
  source_epoch bigint NOT NULL,
  target_epoch bigint NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('provider_credentials','runtime_secrets','artifact_content','audit_records','custom')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','RETRY','FAILED','CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  cursor_id text,
  locked_by text,
  locked_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  last_error_message text,
  processed_count bigint NOT NULL DEFAULT 0,
  failed_count bigint NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, purpose, source_epoch, target_epoch, target_type, status)
);
CREATE INDEX IF NOT EXISTS forge_crypto_reencrypt_claim_idx ON forge_crypto_reencryption_jobs(status, next_attempt_at, locked_until);
CREATE INDEX IF NOT EXISTS forge_crypto_reencrypt_scope_idx ON forge_crypto_reencryption_jobs(tenant_id, project_id, purpose, created_at DESC);

ALTER TABLE forge_provider_credentials ADD COLUMN IF NOT EXISTS key_epoch bigint;
ALTER TABLE runtime_secrets ADD COLUMN IF NOT EXISTS key_epoch bigint;
CREATE INDEX IF NOT EXISTS forge_provider_credentials_key_epoch_idx ON forge_provider_credentials(tenant_id, project_id, key_id, key_epoch);
CREATE INDEX IF NOT EXISTS runtime_secrets_key_epoch_idx ON runtime_secrets(tenant_id, project_id, provider, key_id, key_epoch);

CREATE OR REPLACE FUNCTION forge_crypto_epoch_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.purpose IS DISTINCT FROM NEW.purpose OR OLD.epoch IS DISTINCT FROM NEW.epoch
     OR OLD.wrapped_key IS DISTINCT FROM NEW.wrapped_key OR OLD.wrap_nonce IS DISTINCT FROM NEW.wrap_nonce
     OR OLD.wrap_auth_tag IS DISTINCT FROM NEW.wrap_auth_tag OR OLD.key_fingerprint IS DISTINCT FROM NEW.key_fingerprint THEN
    RAISE EXCEPTION 'cryptographic key epoch identity/material is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_crypto_epoch_immutable ON forge_crypto_key_epochs;
CREATE TRIGGER forge_crypto_epoch_immutable BEFORE UPDATE ON forge_crypto_key_epochs FOR EACH ROW EXECUTE FUNCTION forge_crypto_epoch_immutable_guard();

COMMIT;
