BEGIN;

-- The lifecycle ledger in 009_artifact_lifecycle.sql is the canonical lifecycle source.
-- This migration adds only access-oriented indexes; it does not duplicate lifecycle state.
CREATE INDEX IF NOT EXISTS artifact_access_lifecycle_lookup_idx ON artifact_lifecycle_records(artifact_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_artifact_access_idx ON audit_events(target_type, target_id, action, created_at DESC) WHERE target_type = 'artifact';
CREATE INDEX IF NOT EXISTS storage_objects_access_status_idx ON storage_objects(artifact_id, status);

COMMIT;
