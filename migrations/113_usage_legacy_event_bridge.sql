-- The existing usage_events table remains the execution-facing accounting surface.
-- This bridge makes its INSERT transaction also append the immutable billing record,
-- so provider/worker attempts cannot become billable outside the authoritative transaction.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO usage_pricing_versions(pricing_version,provider_type,provider,model,operation,unit,rate,currency,effective_at,metadata)
VALUES ('legacy-usage-v1','legacy','','','usage','unit',0,'USD','1970-01-01T00:00:00Z','{"system":true,"bridge":true}'::jsonb)
ON CONFLICT(pricing_version) DO NOTHING;

CREATE OR REPLACE FUNCTION bridge_usage_event_to_immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tenant TEXT;
  seq BIGINT;
  previous_hash TEXT;
  payload JSONB;
  amount NUMERIC(30,12) := COALESCE(NEW.actual_cost, NEW.normalized_cost_units, NEW.estimated_cost, 0);
  qty NUMERIC(30,12) := COALESCE(NEW.usage_units, 0);
  cur CHAR(3) := COALESCE(NULLIF(NEW.currency, ''), 'USD');
  event_uuid UUID;
  event_hash TEXT;
BEGIN
  IF COALESCE(NEW.outcome, '') = 'REJECTED' THEN RETURN NEW; END IF;
  SELECT tenant_id INTO tenant FROM forge_jobs WHERE id = NEW.job_id;
  IF tenant IS NULL THEN tenant := COALESCE(NEW.project_id, 'legacy-unknown'); END IF;
  IF EXISTS (SELECT 1 FROM usage_ledger_events WHERE idempotency_key = 'legacy-usage:' || NEW.id::text) THEN RETURN NEW; END IF;

  INSERT INTO usage_ledger_heads(tenant_id) VALUES(tenant) ON CONFLICT(tenant_id) DO NOTHING;
  SELECT sequence, last_integrity_hash INTO seq, previous_hash FROM usage_ledger_heads WHERE tenant_id=tenant FOR UPDATE;
  seq := seq + 1;
  event_uuid := gen_random_uuid();
  payload := jsonb_build_object(
    'eventId', event_uuid, 'tenantId', tenant, 'projectId', NEW.project_id, 'runId', NEW.provider_run_id,
    'jobId', NEW.job_id, 'attempt', NEW.execution_attempt, 'providerType', NEW.provider_type,
    'provider', NEW.provider, 'model', NEW.model, 'operation', NEW.operation,
    'dimension', COALESCE(NEW.stage,NEW.operation), 'quantity', qty, 'unit', 'legacy-unit',
    'rate', CASE WHEN qty=0 THEN 0 ELSE amount/qty END, 'currency', cur, 'amount', amount,
    'pricingVersion', 'legacy-usage-v1', 'idempotencyKey', 'legacy-usage:' || NEW.id::text,
    'eventType', 'USAGE', 'source', 'usage_events', 'occurredAt', COALESCE(NEW.occurred_at, NEW.created_at, now()),
    'sequence', seq, 'previousIntegrityHash', previous_hash
  );
  event_hash := encode(digest(payload::text, 'sha256'), 'hex');
  INSERT INTO usage_ledger_events(
    event_id,tenant_id,project_id,run_id,job_id,attempt,provider_type,provider,model,operation,dimension,
    quantity,unit,rate,currency,amount,pricing_version,idempotency_key,event_type,source,occurred_at,sequence,
    previous_integrity_hash,integrity_hash,canonical_payload,metadata
  ) VALUES(
    event_uuid,tenant,NEW.project_id,NEW.provider_run_id,NEW.job_id,NEW.execution_attempt,NEW.provider_type,
    NEW.provider,NEW.model,NEW.operation,COALESCE(NEW.stage,NEW.operation),qty,'legacy-unit',
    CASE WHEN qty=0 THEN 0 ELSE amount/qty END,cur,amount,'legacy-usage-v1','legacy-usage:' || NEW.id::text,
    'USAGE','usage_events',COALESCE(NEW.occurred_at,NEW.created_at,now()),seq,previous_hash,event_hash,payload,
    COALESCE(NEW.metadata,'{}'::jsonb)
  );
  UPDATE usage_ledger_heads SET sequence=seq,last_event_id=event_uuid,last_integrity_hash=event_hash,updated_at=now() WHERE tenant_id=tenant;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_events_immutable_ledger_bridge ON usage_events;
CREATE TRIGGER usage_events_immutable_ledger_bridge AFTER INSERT ON usage_events FOR EACH ROW EXECUTE FUNCTION bridge_usage_event_to_immutable_ledger();
