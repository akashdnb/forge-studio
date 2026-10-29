CREATE TABLE IF NOT EXISTS artifact_integrity_manifests (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  artifact_id text NOT NULL UNIQUE,
  version_id text,
  kind text NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  media_type text NOT NULL,
  encryption_mode text NOT NULL DEFAULT 'NONE',
  encryption_key_id text,
  mac text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artifact_content_refs_object_active_idx
  ON artifact_integrity_manifests(tenant_id, project_id, artifact_id);

CREATE OR REPLACE FUNCTION forge_artifact_integrity_manifest_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id <> OLD.tenant_id
      OR NEW.project_id <> OLD.project_id
      OR NEW.artifact_id <> OLD.artifact_id
      OR NEW.sha256 <> OLD.sha256
      OR NEW.size_bytes <> OLD.size_bytes
      OR NEW.storage_key <> OLD.storage_key
      OR NEW.encryption_mode <> OLD.encryption_mode
      OR COALESCE(NEW.encryption_key_id, '') <> COALESCE(OLD.encryption_key_id, '') THEN
      RAISE EXCEPTION 'artifact integrity manifests are immutable';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'artifact integrity manifests cannot be deleted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS forge_artifact_integrity_manifest_immutable ON artifact_integrity_manifests;
CREATE TRIGGER forge_artifact_integrity_manifest_immutable
BEFORE UPDATE OR DELETE ON artifact_integrity_manifests
FOR EACH ROW EXECUTE FUNCTION forge_artifact_integrity_manifest_immutable();

ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS encryption_mode text NOT NULL DEFAULT 'NONE';
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS encryption_key_id text;
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS integrity_manifest_id bigint REFERENCES artifact_integrity_manifests(id);
