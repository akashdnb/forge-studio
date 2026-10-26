BEGIN;

ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS upload_session_uri text;
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS render_content_hash char(64);
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS request_fingerprint char(64);
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE INDEX IF NOT EXISTS publish_runs_active_lease_idx ON publish_runs(status, lease_until) WHERE status IN ('QUEUED','UPLOADING');

COMMIT;
