BEGIN;

CREATE TABLE IF NOT EXISTS forge_event_intake (
  intake_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text REFERENCES forge_inbound_events(id) ON DELETE RESTRICT,
  endpoint_id text NOT NULL REFERENCES forge_inbound_webhook_endpoints(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  external_event_id text NOT NULL,
  source_identity text NOT NULL,
  provider_identity text,
  schema_name text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz NOT NULL DEFAULT now(),
  signature_algorithm text,
  signature_key_id text,
  signature_fingerprint char(64),
  verification_state text NOT NULL CHECK (verification_state IN ('PENDING','VERIFIED','REJECTED')),
  nonce text,
  nonce_state text NOT NULL CHECK (nonce_state IN ('NOT_PRESENT','ACCEPTED','DUPLICATE','EXPIRED','REJECTED')),
  correlation_id text,
  causation_id text,
  payload_hash char(64) NOT NULL,
  deduplication_key text NOT NULL,
  processing_state text NOT NULL DEFAULT 'RECEIVED' CHECK (processing_state IN ('RECEIVED','ACCEPTED','DUPLICATE','PROCESSING','PROCESSED','QUARANTINED','REJECTED','REPLAY_PENDING','REPLAYING')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  quarantine_reason text,
  retention_until timestamptz,
  last_error text,
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  duplicate_count integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT forge_event_intake_event_identity_uk UNIQUE(endpoint_id, external_event_id)
);

CREATE INDEX IF NOT EXISTS forge_event_intake_scope_idx ON forge_event_intake(tenant_id, project_id, received_at DESC);
CREATE INDEX IF NOT EXISTS forge_event_intake_state_idx ON forge_event_intake(processing_state, received_at);
CREATE INDEX IF NOT EXISTS forge_event_intake_quarantine_idx ON forge_event_intake(tenant_id, processing_state, quarantine_reason) WHERE processing_state='QUARANTINED';
CREATE INDEX IF NOT EXISTS forge_event_intake_payload_idx ON forge_event_intake(endpoint_id, payload_hash);
CREATE INDEX IF NOT EXISTS forge_event_intake_dedup_idx ON forge_event_intake(endpoint_id, deduplication_key);
CREATE INDEX IF NOT EXISTS forge_event_intake_retention_idx ON forge_event_intake(retention_until) WHERE retention_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS forge_event_replay_claims (
  event_id text NOT NULL REFERENCES forge_inbound_events(id) ON DELETE RESTRICT,
  route_kind text NOT NULL CHECK (route_kind IN ('workflow','provider','reconciliation','runner')),
  claim_epoch bigint NOT NULL DEFAULT 1 CHECK (claim_epoch > 0),
  state text NOT NULL DEFAULT 'CLAIMED' CHECK (state IN ('CLAIMED','RELEASED','COMPLETED')),
  operator_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  completed_at timestamptz,
  reason text NOT NULL,
  PRIMARY KEY(event_id, route_kind, claim_epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_event_replay_active_uk ON forge_event_replay_claims(event_id, route_kind) WHERE state='CLAIMED';
CREATE INDEX IF NOT EXISTS forge_event_replay_claim_state_idx ON forge_event_replay_claims(state, claimed_at);

CREATE TABLE IF NOT EXISTS forge_event_order_watermarks (
  endpoint_id text NOT NULL REFERENCES forge_inbound_webhook_endpoints(id) ON DELETE RESTRICT,
  stream_key text NOT NULL,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
  gap_detected boolean NOT NULL DEFAULT false,
  gap_from bigint,
  gap_to bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(endpoint_id, stream_key)
);
CREATE INDEX IF NOT EXISTS forge_event_order_gap_idx ON forge_event_order_watermarks(endpoint_id, gap_detected) WHERE gap_detected;

CREATE OR REPLACE FUNCTION forge_event_intake_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.intake_id <> OLD.intake_id
     OR NEW.endpoint_id <> OLD.endpoint_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR COALESCE(NEW.project_id,'') <> COALESCE(OLD.project_id,'')
     OR NEW.external_event_id <> OLD.external_event_id
     OR NEW.source_identity <> OLD.source_identity
     OR COALESCE(NEW.provider_identity,'') <> COALESCE(OLD.provider_identity,'')
     OR NEW.schema_name <> OLD.schema_name
     OR NEW.schema_version <> OLD.schema_version
     OR NEW.payload_hash <> OLD.payload_hash
     OR NEW.deduplication_key <> OLD.deduplication_key
     OR (OLD.event_id IS NOT NULL AND NEW.event_id IS DISTINCT FROM OLD.event_id)
  THEN RAISE EXCEPTION 'inbound intake identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_event_intake_immutable ON forge_event_intake;
CREATE TRIGGER forge_event_intake_immutable BEFORE UPDATE ON forge_event_intake FOR EACH ROW EXECUTE FUNCTION forge_event_intake_immutable_guard();

CREATE OR REPLACE FUNCTION forge_event_intake_scope_guard() RETURNS trigger AS $$
DECLARE project_tenant text;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id;
    IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN
      RAISE EXCEPTION 'inbound intake tenant/project mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_event_intake_scope ON forge_event_intake;
CREATE TRIGGER forge_event_intake_scope BEFORE INSERT OR UPDATE OF tenant_id,project_id ON forge_event_intake FOR EACH ROW EXECUTE FUNCTION forge_event_intake_scope_guard();

CREATE OR REPLACE FUNCTION forge_event_replay_claim_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.event_id <> OLD.event_id OR NEW.route_kind <> OLD.route_kind OR NEW.claim_epoch <> OLD.claim_epoch OR NEW.operator_id <> OLD.operator_id OR NEW.claimed_at <> OLD.claimed_at THEN
    RAISE EXCEPTION 'replay claim identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_event_replay_claim_immutable ON forge_event_replay_claims;
CREATE TRIGGER forge_event_replay_claim_immutable BEFORE UPDATE ON forge_event_replay_claims FOR EACH ROW EXECUTE FUNCTION forge_event_replay_claim_immutable_guard();

COMMIT;
