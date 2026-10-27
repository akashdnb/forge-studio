BEGIN;
CREATE OR REPLACE FUNCTION forge_rights_auto_generated_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant text; project text; rid text; vid text; payload jsonb; hash char(64);
BEGIN
  IF NEW.source <> 'forge' OR NEW.kind NOT IN ('render','narration','thumbnail') THEN RETURN NEW; END IF;
  SELECT e.project_id,p.tenant_id INTO project,tenant FROM episodes e JOIN projects p ON p.id=e.project_id WHERE e.id=NEW.episode_id;
  IF project IS NULL OR tenant IS NULL THEN RETURN NEW; END IF;
  rid := 'rights:auto:'||NEW.id; vid := rid||':v1';
  payload := jsonb_build_object('owner','tenant:'||tenant,'licenseType','tenant-owned','permittedUses',jsonb_build_array('package','publish','export','replay'),'attribution',jsonb_build_object(),'territories',jsonb_build_array('global'),'destinations',jsonb_build_array('all'),'timezone','UTC','derivativeAllowed',true,'evidenceRefs',jsonb_build_array(jsonb_build_object('type','AUTO_GENERATED','artifactId',NEW.id)),'providerMetadata',jsonb_build_object('source','forge'));
  hash := encode(digest(payload::text,'sha256'),'hex');
  INSERT INTO forge_rights_records(id,tenant_id,project_id,target_type,target_id,current_version_no,review_state,created_by) VALUES(rid,tenant,project,'ARTIFACT',NEW.id,1,'APPROVED','system') ON CONFLICT(project_id,target_type,target_id) DO NOTHING;
  INSERT INTO forge_rights_versions(id,rights_record_id,version_no,owner,license_type,permitted_uses,attribution,territories,destinations,timezone,derivative_allowed,evidence_refs,provider_metadata,canonical_hash,created_by)
  SELECT vid,rid,1,payload->>'owner',payload->>'licenseType',payload->'permittedUses',payload->'attribution',payload->'territories',payload->'destinations','UTC',true,payload->'evidenceRefs',payload->'providerMetadata',hash,'system'
  WHERE NOT EXISTS(SELECT 1 FROM forge_rights_versions WHERE rights_record_id=rid);
  INSERT INTO forge_rights_actions(id,tenant_id,project_id,rights_record_id,rights_version_id,action,actor,evidence) VALUES('rights-action:auto:'||NEW.id,tenant,project,rid,vid,'CREATE','system',jsonb_build_object('reason','forge-owned-generated-media')) ON CONFLICT(id) DO NOTHING;
  RETURN NEW;
END; $$;
COMMIT;
