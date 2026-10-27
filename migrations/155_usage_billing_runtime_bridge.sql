BEGIN;

INSERT INTO usage_pricing_versions(pricing_version,provider_type,provider,model,operation,unit,rate,currency,effective_at,metadata)
VALUES
 ('operator-adjustment-v1','billing','','','adjustment','adjustment',0,'USD','1970-01-01T00:00:00Z','{"system":true}'::jsonb),
 ('reservation-release-v1','quota','','','release','unit',0,'USD','1970-01-01T00:00:00Z','{"system":true}'::jsonb),
 ('legacy-usage-v1','legacy','','','usage','unit',0,'USD','1970-01-01T00:00:00Z','{"system":true,"bridge":true}'::jsonb)
ON CONFLICT(pricing_version) DO NOTHING;

CREATE OR REPLACE FUNCTION bridge_usage_event_to_immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tenant TEXT;
  reservation RECORD;
  assignment RECORD;
  pricing TEXT := 'legacy-usage-v1';
  plan_version TEXT;
  plan_assignment TEXT;
  seq BIGINT;
  previous_hash TEXT;
  payload JSONB;
  amount NUMERIC(30,12) := COALESCE(NEW.actual_cost, NEW.normalized_cost_units, NEW.estimated_cost, 0);
  qty NUMERIC(30,12) := COALESCE(NEW.usage_units, 0);
  cur CHAR(3) := COALESCE(NULLIF(NEW.currency, ''), 'USD');
  event_uuid UUID;
  event_hash TEXT;
  source_ref TEXT;
BEGIN
  IF COALESCE(NEW.outcome, '') = 'REJECTED' THEN RETURN NEW; END IF;
  SELECT tenant_id INTO tenant FROM forge_jobs WHERE id=NEW.job_id;
  IF tenant IS NULL THEN tenant := COALESCE(NEW.project_id, 'legacy-unknown'); END IF;
  source_ref := CASE WHEN NEW.job_id IS NULL THEN NULL ELSE 'job:'||NEW.job_id::text||':attempt:'||COALESCE(NEW.execution_attempt,1)::text END;

  SELECT * INTO reservation FROM usage_billing_reservations
   WHERE job_id=NEW.job_id AND attempt=COALESCE(NEW.execution_attempt,1)
   ORDER BY created_at DESC LIMIT 1;
  IF reservation.reservation_id IS NOT NULL THEN
    pricing := reservation.pricing_version;
    plan_version := reservation.plan_version_id;
    plan_assignment := reservation.plan_assignment_id;
    source_ref := reservation.source_execution_ref;
  ELSE
    SELECT a.id assignment_id,a.plan_version_id INTO assignment
      FROM forge_tenant_plan_assignments a
      WHERE a.tenant_id=tenant AND a.effective_at<=COALESCE(NEW.occurred_at,NEW.created_at,now())
        AND (a.expires_at IS NULL OR a.expires_at>COALESCE(NEW.occurred_at,NEW.created_at,now()))
        AND a.status IN ('ACTIVE','SCHEDULED')
      ORDER BY a.effective_at DESC,a.epoch DESC LIMIT 1;
    plan_version := assignment.plan_version_id;
    plan_assignment := assignment.assignment_id;
  END IF;

  IF EXISTS (SELECT 1 FROM usage_ledger_events WHERE idempotency_key='legacy-usage:'||NEW.id::text) THEN RETURN NEW; END IF;
  INSERT INTO usage_ledger_heads(tenant_id) VALUES(tenant) ON CONFLICT(tenant_id) DO NOTHING;
  SELECT sequence,last_integrity_hash INTO seq,previous_hash FROM usage_ledger_heads WHERE tenant_id=tenant FOR UPDATE;
  seq := seq+1; event_uuid := gen_random_uuid();
  payload := jsonb_build_object(
    'eventId',event_uuid,'tenantId',tenant,'projectId',NEW.project_id,'runId',NEW.provider_run_id,'jobId',NEW.job_id,
    'attempt',NEW.execution_attempt,'providerType',NEW.provider_type,'provider',NEW.provider,'model',NEW.model,
    'operation',NEW.operation,'dimension',COALESCE(NEW.stage,NEW.operation),'quantity',qty,'unit','usage-unit',
    'rate',CASE WHEN qty=0 THEN 0 ELSE amount/qty END,'currency',cur,'amount',amount,'pricingVersion',pricing,
    'idempotencyKey','legacy-usage:'||NEW.id::text,'eventType','USAGE','source','usage_events','occurredAt',COALESCE(NEW.occurred_at,NEW.created_at,now()),
    'sequence',seq,'previousIntegrityHash',previous_hash,'planVersionId',plan_version,'planAssignmentId',plan_assignment,'sourceExecutionRef',source_ref
  );
  event_hash := encode(digest(payload::text,'sha256'),'hex');
  INSERT INTO usage_ledger_events(event_id,tenant_id,project_id,run_id,job_id,attempt,provider_type,provider,model,operation,dimension,quantity,unit,rate,currency,amount,pricing_version,idempotency_key,event_type,source,occurred_at,sequence,previous_integrity_hash,integrity_hash,canonical_payload,metadata,plan_version_id,plan_assignment_id,reservation_id,source_execution_ref,evidence_fingerprint)
  VALUES(event_uuid,tenant,NEW.project_id,NEW.provider_run_id,NEW.job_id,NEW.execution_attempt,NEW.provider_type,NEW.provider,NEW.model,NEW.operation,COALESCE(NEW.stage,NEW.operation),qty,'usage-unit',CASE WHEN qty=0 THEN 0 ELSE amount/qty END,cur,amount,pricing,'legacy-usage:'||NEW.id::text,'USAGE','usage_events',COALESCE(NEW.occurred_at,NEW.created_at,now()),seq,previous_hash,event_hash,payload,COALESCE(NEW.metadata,'{}'::jsonb),plan_version,plan_assignment,reservation.reservation_id,source_ref,COALESCE(NEW.id::text,'legacy'));
  UPDATE usage_ledger_heads SET sequence=seq,last_event_id=event_uuid,last_integrity_hash=event_hash,updated_at=now() WHERE tenant_id=tenant;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS usage_events_immutable_ledger_bridge ON usage_events;
CREATE TRIGGER usage_events_immutable_ledger_bridge AFTER INSERT ON usage_events FOR EACH ROW EXECUTE FUNCTION bridge_usage_event_to_immutable_ledger();

COMMIT;
