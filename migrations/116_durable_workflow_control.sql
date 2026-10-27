BEGIN;

CREATE TABLE IF NOT EXISTS forge_workflow_controls (
  plan_id text PRIMARY KEY REFERENCES forge_execution_plans(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  template_version_id text NOT NULL,
  state text NOT NULL DEFAULT 'RUNNABLE' CHECK (state IN ('RUNNABLE','PAUSING','PAUSED','RESUMING','CANCELLED','COMPLETED','FAILED','INTERVENTION')),
  execution_epoch bigint NOT NULL DEFAULT 1 CHECK (execution_epoch > 0),
  fence_token uuid NOT NULL,
  control_version bigint NOT NULL DEFAULT 1 CHECK (control_version > 0),
  active_checkpoint_id text,
  active_intervention_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id, execution_epoch),
  UNIQUE(tenant_id, fence_token)
);
CREATE INDEX IF NOT EXISTS forge_workflow_controls_tenant_state_idx ON forge_workflow_controls(tenant_id,state,updated_at DESC);

CREATE TABLE IF NOT EXISTS forge_workflow_checkpoints (
  id text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES forge_execution_plans(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  template_version_id text NOT NULL,
  execution_epoch bigint NOT NULL,
  checkpoint_version bigint NOT NULL CHECK (checkpoint_version > 0),
  stage_id text,
  runtime_stage text,
  safe_state jsonb NOT NULL,
  reentry_contract jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  state_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id, checkpoint_version),
  UNIQUE(plan_id, execution_epoch, stage_id)
);
CREATE INDEX IF NOT EXISTS forge_workflow_checkpoints_tenant_plan_idx ON forge_workflow_checkpoints(tenant_id,plan_id,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_workflow_control_events (
  id bigserial PRIMARY KEY,
  plan_id text NOT NULL REFERENCES forge_execution_plans(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  execution_epoch bigint NOT NULL,
  control_version bigint NOT NULL,
  event_type text NOT NULL,
  actor text NOT NULL,
  idempotency_key text NOT NULL,
  checkpoint_id text,
  intervention_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS forge_workflow_control_events_plan_idx ON forge_workflow_control_events(tenant_id,plan_id,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_workflow_interventions (
  id text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES forge_execution_plans(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  execution_epoch bigint NOT NULL,
  checkpoint_id text NOT NULL REFERENCES forge_workflow_checkpoints(id) ON DELETE RESTRICT,
  stage_id text,
  kind text NOT NULL CHECK (kind IN ('MANUAL','APPROVAL','RETRY','SKIP')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED','APPLIED','CANCELLED')),
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_workflow_interventions_tenant_idx ON forge_workflow_interventions(tenant_id,plan_id,status,created_at DESC);

ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS workflow_execution_epoch bigint;
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS workflow_fence_token uuid;
ALTER TABLE forge_execution_runs ADD COLUMN IF NOT EXISTS workflow_execution_epoch bigint;
ALTER TABLE forge_execution_runs ADD COLUMN IF NOT EXISTS workflow_fence_token uuid;
CREATE INDEX IF NOT EXISTS forge_jobs_workflow_fence_idx ON forge_jobs((payload->>'executionPlanId'),workflow_execution_epoch,status);
CREATE INDEX IF NOT EXISTS forge_execution_runs_workflow_fence_idx ON forge_execution_runs(workflow_execution_epoch,workflow_fence_token,status);

COMMIT;
