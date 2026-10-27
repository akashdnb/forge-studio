BEGIN;

CREATE OR REPLACE FUNCTION forge_artifact_event_trigger() RETURNS trigger AS $$
DECLARE project_id text; tenant_id text;
BEGIN
  SELECT e.project_id INTO project_id FROM episodes e WHERE e.id=NEW.episode_id;
  IF project_id IS NULL THEN RETURN NEW; END IF;
  SELECT p.tenant_id INTO tenant_id FROM projects p WHERE p.id=project_id;
  PERFORM forge_capture_event('artifact.created',project_id,NEW.episode_id,'artifact',NEW.id,jsonb_build_object('artifactId',NEW.id,'episodeId',NEW.episode_id,'kind',NEW.kind,'versionId',NEW.version_id,'contentHash',NEW.content_hash),NEW.provider_run_id,NULL,NULL,NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_artifact_event_capture ON artifacts;
CREATE TRIGGER forge_artifact_event_capture AFTER INSERT ON artifacts FOR EACH ROW EXECUTE FUNCTION forge_artifact_event_trigger();

CREATE OR REPLACE FUNCTION forge_incident_event_trigger() RETURNS trigger AS $$
BEGIN
  PERFORM forge_capture_event('incident.state.changed',NEW.project_id,(
    SELECT e.id FROM episodes e WHERE e.project_id=NEW.project_id ORDER BY e.updated_at DESC LIMIT 1
  ),'incident',NEW.id,jsonb_build_object('incidentId',NEW.id,'tenantId',NEW.tenant_id,'status',NEW.status,'severity',NEW.severity,'ruleKey',NEW.rule_key,'sourceType',NEW.source_type,'sourceId',NEW.source_id),NULL,NULL,NULL,NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_incident_event_capture ON operational_incidents;
CREATE TRIGGER forge_incident_event_capture AFTER INSERT OR UPDATE OF status,severity,owner_id,resolved_at ON operational_incidents FOR EACH ROW EXECUTE FUNCTION forge_incident_event_trigger();

CREATE OR REPLACE FUNCTION forge_execution_plan_event_trigger() RETURNS trigger AS $$
BEGIN
  PERFORM forge_capture_event('workflow.plan.state.changed',NEW.project_id,NEW.episode_id,'execution_plan',NEW.id,jsonb_build_object('planId',NEW.id,'episodeId',NEW.episode_id,'templateVersionId',NEW.template_version_id,'status',NEW.status,'releaseEpoch',NEW.release_epoch),NULL,NEW.template_version_id,NULL,NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_execution_plan_event_capture ON forge_execution_plans;
CREATE TRIGGER forge_execution_plan_event_capture AFTER INSERT OR UPDATE OF status ON forge_execution_plans FOR EACH ROW EXECUTE FUNCTION forge_execution_plan_event_trigger();

CREATE OR REPLACE FUNCTION forge_version_event_trigger() RETURNS trigger AS $$
BEGIN
  PERFORM forge_capture_event('version.created',(
    SELECT project_id FROM episodes WHERE id=NEW.episode_id
  ),NEW.episode_id,'version',NEW.id,jsonb_build_object('versionId',NEW.id,'episodeId',NEW.episode_id,'kind',NEW.kind,'parentId',NEW.parent_id,'contentHash',NEW.content_hash));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_version_event_capture ON version_records;
CREATE TRIGGER forge_version_event_capture AFTER INSERT ON version_records FOR EACH ROW EXECUTE FUNCTION forge_version_event_trigger();

COMMIT;
