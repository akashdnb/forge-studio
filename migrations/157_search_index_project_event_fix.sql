BEGIN;

CREATE OR REPLACE FUNCTION forge_search_consistency_after_trigger() RETURNS trigger AS $$
DECLARE d forge_search_documents%ROWTYPE;
DECLARE scope_project text;
BEGIN
  scope_project := CASE WHEN TG_ARGV[0]='project' THEN (CASE WHEN TG_OP='DELETE' THEN OLD.id::text ELSE NEW.id::text END)
    ELSE forge_search_source_project_id(CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
      NULLIF((CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)->>'episode_id','')) END;
  IF scope_project IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  SELECT * INTO d FROM forge_search_documents
  WHERE project_id=scope_project
    AND source_type=TG_ARGV[0]
    AND source_id=(CASE WHEN TG_OP='DELETE' THEN OLD.id::text ELSE NEW.id::text END)
  LIMIT 1;
  IF d.project_id IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  PERFORM forge_search_record_index_event('UPSERT',d.project_id,d.tenant_id,d.source_type,d.source_id,d.source_updated_at,d.source_fingerprint,to_jsonb(d));
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

COMMIT;
