-- Deterministic, immutable captions derived from immutable transcript/timeline inputs.
BEGIN;

ALTER TABLE version_records DROP CONSTRAINT IF EXISTS version_records_kind_check;
ALTER TABLE version_records ADD CONSTRAINT version_records_kind_check CHECK (kind IN ('episode','research','script','scene-plan','scene','asset','narration','transcript','render','qa','timeline','caption','thumbnail'));

CREATE TABLE IF NOT EXISTS caption_runs (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  transcript_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  transcript_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  timeline_artifact_id text REFERENCES artifacts(id) ON DELETE RESTRICT,
  timeline_version_id text REFERENCES version_records(id) ON DELETE RESTRICT,
  caption_version_id text REFERENCES version_records(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  idempotency_key text NOT NULL UNIQUE,
  checksums jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS caption_runs_episode_idx ON caption_runs(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS caption_runs_transcript_idx ON caption_runs(transcript_artifact_id, timeline_artifact_id);

CREATE OR REPLACE FUNCTION forge_reject_caption_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'caption' THEN RAISE EXCEPTION 'Caption artifacts are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS caption_artifact_immutable ON artifacts;
CREATE TRIGGER caption_artifact_immutable BEFORE UPDATE OR DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION forge_reject_caption_mutation();

CREATE OR REPLACE FUNCTION forge_reject_caption_version_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'caption' THEN RAISE EXCEPTION 'Caption versions are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS caption_version_immutable ON version_records;
CREATE TRIGGER caption_version_immutable BEFORE UPDATE OR DELETE ON version_records FOR EACH ROW EXECUTE FUNCTION forge_reject_caption_version_mutation();

COMMIT;
