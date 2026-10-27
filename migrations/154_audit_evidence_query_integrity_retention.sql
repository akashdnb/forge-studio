BEGIN;

CREATE TABLE IF NOT EXISTS evidence_search_index (
  event_id char(64) PRIMARY KEY REFERENCES evidence_ledger(event_id) ON DELETE RESTRICT,
  ledger_seq bigint NOT NULL UNIQUE,
  tenant_id text,
  project_id text,
  episode_id text,
  actor text NOT NULL,
  service_identity text,
  event_class text NOT NULL,
  source_table text NOT NULL,
  operation text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  resource_version_id text,
  request_id text,
  correlation_id text,
  causation_id char(64),
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  canonical_payload_hash char(64) NOT NULL,
  prev_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  retention_state text NOT NULL DEFAULT 'ACTIVE' CHECK(retention_state IN ('ACTIVE','ARCHIVED','EXPIRED','QUARANTINED','PRESERVED')),
  legal_hold boolean NOT NULL DEFAULT false,
  redaction_level text NOT NULL DEFAULT 'STANDARD' CHECK(redaction_level IN ('STANDARD','SENSITIVE','RESTRICTED')),
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_search_tenant_time_idx ON evidence_search_index(tenant_id, occurred_at DESC, ledger_seq DESC);
CREATE INDEX IF NOT EXISTS evidence_search_tenant_project_time_idx ON evidence_search_index(tenant_id, project_id, occurred_at DESC, ledger_seq DESC);
CREATE INDEX IF NOT EXISTS evidence_search_tenant_class_time_idx ON evidence_search_index(tenant_id, event_class, occurred_at DESC, ledger_seq DESC);
CREATE INDEX IF NOT EXISTS evidence_search_tenant_actor_time_idx ON evidence_search_index(tenant_id, actor, occurred_at DESC, ledger_seq DESC);
CREATE INDEX IF NOT EXISTS evidence_search_tenant_target_idx ON evidence_search_index(tenant_id, target_type, target_id, ledger_seq DESC);
CREATE INDEX IF NOT EXISTS evidence_search_tenant_request_idx ON evidence_search_index(tenant_id, request_id, ledger_seq DESC);
CREATE INDEX IF NOT EXISTS evidence_search_tenant_hash_idx ON evidence_search_index(tenant_id, event_hash);

CREATE TABLE IF NOT EXISTS evidence_integrity_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text,
  from_seq bigint NOT NULL,
  to_seq bigint NOT NULL,
  checked bigint NOT NULL DEFAULT 0,
  issue_count bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK(status IN ('RUNNING','PASSED','FAILED','PARTIAL')),
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK(from_seq <= to_seq)
);
CREATE INDEX IF NOT EXISTS evidence_integrity_runs_scope_idx ON evidence_integrity_runs(tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS evidence_export_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id text,
  actor text NOT NULL,
  privileged boolean NOT NULL DEFAULT false,
  from_seq bigint,
  to_seq bigint,
  event_count bigint NOT NULL,
  export_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_export_audit_scope_idx ON evidence_export_audit(tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION forge_evidence_event_class(source_name text, operation_name text) RETURNS text AS $$
BEGIN
  IF source_name IN ('approvals','forge_release_approvals','workflow_plan_approvals','human_approval_requests') THEN RETURN 'APPROVAL'; END IF;
  IF source_name LIKE '%policy%' OR source_name IN ('runtime_config_audit','privacy_decision_evidence') THEN RETURN 'POLICY'; END IF;
  IF source_name LIKE '%credential%' OR source_name LIKE '%secret%' THEN RETURN 'CREDENTIAL'; END IF;
  IF source_name IN ('forge_jobs','forge_execution_runs','provider_runs','publish_runs','forge_scheduler_events','forge_scheduler_state') THEN RETURN 'WORKFLOW'; END IF;
  IF source_name LIKE '%artifact%' OR source_name IN ('version_records','version_dependencies') THEN RETURN 'ARTIFACT'; END IF;
  IF source_name LIKE '%release%' OR source_name LIKE '%publish%' THEN RETURN 'RELEASE'; END IF;
  IF source_name LIKE '%security%' OR source_name LIKE '%token%' THEN RETURN 'SECURITY'; END IF;
  IF source_name LIKE '%provenance%' OR source_name LIKE '%lineage%' THEN RETURN 'PROVENANCE'; END IF;
  IF operation_name='DELETE' THEN RETURN 'DELETION';
  RETURN 'DATA_MUTATION';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION forge_evidence_redaction_level(source_name text) RETURNS text AS $$
BEGIN
  IF source_name LIKE '%credential%' OR source_name LIKE '%secret%' OR source_name LIKE '%token%' THEN RETURN 'RESTRICTED';
  IF source_name LIKE '%security%' OR source_name LIKE '%webhook%' OR source_name LIKE '%provider%' OR source_name LIKE '%payload%' THEN RETURN 'SENSITIVE';
  RETURN 'STANDARD';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION forge_evidence_index_ledger_row() RETURNS trigger AS $$
DECLARE
  source_name text := NEW.source_table;
  class_name text;
  hold_flag boolean;
  retention_state_value text := 'ACTIVE';
  version_value text;
  service_value text;
BEGIN
  class_name := forge_evidence_event_class(source_name, NEW.operation);
  version_value := NEW.provenance_id;
  service_value := NULLIF(current_setting('forge.service_identity', true), '');
  SELECT EXISTS (
    SELECT 1 FROM privacy_holds h
    WHERE h.active AND h.tenant_id IS NOT DISTINCT FROM NEW.tenant_id
      AND (h.project_id IS NULL OR h.project_id = NEW.project_id)
  ) INTO hold_flag;
  IF hold_flag THEN retention_state_value := 'PRESERVED'; END IF;
  INSERT INTO evidence_search_index(
    event_id,ledger_seq,tenant_id,project_id,episode_id,actor,service_identity,event_class,
    source_table,operation,target_type,target_id,resource_version_id,request_id,correlation_id,
    causation_id,occurred_at,canonical_payload_hash,prev_hash,event_hash,retention_state,legal_hold,redaction_level
  ) VALUES (
    NEW.event_id,NEW.ledger_seq,NEW.tenant_id,NEW.project_id,NEW.episode_id,NEW.actor,service_value,class_name,
    NEW.source_table,NEW.operation,NEW.target_type,NEW.target_id,version_value,NEW.request_id,
    NEW.request_id,NEW.causal_event_id,NEW.occurred_at,NEW.payload_digest,NEW.prev_hash,NEW.event_hash,
    retention_state_value,COALESCE(hold_flag,false),forge_evidence_redaction_level(source_name)
  ) ON CONFLICT(event_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evidence_index_after_insert ON evidence_ledger;
CREATE TRIGGER evidence_index_after_insert AFTER INSERT ON evidence_ledger FOR EACH ROW EXECUTE FUNCTION forge_evidence_index_ledger_row();

INSERT INTO evidence_search_index(event_id,ledger_seq,tenant_id,project_id,episode_id,actor,event_class,source_table,operation,target_type,target_id,resource_version_id,request_id,causation_id,occurred_at,canonical_payload_hash,prev_hash,event_hash)
SELECT event_id,ledger_seq,tenant_id,project_id,episode_id,actor,forge_evidence_event_class(source_table,operation),source_table,operation,target_type,target_id,provenance_id,request_id,causal_event_id,occurred_at,payload_digest,prev_hash,event_hash
FROM evidence_ledger
ON CONFLICT(event_id) DO NOTHING;

CREATE OR REPLACE FUNCTION forge_evidence_search_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'evidence search index is immutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS evidence_search_index_immutable ON evidence_search_index;
CREATE TRIGGER evidence_search_index_immutable BEFORE UPDATE OR DELETE ON evidence_search_index FOR EACH ROW EXECUTE FUNCTION forge_evidence_search_immutable();

COMMIT;
