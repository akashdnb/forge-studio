-- Production concurrency invariants for episode/version state and durable execution.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS artifacts_episode_id_idx ON artifacts(episode_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS version_records_episode_id_idx ON version_records(episode_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS publish_runs_episode_id_idx ON publish_runs(episode_id, id);

ALTER TABLE version_dependencies DROP CONSTRAINT IF EXISTS version_dependencies_version_episode_fk;
ALTER TABLE version_dependencies ADD CONSTRAINT version_dependencies_version_episode_fk
  FOREIGN KEY (episode_id, version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;
ALTER TABLE version_dependencies DROP CONSTRAINT IF EXISTS version_dependencies_dependency_episode_fk;
ALTER TABLE version_dependencies ADD CONSTRAINT version_dependencies_dependency_episode_fk
  FOREIGN KEY (episode_id, depends_on_version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_version_episode_fk;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_version_episode_fk
  FOREIGN KEY (episode_id, version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;
ALTER TABLE qa_results DROP CONSTRAINT IF EXISTS qa_results_version_episode_fk;
ALTER TABLE qa_results ADD CONSTRAINT qa_results_version_episode_fk
  FOREIGN KEY (episode_id, version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;
ALTER TABLE timeline_snapshots DROP CONSTRAINT IF EXISTS timeline_snapshots_version_episode_fk;
ALTER TABLE timeline_snapshots ADD CONSTRAINT timeline_snapshots_version_episode_fk
  FOREIGN KEY (episode_id, version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;
ALTER TABLE publish_runs DROP CONSTRAINT IF EXISTS publish_runs_artifact_episode_fk;
ALTER TABLE publish_runs ADD CONSTRAINT publish_runs_artifact_episode_fk
  FOREIGN KEY (episode_id, render_artifact_id) REFERENCES artifacts(episode_id, id) ON DELETE RESTRICT;
ALTER TABLE publish_runs DROP CONSTRAINT IF EXISTS publish_runs_version_episode_fk;
ALTER TABLE publish_runs ADD CONSTRAINT publish_runs_version_episode_fk
  FOREIGN KEY (episode_id, render_version_id) REFERENCES version_records(episode_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS approvals_single_approved_idx
  ON approvals(episode_id, stage, target_id, target_version_id)
  WHERE decision = 'APPROVED';

ALTER TABLE qa_results ADD COLUMN IF NOT EXISTS idempotency_key text;
UPDATE qa_results SET idempotency_key = id WHERE idempotency_key IS NULL;
ALTER TABLE qa_results ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS qa_results_idempotency_idx ON qa_results(idempotency_key);

ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS publish_runs_active_lease_idx
  ON publish_runs(lease_token) WHERE lease_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS forge_concurrency_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN (
    'REVISION_CONFLICT','STATE_CONFLICT','IDEMPOTENT_REPLAY','PROVENANCE_CONFLICT',
    'APPROVAL_RACE','PUBLISH_RACE','STALE_WORKER','VERSION_RACE','INVARIANT_VIOLATION'
  )),
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  version_id text REFERENCES version_records(id) ON DELETE RESTRICT,
  actor text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_concurrency_events_episode_idx ON forge_concurrency_events(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_concurrency_events_type_idx ON forge_concurrency_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_concurrency_events_job_idx ON forge_concurrency_events(job_id, created_at DESC);

CREATE OR REPLACE FUNCTION forge_assert_episode_consistency() RETURNS trigger AS $$
DECLARE render_episode text;
BEGIN
  IF NEW.current_render_id IS NOT NULL THEN
    SELECT episode_id INTO render_episode FROM artifacts WHERE id = NEW.current_render_id;
    IF render_episode IS NULL OR render_episode <> NEW.id THEN
      RAISE EXCEPTION 'current render does not belong to episode %', NEW.id USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.approved_render_id IS NOT NULL THEN
    SELECT episode_id INTO render_episode FROM artifacts WHERE id = NEW.approved_render_id;
    IF render_episode IS NULL OR render_episode <> NEW.id THEN
      RAISE EXCEPTION 'approved render does not belong to episode %', NEW.id USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state IN ('APPROVED','PUBLISHING','PUBLISHED') AND NEW.approved_render_id IS NULL THEN
    RAISE EXCEPTION 'state % requires an approved render', NEW.state USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'PUBLISHED' AND NEW.published_record_id IS NULL THEN
    RAISE EXCEPTION 'published episode requires published_record_id' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS episodes_consistency_guard ON episodes;
CREATE CONSTRAINT TRIGGER episodes_consistency_guard
AFTER INSERT OR UPDATE OF state,current_render_id,approved_render_id,published_record_id ON episodes
DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION forge_assert_episode_consistency();

CREATE OR REPLACE FUNCTION forge_assert_publish_consistency() RETURNS trigger AS $$
DECLARE artifact_version text;
BEGIN
  SELECT version_id INTO artifact_version FROM artifacts WHERE id = NEW.render_artifact_id AND episode_id = NEW.episode_id;
  IF artifact_version IS NULL OR artifact_version <> NEW.render_version_id THEN
    RAISE EXCEPTION 'publish artifact/version provenance mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS publish_runs_consistency_guard ON publish_runs;
CREATE CONSTRAINT TRIGGER publish_runs_consistency_guard
AFTER INSERT OR UPDATE OF episode_id,render_artifact_id,render_version_id ON publish_runs
DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION forge_assert_publish_consistency();

CREATE OR REPLACE FUNCTION forge_assert_usage_reservation_ownership() RETURNS trigger AS $$
DECLARE job_project text; job_episode text;
BEGIN
  SELECT project_id, episode_id INTO job_project, job_episode FROM forge_jobs WHERE id = NEW.job_id;
  IF job_project IS NULL AND NEW.project_id IS NOT NULL THEN
    RAISE EXCEPTION 'usage reservation project does not match job' USING ERRCODE = '23514';
  END IF;
  IF job_project IS NOT NULL AND NEW.project_id IS DISTINCT FROM job_project THEN
    RAISE EXCEPTION 'usage reservation project does not match job' USING ERRCODE = '23514';
  END IF;
  IF job_episode IS NULL AND NEW.episode_id IS NOT NULL THEN
    RAISE EXCEPTION 'usage reservation episode does not match job' USING ERRCODE = '23514';
  END IF;
  IF job_episode IS NOT NULL AND NEW.episode_id IS DISTINCT FROM job_episode THEN
    RAISE EXCEPTION 'usage reservation episode does not match job' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS usage_reservation_ownership_guard ON usage_reservations;
CREATE TRIGGER usage_reservation_ownership_guard
BEFORE INSERT OR UPDATE OF job_id,project_id,episode_id ON usage_reservations
FOR EACH ROW EXECUTE FUNCTION forge_assert_usage_reservation_ownership();

COMMIT;
