BEGIN;
ALTER TABLE version_records DROP CONSTRAINT IF EXISTS version_records_kind_check;
ALTER TABLE version_records ADD CONSTRAINT version_records_kind_check CHECK (kind IN ('episode','script','scene-plan','scene','asset','narration','render','render-manifest','qa','timeline','caption','thumbnail'));
CREATE INDEX IF NOT EXISTS version_records_manifest_idx ON version_records(episode_id, kind, content_hash) WHERE kind='render-manifest';
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_manifest_hash_idx ON artifacts(episode_id, kind, content_hash) WHERE kind='render-manifest';
COMMIT;
