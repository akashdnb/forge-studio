BEGIN;

CREATE OR REPLACE FUNCTION forge_rights_collect_artifacts(p_episode_id text,p_root_artifact_id text)
RETURNS TABLE(artifact_id text,version_id text,is_root boolean) LANGUAGE sql STABLE AS $$
WITH RECURSIVE version_closure(id) AS (
  SELECT a.version_id FROM artifacts a WHERE a.id=p_root_artifact_id AND a.episode_id=p_episode_id
  UNION
  SELECT vd.depends_on_version_id FROM version_dependencies vd JOIN version_closure vc ON vc.id=vd.version_id WHERE vd.episode_id=p_episode_id
), artifact_seed(id) AS (
  SELECT a.id FROM artifacts a WHERE a.episode_id=p_episode_id AND a.version_id IN (SELECT id FROM version_closure)
  UNION
  SELECT p_root_artifact_id
), artifact_closure(id) AS (
  SELECT id FROM artifact_seed
  UNION
  SELECT md.source_artifact_id FROM media_derivatives md JOIN artifact_closure ac ON ac.id=md.artifact_id
  UNION
  SELECT a2.id
  FROM artifacts a2
  JOIN artifact_closure ac ON a2.episode_id=p_episode_id
  JOIN artifacts parent_artifact ON parent_artifact.id=ac.id
  WHERE a2.input_version_ids ? parent_artifact.version_id
), dedup AS (
  SELECT a.id,a.version_id FROM artifacts a JOIN artifact_closure ac ON ac.id=a.id WHERE a.episode_id=p_episode_id
)
SELECT d.id,d.version_id,(d.id=p_root_artifact_id) FROM dedup d;
$$;

COMMIT;
