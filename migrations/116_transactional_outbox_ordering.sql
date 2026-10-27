BEGIN;

ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS ordering_key text;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS aggregate_sequence bigint;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS workflow_version_id text;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS causation_id text;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS correlation_id text;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS schema_name text;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS schema_version integer;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS redacted_payload jsonb;
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS payload_hash char(64);
ALTER TABLE forge_events ADD COLUMN IF NOT EXISTS immutable boolean NOT NULL DEFAULT true;

UPDATE forge_events
SET ordering_key = COALESCE(ordering_key, tenant_id || ':' || aggregate_type || ':' || COALESCE(aggregate_id, id)),
    schema_name = COALESCE(schema_name, type),
    schema_version = COALESCE(schema_version, version),
    redacted_payload = COALESCE(redacted_payload, payload),
    payload_hash = COALESCE(payload_hash, encode(digest(payload::text, 'sha256'), 'hex'))
WHERE ordering_key IS NULL OR schema_name IS NULL OR schema_version IS NULL OR redacted_payload IS NULL OR payload_hash IS NULL;

WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY ordering_key ORDER BY sequence_no, id) AS seq
  FROM forge_events
)
UPDATE forge_events e SET aggregate_sequence = ranked.seq
FROM ranked WHERE ranked.id=e.id AND e.aggregate_sequence IS NULL;

ALTER TABLE forge_events ALTER COLUMN ordering_key SET NOT NULL;
ALTER TABLE forge_events ALTER COLUMN aggregate_sequence SET NOT NULL;
ALTER TABLE forge_events ALTER COLUMN schema_name SET NOT NULL;
ALTER TABLE forge_events ALTER COLUMN schema_version SET NOT NULL;
ALTER TABLE forge_events ALTER COLUMN redacted_payload SET NOT NULL;
ALTER TABLE forge_events ALTER COLUMN payload_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS forge_events_aggregate_order_uq
  ON forge_events(tenant_id, ordering_key, aggregate_sequence);
CREATE INDEX IF NOT EXISTS forge_events_ordering_claim_idx
  ON forge_events(tenant_id, ordering_key, aggregate_sequence, created_at);

ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS event_id text REFERENCES forge_events(id) ON DELETE RESTRICT;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE RESTRICT;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS ordering_key text;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS ordering_sequence bigint;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS worker_id text;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS dead_letter_at timestamptz;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS quarantine_reason text;
ALTER TABLE forge_outbox ADD COLUMN IF NOT EXISTS last_error_code text;

UPDATE forge_outbox o
SET event_id = COALESCE(o.event_id, NULLIF(o.payload->>'eventId','')),
    tenant_id = COALESCE(o.tenant_id, e.tenant_id),
    project_id = COALESCE(o.project_id, e.project_id),
    ordering_key = COALESCE(o.ordering_key, e.ordering_key),
    ordering_sequence = COALESCE(o.ordering_sequence, e.aggregate_sequence)
FROM forge_events e
WHERE o.event_id IS NULL AND e.id = NULLIF(o.payload->>'eventId','');

CREATE UNIQUE INDEX IF NOT EXISTS forge_outbox_event_uq ON forge_outbox(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_outbox_order_claim_idx
  ON forge_outbox(tenant_id, ordering_key, ordering_sequence, available_at, id)
  WHERE published_at IS NULL AND dead_letter_at IS NULL;

CREATE TABLE IF NOT EXISTS forge_event_order_counters (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  ordering_key text NOT NULL,
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ordering_key)
);

INSERT INTO forge_event_order_counters(tenant_id, ordering_key, next_sequence)
SELECT tenant_id, ordering_key, max(aggregate_sequence)+1
FROM forge_events
GROUP BY tenant_id, ordering_key
ON CONFLICT (tenant_id, ordering_key) DO UPDATE SET next_sequence=GREATEST(forge_event_order_counters.next_sequence, EXCLUDED.next_sequence), updated_at=now();

CREATE OR REPLACE FUNCTION forge_redact_event_payload(p_payload jsonb) RETURNS jsonb AS $$
DECLARE result jsonb := '{}'::jsonb; k text; v jsonb;
BEGIN
  IF p_payload IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN RETURN p_payload; END IF;
  FOR k,v IN SELECT key,value FROM jsonb_each(p_payload) LOOP
    IF lower(k) ~ '(password|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|credential)' THEN
      result := result || jsonb_build_object(k, '[REDACTED]');
    ELSIF jsonb_typeof(v)='object' THEN
      result := result || jsonb_build_object(k, forge_redact_event_payload(v));
    ELSE
      result := result || jsonb_build_object(k,v);
    END IF;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION forge_next_event_sequence(p_tenant_id text, p_ordering_key text) RETURNS bigint AS $$
DECLARE next_seq bigint;
BEGIN
  INSERT INTO forge_event_order_counters(tenant_id, ordering_key, next_sequence)
  VALUES (p_tenant_id, p_ordering_key, 2)
  ON CONFLICT (tenant_id, ordering_key)
  DO UPDATE SET next_sequence = forge_event_order_counters.next_sequence + 1, updated_at=now()
  RETURNING next_sequence - 1 INTO next_seq;
  RETURN next_seq;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forge_capture_event(
  p_type text,
  p_project_id text,
  p_episode_id text,
  p_aggregate_type text,
  p_aggregate_id text,
  p_payload jsonb,
  p_run_id text DEFAULT NULL,
  p_workflow_version_id text DEFAULT NULL,
  p_causation_id text DEFAULT NULL,
  p_correlation_id text DEFAULT NULL
) RETURNS text AS $$
DECLARE event_id text; tenant text; event_key text; seq bigint; redacted jsonb;
BEGIN
  SELECT tenant_id INTO tenant FROM projects WHERE id=p_project_id;
  IF tenant IS NULL THEN RAISE EXCEPTION 'event project not found'; END IF;
  event_id := 'evt_' || replace(gen_random_uuid()::text,'-','');
  event_key := tenant || ':' || p_aggregate_type || ':' || COALESCE(p_aggregate_id,event_id);
  seq := forge_next_event_sequence(tenant,event_key);
  redacted := forge_redact_event_payload(COALESCE(p_payload,'{}'::jsonb));
  INSERT INTO forge_events(id,tenant_id,project_id,episode_id,type,version,schema,payload,aggregate_type,aggregate_id,provenance,ordering_key,aggregate_sequence,run_id,workflow_version_id,causation_id,correlation_id,schema_name,schema_version,redacted_payload,payload_hash)
  VALUES(event_id,tenant,p_project_id,p_episode_id,p_type,1,jsonb_build_object('name',p_type,'version',1),COALESCE(p_payload,'{}'::jsonb),p_aggregate_type,p_aggregate_id,jsonb_build_object('capture','transactional-db-trigger'),event_key,seq,p_run_id,p_workflow_version_id,p_causation_id,p_correlation_id,p_type,1,redacted,encode(digest(COALESCE(p_payload,'{}'::jsonb)::text,'sha256'),'hex'));
  INSERT INTO forge_outbox(topic,aggregate_type,aggregate_id,payload,event_id,tenant_id,project_id,ordering_key,ordering_sequence)
  VALUES('event.created','forge_event',event_id,jsonb_build_object('eventId',event_id),event_id,tenant,p_project_id,event_key,seq)
  ON CONFLICT (event_id) DO NOTHING;
  RETURN event_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forge_event_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.aggregate_type IS DISTINCT FROM NEW.aggregate_type OR OLD.aggregate_id IS DISTINCT FROM NEW.aggregate_id OR OLD.ordering_key IS DISTINCT FROM NEW.ordering_key OR OLD.aggregate_sequence IS DISTINCT FROM NEW.aggregate_sequence OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash OR OLD.payload IS DISTINCT FROM NEW.payload THEN
    RAISE EXCEPTION 'forge event identity and payload are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_event_immutable_guard ON forge_events;
CREATE TRIGGER forge_event_immutable_guard BEFORE UPDATE ON forge_events FOR EACH ROW EXECUTE FUNCTION forge_event_immutable_guard();

COMMIT;
