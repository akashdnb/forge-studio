BEGIN;

CREATE TABLE IF NOT EXISTS artifact_content_objects (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  media_type text NOT NULL DEFAULT 'application/octet-stream',
  kind text NOT NULL DEFAULT 'unknown',
  storage_key text NOT NULL,
  checksum_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','QUARANTINED','TOMBSTONED','DELETED')),
  ref_count bigint NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  reservation_count bigint NOT NULL DEFAULT 0 CHECK (reservation_count >= 0),
  immutable_evidence boolean NOT NULL DEFAULT false,
  recovery_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_referenced_at timestamptz,
  tombstoned_at timestamptz,
  deleted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, sha256), UNIQUE (tenant_id, storage_key)
);
CREATE INDEX IF NOT EXISTS artifact_content_objects_gc_idx ON artifact_content_objects(tenant_id,status,ref_count,reservation_count,last_referenced_at);
CREATE TABLE IF NOT EXISTS artifact_content_refs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  object_id text NOT NULL REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  ref_kind text NOT NULL CHECK (ref_kind IN ('IMMUTABLE','DERIVED','CACHE','PACKAGE','EXPORT','RECOVERY','RUNNER_HANDOFF')),
  source_version_id text REFERENCES version_records(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
  UNIQUE (artifact_id), UNIQUE (object_id,artifact_id)
);
CREATE INDEX IF NOT EXISTS artifact_content_refs_object_idx ON artifact_content_refs(object_id,active);
CREATE TABLE IF NOT EXISTS artifact_storage_reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  object_id text NOT NULL REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  bytes_reserved bigint NOT NULL CHECK (bytes_reserved >= 0),
  state text NOT NULL CHECK (state IN ('HELD','COMMITTED','RELEASED','EXPIRED')),
  purpose text NOT NULL, idempotency_key text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz, released_at timestamptz,
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS artifact_storage_reservations_expiry_idx ON artifact_storage_reservations(state,expires_at);
CREATE TABLE IF NOT EXISTS artifact_storage_tombstones (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  object_id text NOT NULL REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  sha256 char(64) NOT NULL, storage_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','DELETED','CANCELLED')),
  plan_id text, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
  UNIQUE (object_id,state) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS artifact_storage_tombstones_pending_idx ON artifact_storage_tombstones(tenant_id,state,created_at);
CREATE TABLE IF NOT EXISTS artifact_gc_plans (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('DRY_RUN','ENFORCE')),
  status text NOT NULL CHECK (status IN ('PLANNED','WAITING_APPROVAL','RUNNING','COMPLETED','CANCELLED','FAILED')),
  policy_snapshot jsonb NOT NULL, checkpoint_storage_key text, checkpoint_object_id text,
  scan_limit integer NOT NULL CHECK (scan_limit > 0), max_delete_bytes bigint NOT NULL CHECK (max_delete_bytes >= 0),
  scanned_count bigint NOT NULL DEFAULT 0, protected_count bigint NOT NULL DEFAULT 0, quarantine_count bigint NOT NULL DEFAULT 0,
  deleted_count bigint NOT NULL DEFAULT 0, ambiguous_count bigint NOT NULL DEFAULT 0, bytes_reclaimable bigint NOT NULL DEFAULT 0, bytes_deleted bigint NOT NULL DEFAULT 0,
  report_hash char(64), report jsonb NOT NULL DEFAULT '{}', operator_approved boolean NOT NULL DEFAULT false, approved_by text, approved_at timestamptz,
  cancellation_requested boolean NOT NULL DEFAULT false, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS artifact_gc_plans_scope_idx ON artifact_gc_plans(tenant_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS artifact_gc_items (
  id text PRIMARY KEY, plan_id text NOT NULL REFERENCES artifact_gc_plans(id) ON DELETE RESTRICT, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  object_id text NOT NULL REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('PROTECT','QUARANTINE','TOMBSTONE','DELETE','AMBIGUOUS','SKIP')),
  reason text NOT NULL, ref_count bigint NOT NULL, reservation_count bigint NOT NULL, size_bytes bigint NOT NULL, diagnostics jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(plan_id,object_id)
);
CREATE INDEX IF NOT EXISTS artifact_gc_items_plan_idx ON artifact_gc_items(plan_id,decision,object_id);

CREATE OR REPLACE FUNCTION forge_artifact_content_ref_insert() RETURNS trigger AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM artifact_content_objects WHERE id=NEW.object_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF s IS NULL THEN RAISE EXCEPTION 'content object not found'; END IF;
  IF s IN ('TOMBSTONED','DELETED') THEN RAISE EXCEPTION 'content object is tombstoned or deleted'; END IF;
  IF NEW.active THEN UPDATE artifact_content_objects SET ref_count=ref_count+1,last_referenced_at=now(),status='READY' WHERE id=NEW.object_id; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION forge_artifact_content_ref_delete() RETURNS trigger AS $$
BEGIN IF OLD.active THEN UPDATE artifact_content_objects SET ref_count=GREATEST(ref_count-1,0) WHERE id=OLD.object_id; END IF; RETURN OLD; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION forge_artifact_content_ref_update() RETURNS trigger AS $$
BEGIN
  IF OLD.object_id<>NEW.object_id THEN RAISE EXCEPTION 'content object identity is immutable for an artifact'; END IF;
  IF OLD.active AND NOT NEW.active THEN UPDATE artifact_content_objects SET ref_count=GREATEST(ref_count-1,0) WHERE id=OLD.object_id;
  ELSIF NOT OLD.active AND NEW.active THEN
    PERFORM 1 FROM artifact_content_objects WHERE id=NEW.object_id AND status IN ('READY','QUARANTINED') FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'content object unavailable'; END IF;
    UPDATE artifact_content_objects SET ref_count=ref_count+1,last_referenced_at=now(),status='READY' WHERE id=NEW.object_id;
  END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS artifact_content_ref_insert_guard ON artifact_content_refs;
CREATE TRIGGER artifact_content_ref_insert_guard AFTER INSERT ON artifact_content_refs FOR EACH ROW EXECUTE FUNCTION forge_artifact_content_ref_insert();
DROP TRIGGER IF EXISTS artifact_content_ref_delete_guard ON artifact_content_refs;
CREATE TRIGGER artifact_content_ref_delete_guard AFTER DELETE ON artifact_content_refs FOR EACH ROW EXECUTE FUNCTION forge_artifact_content_ref_delete();
DROP TRIGGER IF EXISTS artifact_content_ref_update_guard ON artifact_content_refs;
CREATE TRIGGER artifact_content_ref_update_guard AFTER UPDATE OF active ON artifact_content_refs FOR EACH ROW EXECUTE FUNCTION forge_artifact_content_ref_update();

CREATE OR REPLACE FUNCTION forge_artifact_reservation_insert() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM artifact_content_objects WHERE id=NEW.object_id AND tenant_id=NEW.tenant_id AND status IN ('READY','QUARANTINED') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'content object unavailable for reservation'; END IF;
  IF NEW.state='HELD' THEN UPDATE artifact_content_objects SET reservation_count=reservation_count+1 WHERE id=NEW.object_id; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION forge_artifact_reservation_state() RETURNS trigger AS $$
BEGIN
  IF OLD.state='HELD' AND NEW.state<>'HELD' THEN UPDATE artifact_content_objects SET reservation_count=GREATEST(reservation_count-1,0) WHERE id=OLD.object_id;
  ELSIF OLD.state<>'HELD' AND NEW.state='HELD' THEN UPDATE artifact_content_objects SET reservation_count=reservation_count+1 WHERE id=NEW.object_id; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS artifact_storage_reservation_insert_guard ON artifact_storage_reservations;
CREATE TRIGGER artifact_storage_reservation_insert_guard AFTER INSERT ON artifact_storage_reservations FOR EACH ROW EXECUTE FUNCTION forge_artifact_reservation_insert();
DROP TRIGGER IF EXISTS artifact_storage_reservation_state_guard ON artifact_storage_reservations;
CREATE TRIGGER artifact_storage_reservation_state_guard AFTER UPDATE OF state ON artifact_storage_reservations FOR EACH ROW EXECUTE FUNCTION forge_artifact_reservation_state();

-- Backfill trusted storage objects before the trigger starts handling new writes.
INSERT INTO artifact_content_objects(id,tenant_id,sha256,size_bytes,media_type,kind,storage_key,checksum_verified,status,immutable_evidence,recovery_required,metadata)
SELECT 'legacy-content:'||so.id,p.tenant_id,so.content_hash,COALESCE(so.size_bytes,0),COALESCE(so.media_type,'application/octet-stream'),COALESCE(so.kind,'unknown'),so.storage_key,COALESCE(so.checksum_verified,false),CASE WHEN so.status='READY' THEN 'READY' ELSE 'QUARANTINED' END,
  CASE WHEN COALESCE(so.kind,'') IN ('package','render','render-manifest') THEN true ELSE false END,
  false,jsonb_build_object('backfilledFromStorageObject',so.id)
FROM storage_objects so JOIN projects p ON p.id=so.project_id
WHERE so.content_hash IS NOT NULL AND so.storage_key IS NOT NULL
ON CONFLICT (tenant_id,sha256) DO NOTHING;
INSERT INTO artifact_content_refs(id,tenant_id,project_id,artifact_id,object_id,ref_kind,source_version_id,active)
SELECT 'legacy-ref:'||so.artifact_id,p.tenant_id,so.project_id,so.artifact_id,aco.id,CASE WHEN COALESCE(so.kind,'') LIKE 'derivative:%' THEN 'DERIVED' ELSE 'IMMUTABLE' END,a.version_id,true
FROM storage_objects so JOIN projects p ON p.id=so.project_id JOIN artifacts a ON a.id=so.artifact_id JOIN artifact_content_objects aco ON aco.tenant_id=p.tenant_id AND aco.sha256=so.content_hash
WHERE so.artifact_id IS NOT NULL AND so.content_hash IS NOT NULL
ON CONFLICT (artifact_id) DO NOTHING;

CREATE OR REPLACE FUNCTION forge_sync_artifact_content_object() RETURNS trigger AS $$
DECLARE tenant text; version_id text; object_id text; ref_kind text;
BEGIN
  IF NEW.content_hash IS NULL OR NEW.storage_key IS NULL OR NEW.artifact_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id INTO tenant FROM projects WHERE id=NEW.project_id;
  SELECT version_id INTO version_id FROM artifacts WHERE id=NEW.artifact_id;
  IF tenant IS NULL OR version_id IS NULL THEN RETURN NEW; END IF;
  SELECT id INTO object_id FROM artifact_content_objects WHERE tenant_id=tenant AND sha256=NEW.content_hash FOR UPDATE;
  IF object_id IS NULL THEN
    object_id := 'storage-object:'||NEW.id;
    INSERT INTO artifact_content_objects(id,tenant_id,sha256,size_bytes,media_type,kind,storage_key,checksum_verified,status,immutable_evidence,recovery_required,metadata)
    VALUES(object_id,tenant,NEW.content_hash,COALESCE(NEW.size_bytes,0),COALESCE(NEW.media_type,'application/octet-stream'),COALESCE(NEW.kind,'unknown'),NEW.storage_key,COALESCE(NEW.checksum_verified,false),CASE WHEN NEW.status='READY' THEN 'READY' ELSE 'QUARANTINED' END,
      CASE WHEN COALESCE(NEW.kind,'') IN ('package','render','render-manifest') THEN true ELSE false END,false,jsonb_build_object('storageObjectId',NEW.id))
    ON CONFLICT (tenant_id,sha256) DO NOTHING;
    SELECT id INTO object_id FROM artifact_content_objects WHERE tenant_id=tenant AND sha256=NEW.content_hash;
  END IF;
  ref_kind := CASE WHEN COALESCE(NEW.kind,'') LIKE 'derivative:%' THEN 'DERIVED' ELSE 'IMMUTABLE' END;
  INSERT INTO artifact_content_refs(id,tenant_id,project_id,artifact_id,object_id,ref_kind,source_version_id,active)
  VALUES('storage-ref:'||NEW.id,tenant,NEW.project_id,NEW.artifact_id,object_id,ref_kind,version_id,true) ON CONFLICT(artifact_id) DO NOTHING;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_sync_artifact_content_object_trigger ON storage_objects;
CREATE TRIGGER forge_sync_artifact_content_object_trigger AFTER INSERT OR UPDATE OF content_hash,storage_key,size_bytes,status ON storage_objects FOR EACH ROW EXECUTE FUNCTION forge_sync_artifact_content_object();

COMMIT;
