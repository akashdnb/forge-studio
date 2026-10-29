BEGIN;

CREATE OR REPLACE FUNCTION forge_rights_json_strings(input jsonb)
RETURNS TABLE(value text) LANGUAGE sql IMMUTABLE AS $$
WITH RECURSIVE walk(v) AS (
  SELECT input
  UNION ALL
  SELECT child.value
  FROM walk w
  CROSS JOIN LATERAL (
    SELECT a.value
    FROM jsonb_array_elements(w.v) a(value)
    WHERE jsonb_typeof(w.v)='array'
    UNION ALL
    SELECT o.value
    FROM jsonb_each(w.v) o(key,value)
    WHERE jsonb_typeof(w.v)='object'
  ) child
)
SELECT v #>> '{}' FROM walk WHERE jsonb_typeof(v)='string';
$$;

CREATE OR REPLACE FUNCTION forge_rights_collect_artifacts(p_episode_id text,p_root_artifact_id text)
RETURNS TABLE(artifact_id text,version_id text,is_root boolean) LANGUAGE sql STABLE AS $$
WITH RECURSIVE version_closure(id) AS (
  SELECT a.version_id FROM artifacts a WHERE a.id=p_root_artifact_id AND a.episode_id=p_episode_id
  UNION
  SELECT vd.depends_on_version_id FROM version_dependencies vd JOIN version_closure vc ON vc.id=vd.version_id WHERE vd.episode_id=p_episode_id
), artifact_seed(id) AS (
  SELECT a.id FROM artifacts a WHERE a.episode_id=p_episode_id AND a.version_id IN (SELECT id FROM version_closure)
  UNION SELECT p_root_artifact_id
  UNION
  SELECT a.id FROM artifacts a JOIN version_records v ON v.id=a.version_id AND v.episode_id=p_episode_id AND v.id IN (SELECT id FROM version_closure) CROSS JOIN LATERAL forge_rights_json_strings(v.payload) s WHERE s.value=a.id
), artifact_closure(id) AS (
  SELECT id FROM artifact_seed
  UNION
  SELECT edge.source_id
  FROM (
    SELECT md.source_artifact_id AS source_id, md.artifact_id AS parent_id
    FROM media_derivatives md
    UNION ALL
    SELECT source_artifact.id AS source_id, parent_artifact.id AS parent_id
    FROM artifacts parent_artifact
    CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(parent_artifact.input_version_ids)='array' THEN parent_artifact.input_version_ids ELSE '[]'::jsonb END) input_version(id)
    JOIN artifacts source_artifact ON source_artifact.episode_id=p_episode_id AND source_artifact.version_id=input_version.id
  ) edge
  JOIN artifact_closure ac ON ac.id=edge.parent_id
), dedup AS (
  SELECT a.id,a.version_id FROM artifacts a JOIN artifact_closure ac ON ac.id=a.id WHERE a.episode_id=p_episode_id
)
SELECT d.id,d.version_id,(d.id=p_root_artifact_id) FROM dedup d;
$$;

COMMIT;
