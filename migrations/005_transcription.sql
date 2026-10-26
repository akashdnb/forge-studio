-- Durable transcript versions and immutable provenance for long-form narration transcription.
BEGIN;

ALTER TABLE version_records DROP CONSTRAINT IF EXISTS version_records_kind_check;
ALTER TABLE version_records ADD CONSTRAINT version_records_kind_check CHECK (kind IN ('episode','research','script','scene-plan','scene','asset','narration','render','qa','timeline','caption','transcript','thumbnail'));

CREATE INDEX IF NOT EXISTS artifacts_transcription_input_idx
  ON artifacts(episode_id, kind, version_id);

COMMIT;
