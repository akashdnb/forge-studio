BEGIN;
CREATE TABLE IF NOT EXISTS delivery_packages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL,
  profile_fingerprint TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  source_version_id TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT,
  artifact_version_id TEXT,
  artifact_sha256 TEXT,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'video/mp4',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK(status IN ('BUILDING','READY','FAILED','CORRUPT')),
  error JSONB,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(episode_id, profile_id, profile_fingerprint)
);
CREATE INDEX IF NOT EXISTS delivery_packages_episode_idx ON delivery_packages(episode_id, profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS delivery_packages_artifact_idx ON delivery_packages(artifact_id);
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS delivery_package_id TEXT REFERENCES delivery_packages(id) ON DELETE RESTRICT;
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS delivery_profile_id TEXT;
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS delivery_artifact_id TEXT REFERENCES artifacts(id) ON DELETE RESTRICT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS delivery_package_id TEXT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS delivery_profile_id TEXT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS delivery_artifact_id TEXT;
COMMIT;
