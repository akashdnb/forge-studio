-- YouTube publication durability: provider response metadata and resumable session state.
BEGIN;

ALTER TABLE publish_runs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS provider_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS upload_session_uri text,
  ADD COLUMN IF NOT EXISTS last_provider_status integer,
  ADD COLUMN IF NOT EXISTS last_provider_reason text;

ALTER TABLE publish_runs DROP CONSTRAINT IF EXISTS publish_runs_status_check;
ALTER TABLE publish_runs ADD CONSTRAINT publish_runs_status_check CHECK (
  status IN ('QUEUED','UPLOADING','PUBLISHED','FAILED','CANCELLED','RECONCILIATION_REQUIRED')
);

CREATE INDEX IF NOT EXISTS publish_runs_reconciliation_idx
  ON publish_runs(status, updated_at);

COMMIT;
