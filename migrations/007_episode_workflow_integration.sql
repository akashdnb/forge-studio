BEGIN;

CREATE TABLE IF NOT EXISTS episode_workflows (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  brief text NOT NULL,
  requested_stages jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  current_stage text,
  last_safe_stage text,
  failure_stage text,
  failure jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS episode_workflows_episode_idx ON episode_workflows(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS episode_workflows_status_idx ON episode_workflows(status, updated_at);

CREATE TABLE IF NOT EXISTS episode_workflow_stages (
  workflow_id text NOT NULL REFERENCES episode_workflows(id) ON DELETE CASCADE,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'BLOCKED' CHECK (status IN ('BLOCKED','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  input_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workflow_id, stage)
);
CREATE UNIQUE INDEX IF NOT EXISTS episode_workflow_stage_job_idx ON episode_workflow_stages(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS episode_workflow_stages_status_idx ON episode_workflow_stages(workflow_id, status);

COMMIT;
