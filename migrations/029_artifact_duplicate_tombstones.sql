BEGIN;
CREATE TABLE IF NOT EXISTS artifact_duplicate_tombstones (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  storage_object_id text NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
  object_id text NOT NULL REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  old_storage_key text NOT NULL,
  canonical_storage_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','DELETED','RETRY','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  last_error jsonb
);
CREATE INDEX IF NOT EXISTS artifact_duplicate_tombstones_pending_idx ON artifact_duplicate_tombstones(tenant_id,state,created_at);
COMMIT;
