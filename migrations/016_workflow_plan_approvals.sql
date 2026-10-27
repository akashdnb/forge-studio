BEGIN;
ALTER TABLE forge_execution_plan_stages ADD COLUMN IF NOT EXISTS runner_manifest jsonb NOT NULL DEFAULT '{}'::jsonb;
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
DECLARE plan_id text; stage_id text; stage_manifest jsonb;
BEGIN
  plan_id:=NEW.payload->>'executionPlanId'; stage_id:=NEW.payload->>'planStageId';
  IF plan_id IS NULL OR stage_id IS NULL THEN RETURN NEW; END IF;
  SELECT runner_manifest INTO stage_manifest FROM forge_execution_plan_stages WHERE plan_id=plan_id AND id=stage_id;
  NEW.execution_plan_id:=plan_id; NEW.plan_stage_id:=stage_id; NEW.template_version_id:=NULLIF(NEW.payload->>'templateVersionId','');
  IF stage_manifest IS NOT NULL AND stage_manifest<>'{}'::jsonb THEN NEW.payload:=jsonb_set(NEW.payload,'{publicRunner}',stage_manifest,true); END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_execution_plan_job_metadata ON forge_jobs;
CREATE TRIGGER forge_execution_plan_job_metadata BEFORE INSERT OR UPDATE OF payload ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_apply_execution_plan_job_metadata();
COMMIT;