-- Workflow reliability fixes: preserve the established publish-record version kind,
-- and make outbox claims visible after a claim transaction commits.
BEGIN;

ALTER TABLE version_records DROP CONSTRAINT IF EXISTS version_records_kind_check;
ALTER TABLE version_records ADD CONSTRAINT version_records_kind_check
  CHECK (kind IN ('episode','research','script','scene-plan','scene','asset','narration','render','qa','timeline','caption','thumbnail','publish-record'));

ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS claimed_by text;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
CREATE INDEX IF NOT EXISTS forge_outbox_claim_idx
  ON forge_outbox(available_at, claimed_until, id)
  WHERE published_at IS NULL;

COMMIT;
