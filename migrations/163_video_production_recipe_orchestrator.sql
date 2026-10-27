CREATE TABLE IF NOT EXISTS video_production_recipes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  episode_id text NOT NULL REFERENCES episodes(id),
  version integer NOT NULL CHECK (version > 0),
  recipe_hash text NOT NULL,
  topic text NOT NULL,
  recipe jsonb NOT NULL,
  provider_config jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, recipe_hash)
);
CREATE INDEX IF NOT EXISTS idx_video_production_recipes_episode ON video_production_recipes(episode_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video_production_attempts (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES video_production_recipes(id) ON DELETE CASCADE,
  workflow_id text NOT NULL UNIQUE,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  current_stage text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error jsonb,
  output_artifact_id text,
  output_version_id text,
  output_sha256 text,
  output_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_video_production_attempts_recipe ON video_production_attempts(recipe_id, attempt_no DESC);

CREATE TABLE IF NOT EXISTS video_production_stage_runs (
  id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES video_production_attempts(id) ON DELETE CASCADE,
  stage text NOT NULL,
  status text NOT NULL,
  job_id text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms bigint,
  input_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error jsonb,
  provider text,
  model text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_video_production_stage_runs_attempt ON video_production_stage_runs(attempt_id, stage);

ALTER TABLE video_production_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_production_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_production_stage_runs ENABLE ROW LEVEL SECURITY;
