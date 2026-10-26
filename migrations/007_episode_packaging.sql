-- Canonical immutable package contract for the publish boundary.
BEGIN;

ALTER TABLE version_records DROP CONSTRAINT IF EXISTS version_records_kind_check;
ALTER TABLE version_records ADD CONSTRAINT version_records_kind_check CHECK (kind IN ('episode','research','script','scene-plan','scene','asset','narration','render','qa','timeline','caption','thumbnail','package'));

ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS package_artifact_id text REFERENCES artifacts(id) ON DELETE RESTRICT;
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS package_version_id text REFERENCES version_records(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS publish_runs_package_idx ON publish_runs(package_artifact_id, package_version_id);

CREATE TABLE IF NOT EXISTS episode_packages (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  final_media_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  final_media_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  metadata_hash char(64) NOT NULL,
  manifest_hash char(64) NOT NULL,
  manifest_size_bytes bigint NOT NULL CHECK (manifest_size_bytes >= 0),
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','RECONCILING','CORRUPT','CANCELLED')),
  manifest jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, manifest_hash)
);
CREATE INDEX IF NOT EXISTS episode_packages_episode_idx ON episode_packages(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS episode_packages_media_idx ON episode_packages(final_media_artifact_id, final_media_version_id);

COMMIT;
