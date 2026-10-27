CREATE TABLE IF NOT EXISTS media_validation_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  project_id TEXT,
  version_id TEXT,
  policy_version INTEGER NOT NULL,
  policy JSONB NOT NULL,
  policy_fingerprint TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CHECK (tenant_id IS NOT NULL OR project_id IS NOT NULL OR version_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_validation_policy_scope_version
  ON media_validation_policies (COALESCE(tenant_id,''), COALESCE(project_id,''), COALESCE(version_id,''), policy_version);
CREATE INDEX IF NOT EXISTS idx_media_validation_policy_resolution
  ON media_validation_policies (tenant_id, project_id, version_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS media_validation_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  episode_id TEXT,
  artifact_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  policy_id TEXT NOT NULL REFERENCES media_validation_policies(id),
  policy_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','PASSED','WARNINGS','FAILED','QUARANTINED','CANCELLED','OVERRIDDEN','STALE')),
  fingerprint TEXT NOT NULL,
  diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash TEXT,
  worker_id TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  override_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_validation_identity
  ON media_validation_records (tenant_id, project_id, artifact_id, version_id, content_hash, policy_fingerprint);
CREATE INDEX IF NOT EXISTS idx_media_validation_artifact_latest
  ON media_validation_records (tenant_id, project_id, artifact_id, version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_validation_work
  ON media_validation_records (status, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS media_validation_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  validation_id TEXT NOT NULL REFERENCES media_validation_records(id),
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_media_validation_overrides_lookup
  ON media_validation_overrides (tenant_id, project_id, artifact_id, version_id, approved_at DESC);

CREATE TABLE IF NOT EXISTS media_quarantine (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  validation_id TEXT NOT NULL REFERENCES media_validation_records(id),
  reason_code TEXT NOT NULL,
  diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
  remediation TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','REMEDIATED','RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_quarantine_open
  ON media_quarantine (tenant_id, project_id, artifact_id, version_id) WHERE status='OPEN';

CREATE OR REPLACE FUNCTION forge_media_validation_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_media_validation_updated_at ON media_validation_records;
CREATE TRIGGER trg_media_validation_updated_at BEFORE UPDATE ON media_validation_records FOR EACH ROW EXECUTE FUNCTION forge_media_validation_updated_at();
