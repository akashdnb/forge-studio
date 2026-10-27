BEGIN;

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_lifecycle_state_check;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_lifecycle_state_check CHECK (lifecycle_state IN ('ACTIVE','QUARANTINED','DELETED','SUPERSEDED'));

ALTER TABLE storage_objects
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE storage_objects
  DROP CONSTRAINT IF EXISTS storage_objects_lifecycle_state_check;
ALTER TABLE storage_objects
  ADD CONSTRAINT storage_objects_lifecycle_state_check CHECK (lifecycle_state IN ('ACTIVE','QUARANTINED','DELETED','SUPERSEDED'));

CREATE INDEX IF NOT EXISTS artifacts_episode_lifecycle_idx ON artifacts(episode_id, lifecycle_state, created_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_version_lifecycle_idx ON artifacts(version_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS storage_objects_lifecycle_idx ON storage_objects(lifecycle_state, status);
CREATE INDEX IF NOT EXISTS audit_events_artifact_access_idx ON audit_events(target_type, target_id, action, created_at DESC) WHERE target_type = 'artifact';

COMMIT;
