-- Forge Studio PostgreSQL schema (initial durable production core)
-- PostgreSQL 15+. Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_initial_schema.sql

BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_by text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS episodes (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  channel_id text,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT','RESEARCHING','SCRIPT_DRAFT','SCRIPT_REVIEW','SCRIPT_APPROVED',
    'PLANNING','PLAN_REVIEW','GENERATION','READY_TO_RENDER','RENDERING',
    'QA','AWAITING_APPROVAL','APPROVED','PUBLISHING','PUBLISHED','FAILED','CANCELLED'
  )),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  current_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_render_id text,
  approved_render_id text,
  published_record_id text,
  created_by text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS episodes_project_updated_idx ON episodes(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS episodes_state_updated_idx ON episodes(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS version_records (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('episode','script','scene-plan','scene','asset','narration','render','qa','timeline','caption','thumbnail')),
  parent_id text REFERENCES version_records(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (episode_id, id)
);
CREATE INDEX IF NOT EXISTS version_records_episode_kind_idx ON version_records(episode_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS version_dependencies (
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  depends_on_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, depends_on_version_id),
  CHECK (version_id <> depends_on_version_id)
);
CREATE INDEX IF NOT EXISTS version_dependencies_reverse_idx ON version_dependencies(episode_id, depends_on_version_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  storage_uri text,
  content_json jsonb,
  content_hash char(64),
  media_type text,
  provider_run_id text,
  source text NOT NULL DEFAULT 'forge',
  license jsonb,
  input_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (storage_uri IS NOT NULL OR content_json IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS artifacts_episode_created_idx ON artifacts(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_version_idx ON artifacts(version_id);

CREATE TABLE IF NOT EXISTS provider_runs (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  capability text NOT NULL,
  provider text NOT NULL,
  model text,
  input_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  external_job_id text,
  result_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  estimated_cost numeric(20,8),
  actual_cost numeric(20,8),
  currency char(3) NOT NULL DEFAULT 'USD',
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS provider_runs_episode_created_idx ON provider_runs(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS provider_runs_status_created_idx ON provider_runs(status, created_at);

CREATE TABLE IF NOT EXISTS cost_records (
  id text PRIMARY KEY,
  provider_run_id text NOT NULL REFERENCES provider_runs(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  model text,
  operation text NOT NULL,
  input_units numeric(24,6) NOT NULL DEFAULT 0 CHECK (input_units >= 0),
  output_units numeric(24,6) NOT NULL DEFAULT 0 CHECK (output_units >= 0),
  estimated_cost numeric(20,8) CHECK (estimated_cost >= 0),
  actual_cost numeric(20,8) CHECK (actual_cost >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  is_retry boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_records_episode_created_idx ON cost_records(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cost_records_run_idx ON cost_records(provider_run_id);

CREATE TABLE IF NOT EXISTS qa_results (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PASSED','WARNINGS','FAILED')),
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  runner text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qa_results_artifact_version_idx ON qa_results(artifact_id, version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN ('SCRIPT','SCENE_PLAN','CREATIVE','FINAL_RENDER')),
  target_id text NOT NULL,
  target_version_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED','CHANGES_REQUESTED','REJECTED')),
  actor text NOT NULL,
  comments text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_target_history_idx ON approvals(episode_id, stage, target_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_episode_created_idx ON audit_events(episode_id, created_at DESC);

-- Enforce episode consistency for cost entries: app-level checks are not enough.
CREATE OR REPLACE FUNCTION forge_assert_cost_episode_matches_run() RETURNS trigger AS $$
DECLARE run_episode_id text;
BEGIN
  SELECT episode_id INTO run_episode_id FROM provider_runs WHERE id = NEW.provider_run_id;
  IF run_episode_id IS NULL OR run_episode_id <> NEW.episode_id THEN
    RAISE EXCEPTION 'cost record episode must match provider run episode';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cost_episode_matches_run ON cost_records;
CREATE TRIGGER cost_episode_matches_run
BEFORE INSERT OR UPDATE OF provider_run_id, episode_id ON cost_records
FOR EACH ROW EXECUTE FUNCTION forge_assert_cost_episode_matches_run();

COMMIT;
