BEGIN;

-- Search index consistency v2. Source tables remain authoritative. The active
-- forge_search_documents table is still the read model used by existing queries;
-- rebuilds are staged separately and cut over atomically under MVCC.
ALTER TABLE forge_search_index_meta
  ADD COLUMN IF NOT EXISTS active_generation text,
  ADD COLUMN IF NOT EXISTS generation_epoch bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_applied_event_id bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_state text;

ALTER TABLE forge_search_documents
  ADD COLUMN IF NOT EXISTS source_fingerprint text;

UPDATE forge_search_documents
SET source_fingerprint = md5(concat_ws('|',
  project_id, tenant_id, source_type, source_id, coalesce(episode_id,''),
  title, content, coalesce(state,''), coalesce(stage,''), coalesce(provider,''),
  coalesce(artifact_kind,''), occurred_at::text, source_updated_at::text,
  metadata::text
))
WHERE source_fingerprint IS NULL;

ALTER TABLE forge_search_documents
  ALTER COLUMN source_fingerprint SET DEFAULT md5(concat_ws('|',project_id,tenant_id,source_type,source_id));

CREATE INDEX IF NOT EXISTS forge_search_documents_fingerprint_idx
  ON forge_search_documents(project_id, source_type, source_updated_at, source_fingerprint);

CREATE TABLE IF NOT EXISTS forge_search_index_generations (
  generation_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('BUILDING','VERIFYING','ACTIVE','RETIRED','FAILED')),
  schema_version integer NOT NULL,
  source_snapshot_at timestamptz NOT NULL,
  start_event_id bigint NOT NULL DEFAULT 0,
  last_applied_event_id bigint NOT NULL DEFAULT 0,
  checkpoint_type text,
  checkpoint_id text,
  processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
  expected bigint,
  repaired bigint NOT NULL DEFAULT 0 CHECK (repaired >= 0),
  duplicate_events bigint NOT NULL DEFAULT 0 CHECK (duplicate_events >= 0),
  out_of_order_events bigint NOT NULL DEFAULT 0 CHECK (out_of_order_events >= 0),
  gap_events bigint NOT NULL DEFAULT 0 CHECK (gap_events >= 0),
  failure_state text,
  failure_detail text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  verified_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_search_index_generations_scope_idx
  ON forge_search_index_generations(tenant_id, project_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS forge_search_generation_documents (
  generation_id text NOT NULL REFERENCES forge_search_index_generations(generation_id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('project','episode','version','artifact','job','provider_run','approval','qa','publish_run','cost','audit_event','usage','budget')),
  source_id text NOT NULL,
  episode_id text REFERENCES episodes(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  state text,
  stage text,
  provider text,
  artifact_kind text,
  occurred_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  source_fingerprint text NOT NULL,
  search_vector tsvector NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(generation_id, project_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS forge_search_generation_documents_vector_idx
  ON forge_search_generation_documents USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS forge_search_generation_documents_scope_idx
  ON forge_search_generation_documents(generation_id, tenant_id, project_id, source_updated_at DESC, source_type, source_id);
CREATE INDEX IF NOT EXISTS forge_search_generation_documents_episode_idx
  ON forge_search_generation_documents(generation_id, project_id, episode_id, source_type, occurred_at DESC, source_id);

CREATE TABLE IF NOT EXISTS forge_search_index_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
  source_updated_at timestamptz,
  source_fingerprint text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_search_index_events_scope_idx
  ON forge_search_index_events(tenant_id, project_id, event_id);
CREATE INDEX IF NOT EXISTS forge_search_index_events_source_idx
  ON forge_search_index_events(project_id, source_type, source_id, event_id DESC);

CREATE TABLE IF NOT EXISTS forge_search_index_event_applications (
  generation_id text NOT NULL REFERENCES forge_search_index_generations(generation_id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES forge_search_index_events(event_id) ON DELETE CASCADE,
  applied_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','DUPLICATE','OUT_OF_ORDER','IGNORED')),
  PRIMARY KEY(generation_id, event_id)
);
CREATE INDEX IF NOT EXISTS forge_search_index_event_applications_event_idx
  ON forge_search_index_event_applications(event_id, generation_id);

INSERT INTO forge_search_index_generations(
  generation_id, tenant_id, state, schema_version, source_snapshot_at,
  start_event_id, last_applied_event_id, created_by, started_at, verified_at, activated_at
)
SELECT 'legacy-v1', t.id, 'ACTIVE', 2, now(), 0, 0, 'migration', now(), now(), now()
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM forge_search_index_generations g WHERE g.generation_id='legacy-v1' AND g.tenant_id=t.id);

UPDATE forge_search_index_meta
SET schema_version=2,
    active_generation=COALESCE(active_generation,'legacy-v1'),
    generation_epoch=COALESCE(generation_epoch,1),
    updated_at=now();

CREATE OR REPLACE FUNCTION forge_search_document_fingerprint(
  p_project_id text, p_tenant_id text, p_source_type text, p_source_id text,
  p_episode_id text, p_title text, p_content text, p_state text, p_stage text,
  p_provider text, p_artifact_kind text, p_occurred_at timestamptz,
  p_source_updated_at timestamptz, p_metadata jsonb
) RETURNS text AS $$
BEGIN
  RETURN md5(concat_ws('|', p_project_id, p_tenant_id, p_source_type, p_source_id,
    coalesce(p_episode_id,''), left(coalesce(p_title,''),2048), left(coalesce(p_content,''),16000),
    coalesce(p_state,''), coalesce(p_stage,''), coalesce(p_provider,''), coalesce(p_artifact_kind,''),
    coalesce(p_occurred_at,now())::text, coalesce(p_source_updated_at,now())::text,
    coalesce(p_metadata,'{}'::jsonb)::text));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION forge_search_refresh_document(
  p_project_id text,p_tenant_id text,p_source_type text,p_source_id text,p_episode_id text,
  p_title text,p_content text,p_state text,p_stage text,p_provider text,p_artifact_kind text,
  p_occurred_at timestamptz,p_source_updated_at timestamptz,p_metadata jsonb
) RETURNS void AS $$
DECLARE fp text;
BEGIN
  fp := forge_search_document_fingerprint(p_project_id,p_tenant_id,p_source_type,p_source_id,p_episode_id,p_title,p_content,p_state,p_stage,p_provider,p_artifact_kind,p_occurred_at,p_source_updated_at,p_metadata);
  INSERT INTO forge_search_documents(project_id,tenant_id,source_type,source_id,episode_id,title,content,state,stage,provider,artifact_kind,occurred_at,source_updated_at,source_fingerprint,search_vector,metadata,indexed_at)
  VALUES(p_project_id,p_tenant_id,p_source_type,p_source_id,p_episode_id,left(coalesce(p_title,''),2048),left(coalesce(p_content,''),16000),p_state,p_stage,p_provider,p_artifact_kind,coalesce(p_occurred_at,now()),coalesce(p_source_updated_at,now()),fp,setweight(to_tsvector('simple',left(coalesce(p_title,''),2048)),'A')||setweight(to_tsvector('simple',left(coalesce(p_content,''),16000)),'B')||setweight(to_tsvector('simple',coalesce(p_source_type,'')||' '||coalesce(p_source_id,'')),'C'),coalesce(p_metadata,'{}'::jsonb),now())
  ON CONFLICT(project_id,source_type,source_id) DO UPDATE SET
    tenant_id=EXCLUDED.tenant_id,episode_id=EXCLUDED.episode_id,title=EXCLUDED.title,content=EXCLUDED.content,
    state=EXCLUDED.state,stage=EXCLUDED.stage,provider=EXCLUDED.provider,artifact_kind=EXCLUDED.artifact_kind,
    occurred_at=EXCLUDED.occurred_at,source_updated_at=EXCLUDED.source_updated_at,source_fingerprint=EXCLUDED.source_fingerprint,
    search_vector=EXCLUDED.search_vector,metadata=EXCLUDED.metadata,indexed_at=now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forge_search_record_index_event(
  p_operation text, p_project_id text, p_tenant_id text, p_source_type text, p_source_id text,
  p_source_updated_at timestamptz, p_source_fingerprint text, p_payload jsonb
) RETURNS bigint AS $$
DECLARE event_id_value bigint;
DECLARE event_key_value text;
BEGIN
  event_key_value := md5(concat_ws('|',p_operation,p_project_id,p_tenant_id,p_source_type,p_source_id,coalesce(p_source_updated_at,'')::text,coalesce(p_source_fingerprint,'')));
  INSERT INTO forge_search_index_events(event_key,tenant_id,project_id,source_type,source_id,operation,source_updated_at,source_fingerprint,payload)
  VALUES(event_key_value,p_tenant_id,p_project_id,p_source_type,p_source_id,p_operation,p_source_updated_at,p_source_fingerprint,coalesce(p_payload,'{}'::jsonb))
  ON CONFLICT(event_key) DO NOTHING
  RETURNING event_id INTO event_id_value;
  IF event_id_value IS NULL THEN SELECT event_id INTO event_id_value FROM forge_search_index_events WHERE event_key=event_key_value; END IF;
  RETURN event_id_value;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forge_search_consistency_after_trigger() RETURNS trigger AS $$
DECLARE d forge_search_documents%ROWTYPE;
BEGIN
  SELECT * INTO d FROM forge_search_documents
  WHERE project_id = COALESCE(NULLIF((CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'project_id',''), forge_search_source_project_id(CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END, NULLIF((CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'episode_id','')))
    AND source_type = TG_ARGV[0]
    AND source_id = (CASE WHEN TG_OP='DELETE' THEN OLD.id::text ELSE NEW.id::text END)
  LIMIT 1;
  IF d.project_id IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  PERFORM forge_search_record_index_event('UPSERT',d.project_id,d.tenant_id,d.source_type,d.source_id,d.source_updated_at,d.source_fingerprint,to_jsonb(d));
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forge_search_consistency_delete_trigger() RETURNS trigger AS $$
DECLARE r jsonb := to_jsonb(OLD); project_value text; tenant_value text; source_id_value text;
BEGIN
  source_id_value := NULLIF(r->>'id','');
  project_value := NULLIF(r->>'project_id','');
  IF project_value IS NULL THEN project_value := forge_search_source_project_id(r,NULLIF(r->>'episode_id','')); END IF;
  IF project_value IS NULL AND TG_ARGV[0]='project' THEN project_value := source_id_value; END IF;
  IF project_value IS NULL THEN RETURN OLD; END IF;
  tenant_value := forge_search_source_tenant_id(project_value);
  IF tenant_value IS NOT NULL THEN
    PERFORM forge_search_record_index_event('DELETE',project_value,tenant_value,TG_ARGV[0],source_id_value,COALESCE(NULLIF(r->>'updated_at','')::timestamptz,NULLIF(r->>'created_at','')::timestamptz,now()),NULL,'{}'::jsonb);
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('projects','project'),('episodes','episode'),('version_records','version'),('artifacts','artifact'),
    ('forge_jobs','job'),('provider_runs','provider_run'),('approvals','approval'),('qa_results','qa'),
    ('publish_runs','publish_run'),('cost_records','cost'),('audit_events','audit_event'),('usage_events','usage'),('usage_budgets','budget')
  ) AS x(table_name,source_type) LOOP
    IF to_regclass(t.table_name) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS aa_search_consistency_delete ON %s',t.table_name);
      EXECUTE format('CREATE TRIGGER aa_search_consistency_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION forge_search_consistency_delete_trigger(%L)',t.table_name,t.source_type);
      EXECUTE format('DROP TRIGGER IF EXISTS zz_search_consistency_after ON %s',t.table_name);
      EXECUTE format('CREATE TRIGGER zz_search_consistency_after AFTER INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION forge_search_consistency_after_trigger(%L)',t.table_name,t.source_type);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION forge_search_consistency_invariant() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.project_id IS NULL OR NEW.source_id IS NULL THEN RAISE EXCEPTION 'search index scope invariant violated'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_search_documents_scope_invariant ON forge_search_documents;
CREATE TRIGGER forge_search_documents_scope_invariant BEFORE INSERT OR UPDATE ON forge_search_documents
FOR EACH ROW EXECUTE FUNCTION forge_search_consistency_invariant();

COMMIT;
