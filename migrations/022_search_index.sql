BEGIN;

-- Production search index v1. The index is deliberately a bounded denormalized read model;
-- source tables remain authoritative and triggers keep this read model transactionally aligned.
CREATE TABLE IF NOT EXISTS forge_search_index_meta (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  state text NOT NULL CHECK (state IN ('READY','REBUILDING','DEGRADED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_reconciled_at timestamptz,
  last_reconcile_drift integer NOT NULL DEFAULT 0
);
INSERT INTO forge_search_index_meta(singleton,schema_version,state)
VALUES(true,1,'READY') ON CONFLICT(singleton) DO UPDATE SET schema_version=1;

CREATE TABLE IF NOT EXISTS forge_search_documents (
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
  search_vector tsvector NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS forge_search_documents_tenant_vector_idx ON forge_search_documents USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS forge_search_documents_tenant_order_idx ON forge_search_documents(tenant_id, project_id, source_updated_at DESC, source_type, source_id);
CREATE INDEX IF NOT EXISTS forge_search_documents_project_filter_idx ON forge_search_documents(project_id, source_type, state, stage, provider, occurred_at DESC, source_id);
CREATE INDEX IF NOT EXISTS forge_search_documents_episode_idx ON forge_search_documents(project_id, episode_id, source_type, occurred_at DESC, source_id);
CREATE INDEX IF NOT EXISTS forge_search_documents_artifact_idx ON forge_search_documents(project_id, artifact_kind, source_type, source_updated_at DESC, source_id) WHERE source_type = 'artifact';
CREATE INDEX IF NOT EXISTS forge_search_documents_job_incident_idx ON forge_search_documents(project_id, state, stage, provider, occurred_at DESC, source_id) WHERE source_type = 'job';

CREATE TABLE IF NOT EXISTS forge_search_rebuilds (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  schema_version integer NOT NULL,
  cursor_type text,
  cursor_id text,
  processed bigint NOT NULL DEFAULT 0 CHECK (processed >= 0),
  inserted bigint NOT NULL DEFAULT 0 CHECK (inserted >= 0),
  deleted bigint NOT NULL DEFAULT 0 CHECK (deleted >= 0),
  drift_found bigint NOT NULL DEFAULT 0 CHECK (drift_found >= 0),
  last_error text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_search_rebuilds_scope_idx ON forge_search_rebuilds(tenant_id, project_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS forge_search_query_stats (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  query_hash char(64) NOT NULL,
  result_count integer NOT NULL,
  duration_ms integer NOT NULL,
  timed_out boolean NOT NULL DEFAULT false,
  cancelled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_search_query_stats_tenant_idx ON forge_search_query_stats(tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION forge_search_refresh_document(p_project_id text,p_tenant_id text,p_source_type text,p_source_id text,p_episode_id text,p_title text,p_content text,p_state text,p_stage text,p_provider text,p_artifact_kind text,p_occurred_at timestamptz,p_source_updated_at timestamptz,p_metadata jsonb) RETURNS void AS $$
BEGIN
  INSERT INTO forge_search_documents(project_id,tenant_id,source_type,source_id,episode_id,title,content,state,stage,provider,artifact_kind,occurred_at,source_updated_at,search_vector,metadata,indexed_at)
  VALUES(p_project_id,p_tenant_id,p_source_type,p_source_id,p_episode_id,left(coalesce(p_title,''),2048),left(coalesce(p_content,''),16000),p_state,p_stage,p_provider,p_artifact_kind,coalesce(p_occurred_at,now()),coalesce(p_source_updated_at,now()),setweight(to_tsvector('simple',left(coalesce(p_title,''),2048)),'A')||setweight(to_tsvector('simple',left(coalesce(p_content,''),16000)),'B')||setweight(to_tsvector('simple',coalesce(p_source_type,'')||' '||coalesce(p_source_id,'')),'C'),coalesce(p_metadata,'{}'::jsonb),now())
  ON CONFLICT(project_id,source_type,source_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,episode_id=EXCLUDED.episode_id,title=EXCLUDED.title,content=EXCLUDED.content,state=EXCLUDED.state,stage=EXCLUDED.stage,provider=EXCLUDED.provider,artifact_kind=EXCLUDED.artifact_kind,occurred_at=EXCLUDED.occurred_at,source_updated_at=EXCLUDED.source_updated_at,search_vector=EXCLUDED.search_vector,metadata=EXCLUDED.metadata,indexed_at=now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forge_search_source_project_id(p_row jsonb,p_episode_id text) RETURNS text AS $$
DECLARE result text;
BEGIN
  result:=NULLIF(p_row->>'project_id','');
  IF result IS NULL AND p_episode_id IS NOT NULL THEN SELECT project_id INTO result FROM episodes WHERE id=p_episode_id; END IF;
  IF result IS NULL AND p_row ? 'package_id' THEN SELECT e.project_id INTO result FROM research_packages rp JOIN episodes e ON e.id=rp.episode_id WHERE rp.id=p_row->>'package_id'; END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION forge_search_source_tenant_id(p_project_id text) RETURNS text AS $$
DECLARE result text;
BEGIN SELECT tenant_id INTO result FROM projects WHERE id=p_project_id; RETURN result; END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION forge_search_index_trigger() RETURNS trigger AS $$
DECLARE
  r jsonb := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  project_id_value text;
  tenant_id_value text;
  episode_id_value text := NULLIF(r->>'episode_id','');
  source_id_value text := NULLIF(r->>'id','');
  source_type_value text := TG_ARGV[0];
  title_value text := '';
  content_value text := '';
  state_value text := NULLIF(r->>'state','');
  stage_value text := NULLIF(r->>'stage','');
  provider_value text := NULLIF(r->>'provider','');
  artifact_kind_value text := NULLIF(r->>'kind','');
  occurred_at_value timestamptz := COALESCE(NULLIF(r->>'created_at','')::timestamptz,now());
  updated_at_value timestamptz := COALESCE(NULLIF(r->>'updated_at','')::timestamptz,occurred_at_value);
  metadata_value jsonb := '{}'::jsonb;
BEGIN
  IF source_id_value IS NULL THEN source_id_value:=md5(r::text); END IF;
  IF TG_OP='DELETE' THEN
    DELETE FROM forge_search_documents WHERE source_type=source_type_value AND source_id=source_id_value;
    RETURN OLD;
  END IF;
  IF source_type_value='project' THEN
    project_id_value:=NEW.id::text; title_value:=coalesce(r->>'name',''); content_value:=left(coalesce(r->'metadata','{}'::jsonb)::text,16000); metadata_value:=coalesce(r->'metadata','{}'::jsonb);
  ELSE
    project_id_value:=forge_search_source_project_id(r,episode_id_value);
    IF source_type_value='episode' THEN title_value:=coalesce(r->>'title',''); content_value:=coalesce(r->>'description','')||' '||coalesce(r->>'state',''); metadata_value:=coalesce(r->'metadata','{}'::jsonb);
    ELSIF source_type_value='version' THEN title_value:=coalesce(r->>'kind','')||' '||coalesce(r->>'id',''); content_value:=left(coalesce(r->'payload','{}'::jsonb)::text,16000); metadata_value:=coalesce(r->'payload','{}'::jsonb);
    ELSIF source_type_value='artifact' THEN title_value:=coalesce(r->>'kind','')||' '||coalesce(r->>'media_type',''); content_value:=coalesce(r->>'content_hash','')||' '||coalesce(r->>'source',''); metadata_value:=coalesce(r->'metadata','{}'::jsonb);
    ELSIF source_type_value='job' THEN title_value:=coalesce(r->>'kind','')||' '||coalesce(r->>'status',''); content_value:=coalesce(r->>'worker_id','')||' '||left(coalesce(r->'error','{}'::jsonb)::text,6000)||' '||left(coalesce(r->'result','{}'::jsonb)::text,6000); metadata_value:=jsonb_build_object('priority',r->>'priority','attempts',r->>'attempts','maxAttempts',r->>'max_attempts');
    ELSIF source_type_value='provider_run' THEN title_value:=coalesce(r->>'capability','')||' '||coalesce(r->>'provider','')||' '||coalesce(r->>'model',''); content_value:=coalesce(r->>'external_job_id','')||' '||left(coalesce(r->'error','{}'::jsonb)::text,6000); metadata_value:=jsonb_build_object('attempt',r->>'attempt','idempotencyKey',r->>'idempotency_key');
    ELSIF source_type_value='approval' THEN title_value:=coalesce(r->>'stage','')||' '||coalesce(r->>'decision',''); content_value:=coalesce(r->>'actor','')||' '||left(coalesce(r->>'comments',''),6000); metadata_value:=coalesce(r->'evidence','{}'::jsonb);
    ELSIF source_type_value='qa' THEN title_value:=coalesce(r->>'status','')||' '||coalesce(r->>'runner',''); content_value:=left(coalesce(r->'checks','[]'::jsonb)::text,12000); metadata_value:=coalesce(r->'metadata','{}'::jsonb);
    ELSIF source_type_value='publish_run' THEN title_value:=coalesce(r->>'destination','')||' '||coalesce(r->>'status',''); content_value:=coalesce(r->>'external_id','')||' '||coalesce(r->>'external_url',''); metadata_value:=coalesce(r->'metadata','{}'::jsonb);
    ELSIF source_type_value='cost' THEN title_value:=coalesce(r->>'provider','')||' '||coalesce(r->>'operation',''); content_value:=coalesce(r->>'model','')||' '||coalesce(r->>'currency',''); metadata_value:=coalesce(r->'metadata','{}'::jsonb);
    ELSIF source_type_value='audit_event' THEN title_value:=coalesce(r->>'action','')||' '||coalesce(r->>'target_type',''); content_value:=coalesce(r->>'actor','')||' '||coalesce(r->>'target_id',''); metadata_value:=coalesce(r->'details','{}'::jsonb);
    ELSE title_value:=coalesce(r->>'id',''); content_value:=left(r::text,12000); END IF;
  END IF;
  IF project_id_value IS NULL THEN RETURN NEW; END IF;
  tenant_id_value:=forge_search_source_tenant_id(project_id_value);
  IF tenant_id_value IS NULL THEN RETURN NEW; END IF;
  PERFORM forge_search_refresh_document(project_id_value,tenant_id_value,source_type_value,source_id_value,episode_id_value,title_value,content_value,state_value,stage_value,provider_value,artifact_kind_value,occurred_at_value,updated_at_value,metadata_value);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forge_search_install_trigger(p_table text,p_type text) RETURNS void AS $$
BEGIN
  IF to_regclass(p_table) IS NOT NULL THEN
    EXECUTE format('DROP TRIGGER IF EXISTS forge_search_%s ON %s',p_type,p_table);
    EXECUTE format('CREATE TRIGGER forge_search_%s AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION forge_search_index_trigger(%L)',p_type,p_table,p_type);
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT forge_search_install_trigger('projects','project');
SELECT forge_search_install_trigger('episodes','episode');
SELECT forge_search_install_trigger('version_records','version');
SELECT forge_search_install_trigger('artifacts','artifact');
SELECT forge_search_install_trigger('forge_jobs','job');
SELECT forge_search_install_trigger('provider_runs','provider_run');
SELECT forge_search_install_trigger('approvals','approval');
SELECT forge_search_install_trigger('qa_results','qa');
SELECT forge_search_install_trigger('publish_runs','publish_run');
SELECT forge_search_install_trigger('cost_records','cost');
SELECT forge_search_install_trigger('audit_events','audit_event');
SELECT forge_search_install_trigger('usage_events','usage');
SELECT forge_search_install_trigger('usage_budgets','budget');
DROP FUNCTION forge_search_install_trigger(text,text);

COMMIT;
