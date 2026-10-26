-- Follow-up integrity migration. This migration is safe for databases which
-- already applied 001_initial_schema.sql; never rewrite that historical file.
BEGIN;

ALTER TABLE version_records DROP CONSTRAINT IF EXISTS version_records_kind_check;
ALTER TABLE version_records ADD CONSTRAINT version_records_kind_check
  CHECK (kind IN ('episode','research','script','scene-plan','scene','asset','narration','timeline','render','qa','caption','thumbnail','publish-record'));

-- A dependency edge must stay within an episode. The application also verifies
-- this before inserting edges; the trigger protects direct SQL writers.
CREATE OR REPLACE FUNCTION forge_assert_version_dependency_episode_matches() RETURNS trigger AS $$
DECLARE source_episode text;
DECLARE dependency_episode text;
BEGIN
  SELECT episode_id INTO source_episode FROM version_records WHERE id = NEW.version_id;
  SELECT episode_id INTO dependency_episode FROM version_records WHERE id = NEW.depends_on_version_id;
  IF source_episode IS NULL OR dependency_episode IS NULL OR
     source_episode <> NEW.episode_id OR dependency_episode <> NEW.episode_id THEN
    RAISE EXCEPTION 'version dependency must reference versions within the same episode';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS version_dependency_episode_matches ON version_dependencies;
CREATE TRIGGER version_dependency_episode_matches
BEFORE INSERT OR UPDATE OF episode_id, version_id, depends_on_version_id ON version_dependencies
FOR EACH ROW EXECUTE FUNCTION forge_assert_version_dependency_episode_matches();

-- Prevent cycles while retaining a normalized edge table. Recursive reachability
-- follows existing dependencies from prerequisite -> descendants.
CREATE OR REPLACE FUNCTION forge_assert_version_dependency_acyclic() RETURNS trigger AS $$
DECLARE cycle_found boolean;
BEGIN
  WITH RECURSIVE reachable(version_id) AS (
    SELECT NEW.version_id
    UNION
    SELECT vd.version_id
    FROM version_dependencies vd
    JOIN reachable r ON vd.depends_on_version_id = r.version_id
    WHERE vd.episode_id = NEW.episode_id
  )
  SELECT EXISTS (
    SELECT 1 FROM reachable WHERE version_id = NEW.depends_on_version_id
  ) INTO cycle_found;
  IF NEW.version_id = NEW.depends_on_version_id OR cycle_found THEN
    RAISE EXCEPTION 'version dependency would introduce a cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS version_dependency_acyclic ON version_dependencies;
CREATE TRIGGER version_dependency_acyclic
BEFORE INSERT OR UPDATE OF version_id, depends_on_version_id ON version_dependencies
FOR EACH ROW EXECUTE FUNCTION forge_assert_version_dependency_acyclic();

-- Avoid accepting artifacts whose version belongs to a different episode.
CREATE OR REPLACE FUNCTION forge_assert_artifact_version_episode_matches() RETURNS trigger AS $$
DECLARE version_episode text;
BEGIN
  SELECT episode_id INTO version_episode FROM version_records WHERE id = NEW.version_id;
  IF version_episode IS NULL OR version_episode <> NEW.episode_id THEN
    RAISE EXCEPTION 'artifact version must belong to artifact episode';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_version_episode_matches ON artifacts;
CREATE TRIGGER artifact_version_episode_matches
BEFORE INSERT OR UPDATE OF episode_id, version_id ON artifacts
FOR EACH ROW EXECUTE FUNCTION forge_assert_artifact_version_episode_matches();

-- Provider run identity is immutable once it exists; mutable status is updated
-- by the repository transition method, and terminal status is enforced there.
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
