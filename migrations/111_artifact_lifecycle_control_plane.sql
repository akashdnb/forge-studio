-- Artifact lifecycle control plane: durable reachability generations, active-use leases,
-- deletion intents, provider reconciliation and immutable integrity evidence.
BEGIN;

CREATE TABLE IF NOT EXISTS artifact_gc_generations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  generation bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('MARKING','MARKED','SWEEPING','COMPLETED','FAILED','CANCELLED')),
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  worker_id text NOT NULL,
  fence_token uuid NOT NULL,
  cursor_object_id text,
  marked_count bigint NOT NULL DEFAULT 0 CHECK (marked_count >= 0),
  swept_count bigint NOT NULL DEFAULT 0 CHECK (swept_count >= 0),
  protected_count bigint NOT NULL DEFAULT 0 CHECK (protected_count >= 0),
  ambiguous_count bigint NOT NULL DEFAULT 0 CHECK (ambiguous_count >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_gc_generation_active_idx
  ON artifact_gc_generations(tenant_id) WHERE state IN ('MARKING','MARKED','SWEEPING');
CREATE INDEX IF NOT EXISTS artifact_gc_generation_cursor_idx
  ON artifact_gc_generations(tenant_id, state, cursor_object_id);

CREATE TABLE IF NOT EXISTS artifact_gc_marks (
  generation_id text NOT NULL REFERENCES artifact_gc_generations(id) ON DELETE RESTRICT,
  object_id text NOT NULL REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  root_type text NOT NULL,
  evidence_hash char(64) NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (generation_id, object_id)
);
CREATE INDEX IF NOT EXISTS artifact_gc_marks_object_idx ON artifact_gc_marks(object_id, generation_id);

CREATE TABLE IF NOT EXISTS artifact_use_leases (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  object_id text REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  purpose text NOT NULL,
  owner_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('ACTIVE','RELEASED','EXPIRED')),
  lease_version bigint NOT NULL DEFAULT 1 CHECK (lease_version > 0),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS artifact_use_leases_active_idx
  ON artifact_use_leases(tenant_id, artifact_id, state, expires_at);
CREATE INDEX IF NOT EXISTS artifact_use_leases_expiry_idx
  ON artifact_use_leases(state, expires_at);

CREATE TABLE IF NOT EXISTS artifact_deletion_intents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  object_id text NOT NULL REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  generation_id text NOT NULL REFERENCES artifact_gc_generations(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('REQUESTED','QUARANTINED','APPROVED','DELETING','DELETED','CANCELLED','FAILED')),
  fence_token uuid NOT NULL,
  storage_key text NOT NULL,
  sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  grace_until timestamptz NOT NULL,
  approval_required boolean NOT NULL DEFAULT true,
  approved_by text,
  approved_at timestamptz,
  provider_attempts integer NOT NULL DEFAULT 0 CHECK (provider_attempts >= 0),
  last_provider_error jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  deleting_at timestamptz,
  deleted_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (generation_id, object_id)
);
CREATE INDEX IF NOT EXISTS artifact_deletion_intents_ready_idx
  ON artifact_deletion_intents(tenant_id, state, grace_until);
CREATE INDEX IF NOT EXISTS artifact_deletion_intents_object_idx
  ON artifact_deletion_intents(object_id, state);

CREATE TABLE IF NOT EXISTS artifact_provider_reconciliation (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  object_id text NOT NULL REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  storage_key text NOT NULL,
  observed_state text NOT NULL CHECK (observed_state IN ('PRESENT','MISSING','CORRUPT','UNKNOWN')),
  expected_sha256 char(64),
  observed_sha256 char(64),
  expected_size_bytes bigint,
  observed_size_bytes bigint,
  action text NOT NULL CHECK (action IN ('CONFIRMED','QUARANTINED','RESURRECTED','MISSING','RETRY','SKIPPED')),
  evidence_hash char(64) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_provider_reconciliation_object_idx
  ON artifact_provider_reconciliation(object_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS artifact_lifecycle_evidence (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  object_id text REFERENCES artifact_content_objects(id) ON DELETE RESTRICT,
  generation_id text REFERENCES artifact_gc_generations(id) ON DELETE RESTRICT,
  deletion_intent_id text REFERENCES artifact_deletion_intents(id) ON DELETE RESTRICT,
  action text NOT NULL,
  actor text NOT NULL,
  fence_token uuid,
  evidence_hash char(64) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifact_lifecycle_evidence_scope_idx
  ON artifact_lifecycle_evidence(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS artifact_lifecycle_evidence_object_idx
  ON artifact_lifecycle_evidence(object_id, created_at DESC);

-- A new active lease/reference wins over a pending destructive intent.
CREATE OR REPLACE FUNCTION forge_artifact_deletion_guard() RETURNS trigger AS $$
DECLARE blocked boolean;
BEGIN
  IF NEW.state = 'ACTIVE' THEN
    SELECT EXISTS (
      SELECT 1 FROM artifact_deletion_intents d
      WHERE d.object_id = NEW.object_id
        AND d.state IN ('APPROVED','DELETING')
        AND d.grace_until <= now()
    ) INTO blocked;
    IF blocked THEN
      RAISE EXCEPTION 'artifact deletion is fenced; acquire a lifecycle lease before use' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS artifact_deletion_guard_lease ON artifact_use_leases;
CREATE TRIGGER artifact_deletion_guard_lease
BEFORE INSERT OR UPDATE OF state ON artifact_use_leases
FOR EACH ROW EXECUTE FUNCTION forge_artifact_deletion_guard();

CREATE OR REPLACE FUNCTION forge_artifact_deletion_guard_ref() RETURNS trigger AS $$
DECLARE object_id text; blocked boolean;
BEGIN
  IF TG_TABLE_NAME = 'artifact_content_refs' THEN object_id := NEW.object_id;
  ELSE object_id := NULL; END IF;
  IF object_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM artifact_deletion_intents d
      WHERE d.object_id=object_id AND d.state IN ('APPROVED','DELETING') AND d.grace_until <= now()
    ) INTO blocked;
    IF blocked THEN RAISE EXCEPTION 'artifact reference is fenced by deletion intent' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS artifact_deletion_guard_content_ref ON artifact_content_refs;
CREATE TRIGGER artifact_deletion_guard_content_ref
BEFORE INSERT OR UPDATE ON artifact_content_refs
FOR EACH ROW EXECUTE FUNCTION forge_artifact_deletion_guard_ref();

COMMIT;
