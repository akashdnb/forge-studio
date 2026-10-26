BEGIN;

CREATE TABLE IF NOT EXISTS asset_ingestions (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_checksum char(64) NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('INLINE','ARTIFACT')),
  source_artifact_id text REFERENCES artifacts(id) ON DELETE RESTRICT,
  source_version_id text,
  provenance_fingerprint char(64) NOT NULL,
  status text NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','READY','FAILED','CANCELLED')),
  artifact_id text REFERENCES artifacts(id) ON DELETE RESTRICT,
  version_id text REFERENCES version_records(id) ON DELETE RESTRICT,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, source_checksum, provenance_fingerprint)
);
CREATE INDEX IF NOT EXISTS asset_ingestions_episode_idx ON asset_ingestions(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS asset_ingestions_status_idx ON asset_ingestions(status, updated_at);
CREATE INDEX IF NOT EXISTS asset_ingestions_artifact_idx ON asset_ingestions(artifact_id);

COMMIT;
