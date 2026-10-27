BEGIN;
ALTER TABLE forge_execution_plan_stages ADD COLUMN IF NOT EXISTS runner_manifest jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE FUNCTION forge_snapshot_stage_runner_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_manifest jsonb;
BEGIN
  SELECT COALESCE((SELECT s->'runnerManifest' FROM forge_execution_plans p, jsonb_array_elements(p.snapshot->'definition'->'stages') s WHERE p.id=NEW.plan_id AND s->>'id'=NEW.stage_id LIMIT 1),'{}'::jsonb) INTO v_manifest;
  NEW.runner_manifest:=v_manifest;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_snapshot_stage_runner_manifest ON forge_execution_plan_stages;
CREATE TRIGGER forge_snapshot_stage_runner_manifest BEFORE INSERT ON forge_execution_plan_stages FOR EACH ROW EXECUTE FUNCTION forge_snapshot_stage_runner_manifest();
CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  plan_id text NOT NULL REFERENCES forge_execution_plans(id) ON DELETE CASCADE,
  plan_stage_id text NOT NULL REFERENCES forge_execution_plan_stages(id) ON DELETE CASCADE,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  stage text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('APPROVED','CHANGES_REQUESTED','REJECTED')),
  target_version_id text NOT NULL,
  actor text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_stage_id,decision)
);
CREATE INDEX IF NOT EXISTS approvals_episode_stage_idx ON approvals(tenant_id,episode_id,stage,created_at DESC);
CREATE OR REPLACE FUNCTION forge_apply_execution_plan_job_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_plan_id text; v_stage_id text; v_stage_manifest jsonb;
BEGIN
  v_plan_id:=NEW.payload->>'executionPlanId'; v_stage_id:=NEW.payload->>'planStageId';
  IF v_plan_id IS NULL OR v_stage_id IS NULL THEN RETURN NEW; END IF;
  SELECT eps.runner_manifest INTO v_stage_manifest FROM forge_execution_plan_stages eps WHERE eps.plan_id=v_plan_id AND eps.id=v_stage_id;
  NEW.execution_plan_id:=v_plan_id; NEW.plan_stage_id:=v_stage_id; NEW.template_version_id:=NULLIF(NEW.payload->>'templateVersionId','');
  IF v_stage_manifest IS NOT NULL AND v_stage_manifest<>'{}'::jsonb THEN NEW.payload:=jsonb_set(NEW.payload,'{publicRunner}',v_stage_manifest,true); END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_execution_plan_job_metadata ON forge_jobs;
CREATE TRIGGER forge_execution_plan_job_metadata BEFORE INSERT OR UPDATE OF payload ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_apply_execution_plan_job_metadata();
COMMIT;