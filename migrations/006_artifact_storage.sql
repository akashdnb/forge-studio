-- Durable artifact storage metadata. Object keys are server-derived from content hashes;
-- caller-supplied storageUri values are never used for object resolution.
BEGIN;
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS checksum_verified boolean NOT NULL DEFAULT false;
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','CORRUPT','MISSING'));
UPDATE storage_objects SET storage_key = regexp_replace(uri, '^s3://[^/]+/', '') WHERE storage_key IS NULL AND uri LIKE 's3://%';
-- Never promote an old file:// URI into a trusted key: its absolute path may escape the configured backend root.
UPDATE storage_objects SET status = 'MISSING' WHERE storage_key IS NULL AND uri LIKE 'file://%';
DROP INDEX IF EXISTS storage_objects_uri_idx;
CREATE INDEX IF NOT EXISTS storage_objects_artifact_idx ON storage_objects(artifact_id);
CREATE UNIQUE INDEX IF NOT EXISTS storage_objects_artifact_unique_idx ON storage_objects(artifact_id) WHERE artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS storage_objects_project_key_idx ON storage_objects(project_id, storage_key) WHERE storage_key IS NOT NULL;
COMMIT;
