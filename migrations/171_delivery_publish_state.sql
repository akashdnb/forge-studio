BEGIN;
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS delivery_state TEXT NOT NULL DEFAULT 'READY_TO_PUBLISH';
ALTER TABLE publish_runs DROP CONSTRAINT IF EXISTS publish_runs_delivery_state_check;
ALTER TABLE publish_runs ADD CONSTRAINT publish_runs_delivery_state_check CHECK(delivery_state IN ('READY_TO_PUBLISH','PUBLISHING','PUBLISHED','RECONCILIATION_REQUIRED','FAILED'));
CREATE INDEX IF NOT EXISTS publish_runs_delivery_state_idx ON publish_runs(delivery_state,updated_at DESC);
COMMIT;
