BEGIN;

CREATE TABLE IF NOT EXISTS media_derivatives (
  identity char(64) PRIMARY KEY,
  source_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  artifact_id text NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  source_checksum char(64) NOT NULL,
  recipe_hash char(64) NOT NULL,
  recipe jsonb NOT NULL,
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('PROCESSING','READY','FAILED','CANCELLED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, source_artifact_id, recipe_hash),
  CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  CHECK (recipe_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS media_derivatives_project_episode_idx ON media_derivatives(project_id, episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_derivatives_source_idx ON media_derivatives(source_artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_derivatives_recipe_idx ON media_derivatives(recipe_hash, created_at DESC);

CREATE OR REPLACE FUNCTION forge_media_derivative_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS media_derivatives_touch_updated_at ON media_derivatives;
CREATE TRIGGER media_derivatives_touch_updated_at BEFORE UPDATE ON media_derivatives FOR EACH ROW EXECUTE FUNCTION forge_media_derivative_touch_updated_at();

COMMIT;
