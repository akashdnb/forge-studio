BEGIN;

-- Request-level idempotency is scoped by tenant/project + operation + caller key.
-- The request body is never stored: only its canonical SHA-256 fingerprint is kept.
CREATE TABLE IF NOT EXISTS forge_api_idempotency_keys (
  id bigserial PRIMARY KEY,
  tenant_id text,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  actor text NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMMITTED','EXPIRED')),
  response_status integer,
  response_body jsonb,
  outcome_hash char(64),
  resource_type text,
  resource_id text,
  release_epoch bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  CHECK (tenant_id IS NOT NULL OR project_id IS NOT NULL),
  CHECK (char_length(operation) BETWEEN 1 AND 128),
  CHECK (char_length(idempotency_key) BETWEEN 8 AND 255),
  CHECK (status <> 'COMMITTED' OR (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL AND outcome_hash IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_api_idempotency_scope_key_idx
  ON forge_api_idempotency_keys(coalesce(tenant_id, ''), coalesce(project_id, ''), operation, idempotency_key);
CREATE INDEX IF NOT EXISTS forge_api_idempotency_expiry_idx
  ON forge_api_idempotency_keys(expires_at)
  WHERE status IN ('COMMITTED','EXPIRED');
CREATE INDEX IF NOT EXISTS forge_api_idempotency_resource_idx
  ON forge_api_idempotency_keys(project_id, resource_type, resource_id, created_at DESC);

-- Immutable evidence is retained separately so bounded idempotency cleanup does not erase audit history.
CREATE TABLE IF NOT EXISTS forge_api_idempotency_events (
  id bigserial PRIMARY KEY,
  tenant_id text,
  project_id text,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('CLAIMED','COMMITTED','REPLAYED','CONFLICT','EXPIRED','FAILED')),
  actor text NOT NULL,
  request_id text NOT NULL,
  outcome_hash char(64),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_api_idempotency_events_scope_idx
  ON forge_api_idempotency_events(tenant_id, project_id, operation, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_api_idempotency_events_key_idx
  ON forge_api_idempotency_events(idempotency_key, created_at DESC);

-- Generic durable fences for mutable resources and one-time side effects that do not have
-- a domain-specific revision column yet. The resource row is locked in the caller's tx.
CREATE TABLE IF NOT EXISTS forge_resource_fences (
  id bigserial PRIMARY KEY,
  tenant_id text,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  epoch bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (tenant_id IS NOT NULL OR project_id IS NOT NULL),
  CHECK (version >= 0),
  CHECK (epoch > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_resource_fences_scope_idx
  ON forge_resource_fences(coalesce(tenant_id, ''), coalesce(project_id, ''), resource_type, resource_id);
CREATE INDEX IF NOT EXISTS forge_resource_fences_project_idx
  ON forge_resource_fences(project_id, resource_type, updated_at DESC);

-- Callback receipts make an external event identity one-time without relying on process memory.
CREATE TABLE IF NOT EXISTS forge_callback_receipts (
  id bigserial PRIMARY KEY,
  tenant_id text,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  source text NOT NULL,
  external_event_id text NOT NULL,
  payload_hash char(64) NOT NULL,
  status text NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED','APPLIED','IGNORED','CONFLICT')),
  attempt_id text,
  observed_epoch bigint,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (tenant_id IS NOT NULL OR project_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_callback_receipts_scope_idx
  ON forge_callback_receipts(coalesce(tenant_id, ''), coalesce(project_id, ''), source, external_event_id);
CREATE INDEX IF NOT EXISTS forge_callback_receipts_hash_idx
  ON forge_callback_receipts(source, payload_hash, first_seen_at DESC);

-- Once an outcome is committed it is immutable. Replay/conflict evidence is appended instead.
CREATE OR REPLACE FUNCTION forge_api_idempotency_immutable_outcome() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'COMMITTED' THEN
    IF NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.response_status IS DISTINCT FROM OLD.response_status
       OR NEW.response_body IS DISTINCT FROM OLD.response_body
       OR NEW.outcome_hash IS DISTINCT FROM OLD.outcome_hash
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id THEN
      RAISE EXCEPTION 'committed idempotency outcome is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_api_idempotency_immutable_outcome_guard ON forge_api_idempotency_keys;
CREATE TRIGGER forge_api_idempotency_immutable_outcome_guard
BEFORE UPDATE ON forge_api_idempotency_keys
FOR EACH ROW EXECUTE FUNCTION forge_api_idempotency_immutable_outcome();

-- Operational cleanup is bounded and never removes immutable evidence.
CREATE OR REPLACE FUNCTION forge_prune_api_idempotency(p_limit integer DEFAULT 1000) RETURNS integer AS $$
DECLARE removed integer;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'p_limit must be between 1 and 10000'; END IF;
  WITH doomed AS (
    SELECT id
    FROM forge_api_idempotency_keys
    WHERE expires_at < now()
      AND status IN ('COMMITTED','EXPIRED')
    ORDER BY expires_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM forge_api_idempotency_keys k
  USING doomed d
  WHERE k.id=d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql;

COMMIT;
