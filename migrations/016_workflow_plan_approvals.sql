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
COMMIT;