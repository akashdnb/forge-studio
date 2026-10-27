BEGIN;

CREATE OR REPLACE FUNCTION forge_capture_event(
  p_type text,
  p_project_id text,
  p_episode_id text,
  p_aggregate_type text,
  p_aggregate_id text,
  p_payload jsonb
) RETURNS text AS $$
BEGIN
  RETURN forge_capture_event(p_type,p_project_id,p_episode_id,p_aggregate_type,p_aggregate_id,p_payload,NULL,NULL,NULL,NULL);
END;
$$ LANGUAGE plpgsql;

COMMIT;
