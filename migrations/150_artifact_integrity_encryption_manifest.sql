BEGIN;

ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS encryption_mode text NOT NULL DEFAULT 'NONE';
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS encryption_key_id text;
ALTER TABLE storage_objects ADD COLUMN IF NOT EXISTS integrity_manifest_id text;

CREATE TABLE IF NOT EXISTS artifact_integrity_manifests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  content_identity text NOT NULL,
  sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 3 AND 128),
  kind text NOT NULL,
  storage_key text NOT NULL,
  encryption_mode text NOT NULL CHECK (encryption_mode IN ('NONE','AES256','AWS_KMS')),
  encryption_key_id text,
  manifest_digest char(64) NOT NULL,
  manifest_mac char(64) NOT NULL,
  mac_algorithm text NOT NULL DEFAULT 'HMAC-SHA256' CHECK (mac_algorithm = 'HMAC-SHA256'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id),
  UNIQUE (tenant_id, content_identity, artifact_id)
);
CREATE INDEX IF NOT EXISTS artifact_integrity_manifests_scope_idx ON artifact_integrity_manifests(tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS artifact_integrity_manifests_content_idx ON artifact_integrity_manifests(tenant_id, content_identity);

CREATE OR REPLACE FUNCTION forge_artifact_integrity_manifest_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'artifact integrity manifests are append-only'; END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.artifact_id IS DISTINCT FROM NEW.artifact_id OR OLD.version_id IS DISTINCT FROM NEW.version_id
     OR OLD.content_identity IS DISTINCT FROM NEW.content_identity OR OLD.sha256 IS DISTINCT FROM NEW.sha256
     OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes OR OLD.media_type IS DISTINCT FROM NEW.media_type
     OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
     OR OLD.encryption_mode IS DISTINCT FROM NEW.encryption_mode OR OLD.encryption_key_id IS DISTINCT FROM NEW.encryption_key_id
     OR OLD.manifest_digest IS DISTINCT FROM NEW.manifest_digest OR OLD.manifest_mac IS DISTINCT FROM NEW.manifest_mac
     OR OLD.mac_algorithm IS DISTINCT FROM NEW.mac_algorithm THEN
    RAISE EXCEPTION 'artifact integrity manifest identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS artifact_integrity_manifest_immutable ON artifact_integrity_manifests;
CREATE TRIGGER artifact_integrity_manifest_immutable BEFORE UPDATE OR DELETE ON artifact_integrity_manifests
FOR EACH ROW EXECUTE FUNCTION forge_artifact_integrity_manifest_immutable();

CREATE INDEX IF NOT EXISTS artifact_content_refs_object_active_idx
  ON artifact_content_refs(tenant_id, object_id, active);

COMMIT;
