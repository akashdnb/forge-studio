-- Immutable AI/media generation recipe snapshots and execution attempts.
BEGIN;
CREATE TABLE IF NOT EXISTS generation_recipes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  recipe_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  schema_version text NOT NULL,
  recipe_hash char(64) NOT NULL,
  prompt_hash char(64) NOT NULL,
  template_hash char(64) NOT NULL,
  snapshot jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, recipe_key, version),
  UNIQUE(project_id, recipe_hash)
);
CREATE INDEX IF NOT EXISTS generation_recipes_scope_idx ON generation_recipes(tenant_id, project_id, recipe_key, version DESC);
CREATE INDEX IF NOT EXISTS generation_recipes_episode_idx ON generation_recipes(episode_id, created_at DESC);
CREATE TABLE IF NOT EXISTS generation_recipe_lifecycle (
  recipe_id text PRIMARY KEY REFERENCES generation_recipes(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('ACTIVE','DEPRECATED','RETIRED')),
  reason text,
  replacement_recipe_id text REFERENCES generation_recipes(id) ON DELETE RESTRICT,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS generation_recipe_inputs (
  recipe_id text NOT NULL REFERENCES generation_recipes(id) ON DELETE RESTRICT,
  digest char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(recipe_id, digest)
);
CREATE TABLE IF NOT EXISTS generation_attempts (
  id text PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES generation_recipes(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  provider_run_id text REFERENCES provider_runs(id) ON DELETE RESTRICT,
  job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  replay_of text REFERENCES generation_recipes(id) ON DELETE RESTRICT,
  observed_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  drift_detected boolean NOT NULL DEFAULT false,
  output_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  error jsonb,
  actor text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS generation_attempts_recipe_idx ON generation_attempts(recipe_id, started_at DESC);
CREATE INDEX IF NOT EXISTS generation_attempts_scope_idx ON generation_attempts(tenant_id, project_id, started_at DESC);
CREATE TABLE IF NOT EXISTS generation_recipe_audit (
  id bigserial PRIMARY KEY,
  recipe_id text NOT NULL REFERENCES generation_recipes(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  actor text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS generation_recipe_audit_idx ON generation_recipe_audit(tenant_id, project_id, recipe_id, created_at DESC);
CREATE OR REPLACE FUNCTION forge_generation_recipe_audit_immutable() RETURNS trigger AS $$ BEGIN IF TG_OP IN ('UPDATE','DELETE') THEN RAISE EXCEPTION 'generation recipe audit evidence is append-only'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS generation_recipe_audit_immutable ON generation_recipe_audit;
CREATE TRIGGER generation_recipe_audit_immutable BEFORE UPDATE OR DELETE ON generation_recipe_audit FOR EACH ROW EXECUTE FUNCTION forge_generation_recipe_audit_immutable();
ALTER TABLE provider_runs ADD COLUMN IF NOT EXISTS generation_recipe_id text REFERENCES generation_recipes(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS provider_runs_generation_recipe_idx ON provider_runs(generation_recipe_id, created_at DESC);
CREATE OR REPLACE FUNCTION forge_generation_recipe_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN RAISE EXCEPTION 'generation recipe snapshots are immutable'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS generation_recipe_immutable ON generation_recipes;
CREATE TRIGGER generation_recipe_immutable BEFORE UPDATE OR DELETE ON generation_recipes FOR EACH ROW EXECUTE FUNCTION forge_generation_recipe_immutable();
CREATE OR REPLACE FUNCTION forge_require_generation_recipe() RETURNS trigger AS $$
BEGIN
  IF NEW.capability IN ('research','script','scene-plan','narration','assets','transcription','text-generation','image-generation','video-generation','tts','speech-synthesis') AND NEW.generation_recipe_id IS NULL THEN
    RAISE EXCEPTION 'AI/media provider run requires immutable generation recipe';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS provider_run_requires_generation_recipe ON provider_runs;
CREATE TRIGGER provider_run_requires_generation_recipe BEFORE INSERT OR UPDATE OF capability,generation_recipe_id ON provider_runs FOR EACH ROW EXECUTE FUNCTION forge_require_generation_recipe();
COMMIT;
