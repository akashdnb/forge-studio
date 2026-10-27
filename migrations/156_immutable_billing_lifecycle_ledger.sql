BEGIN;

CREATE TABLE IF NOT EXISTS usage_billing_ledger_heads (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  sequence BIGINT NOT NULL DEFAULT 0,
  last_event_id UUID,
  last_integrity_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_billing_ledger (
  event_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  reservation_id UUID REFERENCES usage_billing_reservations(reservation_id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('RESERVATION','COMMIT','RELEASE','REFUND','EXPIRE','CORRECTION')),
  quantity NUMERIC(30,12) NOT NULL CHECK (quantity >= 0),
  amount NUMERIC(30,12) NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  plan_version_id TEXT NOT NULL REFERENCES forge_plan_versions(id) ON DELETE RESTRICT,
  plan_assignment_id TEXT REFERENCES forge_tenant_plan_assignments(id) ON DELETE RESTRICT,
  pricing_version TEXT NOT NULL REFERENCES usage_pricing_versions(pricing_version) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_execution_ref TEXT,
  sequence BIGINT NOT NULL,
  previous_integrity_hash TEXT,
  integrity_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,sequence)
);
CREATE INDEX IF NOT EXISTS usage_billing_ledger_tenant_time_idx ON usage_billing_ledger(tenant_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_billing_ledger_reservation_idx ON usage_billing_ledger(reservation_id,sequence);

CREATE OR REPLACE FUNCTION forbid_usage_billing_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'billing lifecycle ledger is append-only: % is forbidden for event %',TG_OP,COALESCE(OLD.event_id::text,NEW.event_id::text); END;
$$;
DROP TRIGGER IF EXISTS usage_billing_ledger_immutable_update ON usage_billing_ledger;
DROP TRIGGER IF EXISTS usage_billing_ledger_immutable_delete ON usage_billing_ledger;
CREATE TRIGGER usage_billing_ledger_immutable_update BEFORE UPDATE ON usage_billing_ledger FOR EACH ROW EXECUTE FUNCTION forbid_usage_billing_ledger_mutation();
CREATE TRIGGER usage_billing_ledger_immutable_delete BEFORE DELETE ON usage_billing_ledger FOR EACH ROW EXECUTE FUNCTION forbid_usage_billing_ledger_mutation();

CREATE OR REPLACE FUNCTION append_billing_lifecycle_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tenant TEXT:=NEW.tenant_id; event_type TEXT; qty NUMERIC(30,12); amount NUMERIC(30,12); event_uuid UUID:=gen_random_uuid(); seq BIGINT; previous_hash TEXT; payload JSONB; event_hash TEXT;
BEGIN
  IF TG_OP='INSERT' THEN event_type:='RESERVATION'; qty:=NEW.reserved_quantity; amount:=NEW.reserved_amount;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status='COMMITTED' THEN event_type:='COMMIT';qty:=NEW.committed_quantity;amount:=NEW.committed_amount;
    ELSIF NEW.status='PARTIALLY_COMMITTED' THEN event_type:='COMMIT';qty:=NEW.committed_quantity;amount:=NEW.committed_amount;
    ELSIF NEW.status='RELEASED' THEN event_type:='RELEASE';qty:=GREATEST(NEW.reserved_quantity-NEW.committed_quantity,0);amount:=GREATEST(NEW.reserved_amount-NEW.committed_amount,0);
    ELSIF NEW.status='REFUNDED' THEN event_type:='REFUND';qty:=NEW.refunded_quantity;amount:=-NEW.refunded_amount;
    ELSIF NEW.status='EXPIRED' THEN event_type:='EXPIRE';qty:=GREATEST(NEW.reserved_quantity-NEW.committed_quantity,0);amount:=-GREATEST(NEW.reserved_amount-NEW.committed_amount,0);
    ELSE RETURN NEW; END IF;
  ELSE RETURN NEW; END IF;
  INSERT INTO usage_billing_ledger_heads(tenant_id) VALUES(tenant) ON CONFLICT(tenant_id) DO NOTHING;
  SELECT sequence,last_integrity_hash INTO seq,previous_hash FROM usage_billing_ledger_heads WHERE tenant_id=tenant FOR UPDATE;
  seq:=seq+1;
  payload:=jsonb_build_object('eventId',event_uuid,'tenantId',tenant,'projectId',NEW.project_id,'reservationId',NEW.reservation_id,'eventType',event_type,'quantity',qty,'amount',amount,'currency',NEW.currency,'planVersionId',NEW.plan_version_id,'planAssignmentId',NEW.plan_assignment_id,'pricingVersion',NEW.pricing_version,'idempotencyKey','billing-lifecycle:'||NEW.reservation_id::text||':'||event_type,'sourceExecutionRef',NEW.source_execution_ref,'sequence',seq,'previousIntegrityHash',previous_hash);
  event_hash:=encode(digest(payload::text,'sha256'),'hex');
  INSERT INTO usage_billing_ledger(event_id,tenant_id,project_id,reservation_id,event_type,quantity,amount,currency,plan_version_id,plan_assignment_id,pricing_version,idempotency_key,source_execution_ref,sequence,previous_integrity_hash,integrity_hash,metadata)
  VALUES(event_uuid,tenant,NEW.project_id,NEW.reservation_id,event_type,qty,amount,NEW.currency,NEW.plan_version_id,NEW.plan_assignment_id,NEW.pricing_version,'billing-lifecycle:'||NEW.reservation_id::text||':'||event_type,NEW.source_execution_ref,seq,previous_hash,event_hash,jsonb_build_object('reservationStatus',NEW.status));
  UPDATE usage_billing_ledger_heads SET sequence=seq,last_event_id=event_uuid,last_integrity_hash=event_hash,updated_at=now() WHERE tenant_id=tenant;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS usage_billing_lifecycle_append ON usage_billing_reservations;
CREATE TRIGGER usage_billing_lifecycle_append AFTER INSERT OR UPDATE OF status ON usage_billing_reservations FOR EACH ROW EXECUTE FUNCTION append_billing_lifecycle_event();

COMMIT;
