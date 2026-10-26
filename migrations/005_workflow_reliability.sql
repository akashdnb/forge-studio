-- Workflow reliability fixes: preserve established kind constraints and make
-- durable outbox claims visible after a transaction commits.
BEGIN;

ALTER TABLE version_records DROP CONSTRAINT IF EXISTS version_records_kind_check;
ALTER TABLE version_records ADD CONSTRAINT version_records_kind_check
  CHECK (kind IN ('episode','research','script','scene-plan','scene','asset','narration','render','qa','timeline','caption','thumbnail','publish-record'));

ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS claimed_by text;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
CREATE INDEX IF NOT EXISTS forge_outbox_claim_idx
  ON forge_outbox(available_at, claimed_until, id)
  WHERE published_at IS NULL;

-- Composite keys make cross-episode dependency/artifact references impossible,
-- even for direct SQL writers.
ALTER TABLE version_records DROP CONSTRAINT IF EXISTS version_records_episode_id_id_key;
ALTER TABLE version_records ADD CONSTRAINT version_records_episode_id_id_key UNIQUE (episode_id, id);

ALTER TABLE version_dependencies DROP CONSTRAINT IF EXISTS version_dependencies_version_same_episode_fk;
ALTER TABLE version_dependencies ADD CONSTRAINT version_dependencies_version_same_episode_fk
  FOREIGN KEY (episode_id, version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;
ALTER TABLE version_dependencies DROP CONSTRAINT IF EXISTS version_dependencies_dependency_same_episode_fk;
ALTER TABLE version_dependencies ADD CONSTRAINT version_dependencies_dependency_same_episode_fk
  FOREIGN KEY (episode_id, depends_on_version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_version_same_episode_fk;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_version_same_episode_fk
  FOREIGN KEY (episode_id, version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;

COMMIT;
