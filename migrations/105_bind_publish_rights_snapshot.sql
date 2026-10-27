BEGIN;

CREATE OR REPLACE FUNCTION forge_rights_require_publish_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  IF NEW.rights_snapshot_id IS NULL THEN
    SELECT rs.* INTO s
    FROM forge_rights_snapshots rs
    WHERE rs.execution_type='PUBLISH'
      AND rs.tenant_id=NEW.tenant_id
      AND rs.project_id=NEW.project_id
      AND rs.episode_id=NEW.episode_id
      AND rs.destination=NEW.destination
      AND rs.package_artifact_id=NEW.package_artifact_id
      AND rs.package_version_id=NEW.package_version_id
      AND rs.render_artifact_id=NEW.render_artifact_id
      AND rs.render_version_id=NEW.render_version_id
      AND rs.decision IN ('ALLOW','OVERRIDE')
    ORDER BY rs.observed_at DESC
    LIMIT 1;
    IF s.id IS NOT NULL THEN NEW.rights_snapshot_id:=s.id; END IF;
  ELSE
    SELECT * INTO s FROM forge_rights_snapshots WHERE id=NEW.rights_snapshot_id;
  END IF;
  IF s.id IS NULL OR s.execution_type<>'PUBLISH' OR s.decision NOT IN ('ALLOW','OVERRIDE') OR s.tenant_id<>NEW.tenant_id OR s.project_id<>NEW.project_id OR s.episode_id<>NEW.episode_id THEN
    RAISE EXCEPTION 'rights compliance: publish request requires a matching rights snapshot' USING ERRCODE='P0001',DETAIL='RIGHTS_SNAPSHOT_REQUIRED';
  END IF;
  RETURN NEW;
END; $$;

COMMIT;
