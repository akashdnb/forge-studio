BEGIN;

-- Bridge every existing/new storage_objects write into the content-addressed ledger.
-- This keeps the production artifact gateway on one canonical path without requiring
-- callers to know about the optimization tables.
CREATE OR REPLACE FUNCTION forge_sync_artifact_content_object() RETURNS trigger AS $$
DECLARE tenant text; version_id text; object_id text; ref_kind text;
BEGIN
  IF NEW.content_hash IS NULL OR NEW.storage_key IS NULL OR NEW.artifact_id IS NULL THEN RETURN NEW; END IF;
  SELECT p.tenant_id INTO tenant FROM projects p WHERE p.id=NEW.project_id;
  SELECT a.version_id INTO version_id FROM artifacts a WHERE a.id=NEW.artifact_id;
  IF tenant IS NULL OR version_id IS NULL THEN RETURN NEW; END IF;

  SELECT id INTO object_id FROM artifact_content_objects WHERE tenant_id=tenant AND sha256=NEW.content_hash FOR UPDATE;
  IF object_id IS NULL THEN
    object_id := 'storage-object:'||NEW.id;
    INSERT INTO artifact_content_objects(id,tenant_id,sha256,size_bytes,media_type,kind,storage_key,checksum_verified,status,immutable_evidence,recovery_required,metadata)
    VALUES(object_id,tenant,NEW.content_hash,COALESCE(NEW.size_bytes,0),COALESCE(NEW.media_type,'application/octet-stream'),COALESCE(NEW.kind,'unknown'),NEW.storage_key,COALESCE(NEW.checksum_verified,false),CASE WHEN NEW.status='READY' THEN 'READY' ELSE 'QUARANTINED' END,
      CASE WHEN COALESCE(NEW.kind,'') IN ('package','render','render-manifest') THEN true ELSE false END,
      CASE WHEN COALESCE(NEW.metadata,'{}'::jsonb)->>'recoveryRequired'='true' THEN true ELSE false END,
      jsonb_build_object('storageObjectId',NEW.id))
    ON CONFLICT (tenant_id,sha256) DO NOTHING;
    SELECT id INTO object_id FROM artifact_content_objects WHERE tenant_id=tenant AND sha256=NEW.content_hash;
  END IF;

  ref_kind := CASE WHEN COALESCE(NEW.kind,'') LIKE 'derivative:%' THEN 'DERIVED' ELSE 'IMMUTABLE' END;
  INSERT INTO artifact_content_refs(id,tenant_id,project_id,artifact_id,object_id,ref_kind,source_version_id,active)
  VALUES('storage-ref:'||NEW.id,tenant,NEW.project_id,NEW.artifact_id,object_id,ref_kind,version_id,true)
  ON CONFLICT (artifact_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS forge_sync_artifact_content_object_trigger ON storage_objects;
CREATE TRIGGER forge_sync_artifact_content_object_trigger
AFTER INSERT OR UPDATE OF content_hash,storage_key,size_bytes,status ON storage_objects
FOR EACH ROW EXECUTE FUNCTION forge_sync_artifact_content_object();

COMMIT;
