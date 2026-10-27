-- PostgreSQL integrity/performance hardening for the long-form production control plane.
-- The migration is transactional and takes a transaction-scoped advisory lock so only
-- one deployment can mutate the schema at a time. Existing inconsistencies fail closed.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('forge-studio:schema-migration'));

-- Fail closed before adding lifecycle invariants. These checks are intentionally explicit
-- so a production migration never silently repairs or reassigns provenance.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM forge_jobs j WHERE j.episode_id IS NOT NULL AND j.project_id IS NULL) THEN
    RAISE EXCEPTION 'forge_jobs contains episode-scoped rows without project_id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM forge_jobs j JOIN episodes e ON e.id = j.episode_id
    WHERE j.episode_id IS NOT NULL AND j.project_id <> e.project_id
  ) THEN
    RAISE EXCEPTION 'forge_jobs contains episode/project ownership mismatches';
  END IF;
  IF EXISTS (
    SELECT 1 FROM artifacts a JOIN version_records v ON v.id = a.version_id
    WHERE a.episode_id <> v.episode_id
  ) THEN
    RAISE EXCEPTION 'artifacts contains episode/version provenance mismatches';
  END IF;
  IF EXISTS (
    SELECT 1 FROM version_dependencies d
    JOIN version_records v ON v.id = d.version_id
    JOIN version_records dep ON dep.id = d.depends_on_version_id
    WHERE d.episode_id <> v.episode_id OR d.episode_id <> dep.episode_id
  ) THEN
    RAISE EXCEPTION 'version_dependencies contains cross-episode dependencies';
  END IF;
  IF EXISTS (
    SELECT 1 FROM usage_reservations r JOIN episodes e ON e.id = r.episode_id
    WHERE r.episode_id IS NOT NULL AND (r.project_id IS NULL OR r.project_id <> e.project_id)
  ) THEN
    RAISE EXCEPTION 'usage_reservations contains episode/project ownership mismatches';
  END IF;
  IF EXISTS (
    SELECT 1 FROM usage_events u JOIN episodes e ON e.id = u.episode_id
    WHERE u.episode_id IS NOT NULL AND (u.project_id IS NULL OR u.project_id <> e.project_id)
  ) THEN
    RAISE EXCEPTION 'usage_events contains episode/project ownership mismatches';
  END IF;
END $$;

-- Composite uniqueness gives us stable database-level ownership targets for composite FKs.
CREATE UNIQUE INDEX IF NOT EXISTS episodes_id_project_uidx ON episodes(id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS version_records_id_episode_uidx ON version_records(id, episode_id);

-- Enforce provenance/ownership at the database boundary. Triggers are used where the
-- existing schema cannot express a cross-table CHECK constraint directly.
CREATE OR REPLACE FUNCTION forge_assert_job_episode_project() RETURNS trigger AS $$
DECLARE expected_project text;
BEGIN
  IF NEW.episode_id IS NOT NULL THEN
    SELECT project_id INTO expected_project FROM episodes WHERE id = NEW.episode_id;
    IF expected_project IS NULL THEN RAISE EXCEPTION 'job episode does not exist'; END IF;
    IF NEW.project_id IS NULL OR NEW.project_id <> expected_project THEN
      RAISE EXCEPTION 'job project must match episode project';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_job_episode_project_guard ON forge_jobs;
CREATE TRIGGER forge_job_episode_project_guard
BEFORE INSERT OR UPDATE OF episode_id, project_id ON forge_jobs
FOR EACH ROW EXECUTE FUNCTION forge_assert_job_episode_project();

CREATE OR REPLACE FUNCTION forge_assert_artifact_episode_version() RETURNS trigger AS $$
DECLARE expected_episode text;
BEGIN
  SELECT episode_id INTO expected_episode FROM version_records WHERE id = NEW.version_id;
  IF expected_episode IS NULL THEN RAISE EXCEPTION 'artifact version does not exist'; END IF;
  IF NEW.episode_id <> expected_episode THEN RAISE EXCEPTION 'artifact episode must match version episode'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_artifact_episode_version_guard ON artifacts;
CREATE TRIGGER forge_artifact_episode_version_guard
BEFORE INSERT OR UPDATE OF episode_id, version_id ON artifacts
FOR EACH ROW EXECUTE FUNCTION forge_assert_artifact_episode_version();

CREATE OR REPLACE FUNCTION forge_assert_dependency_episode() RETURNS trigger AS $$
DECLARE owner_episode text; dependency_episode text;
BEGIN
  SELECT episode_id INTO owner_episode FROM version_records WHERE id = NEW.version_id;
  SELECT episode_id INTO dependency_episode FROM version_records WHERE id = NEW.depends_on_version_id;
  IF owner_episode IS NULL OR dependency_episode IS NULL OR NEW.episode_id <> owner_episode OR owner_episode <> dependency_episode THEN
    RAISE EXCEPTION 'version dependency must remain within one episode';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_dependency_episode_guard ON version_dependencies;
CREATE TRIGGER forge_dependency_episode_guard
BEFORE INSERT OR UPDATE OF episode_id, version_id, depends_on_version_id ON version_dependencies
FOR EACH ROW EXECUTE FUNCTION forge_assert_dependency_episode();

CREATE OR REPLACE FUNCTION forge_assert_usage_episode_project() RETURNS trigger AS $$
DECLARE expected_project text;
BEGIN
  IF NEW.episode_id IS NOT NULL THEN
    SELECT project_id INTO expected_project FROM episodes WHERE id = NEW.episode_id;
    IF expected_project IS NULL OR NEW.project_id IS NULL OR NEW.project_id <> expected_project THEN
      RAISE EXCEPTION 'usage row project must match episode project';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_usage_reservation_episode_project_guard ON usage_reservations;
CREATE TRIGGER forge_usage_reservation_episode_project_guard
BEFORE INSERT OR UPDATE OF episode_id, project_id ON usage_reservations
FOR EACH ROW EXECUTE FUNCTION forge_assert_usage_episode_project();
DROP TRIGGER IF EXISTS forge_usage_event_episode_project_guard ON usage_events;
CREATE TRIGGER forge_usage_event_episode_project_guard
BEFORE INSERT OR UPDATE OF episode_id, project_id ON usage_events
FOR EACH ROW EXECUTE FUNCTION forge_assert_usage_episode_project();

-- Critical read/claim paths: predicates first, deterministic tie breakers last.
CREATE INDEX IF NOT EXISTS forge_jobs_claim_hot_idx
  ON forge_jobs(available_at, priority, created_at, id)
  WHERE status = 'QUEUED' AND cancellation_requested_at IS NULL;
CREATE INDEX IF NOT EXISTS forge_jobs_dependency_status_idx
  ON forge_jobs(depends_on_job_id, status, updated_at DESC)
  WHERE depends_on_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_jobs_running_lease_idx
  ON forge_jobs(leased_until, id)
  WHERE status = 'RUNNING' AND leased_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_jobs_project_status_created_idx
  ON forge_jobs(project_id, status, created_at DESC, id);

CREATE INDEX IF NOT EXISTS episodes_project_updated_id_idx
  ON episodes(project_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS episodes_global_updated_id_idx
  ON episodes(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS episodes_project_state_updated_idx
  ON episodes(project_id, state, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS version_records_episode_kind_created_id_idx
  ON version_records(episode_id, kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS version_dependencies_dependency_version_idx
  ON version_dependencies(depends_on_version_id, version_id);

CREATE INDEX IF NOT EXISTS artifacts_episode_version_kind_created_idx
  ON artifacts(episode_id, version_id, kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS artifacts_render_episode_created_idx
  ON artifacts(episode_id, created_at DESC, id DESC) WHERE kind = 'render';

CREATE INDEX IF NOT EXISTS provider_runs_episode_status_created_idx
  ON provider_runs(episode_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS provider_runs_idempotency_idx ON provider_runs(idempotency_key);

CREATE INDEX IF NOT EXISTS qa_results_passing_latest_idx
  ON qa_results(artifact_id, version_id, created_at DESC, id DESC)
  WHERE status IN ('PASSED','WARNINGS');
CREATE INDEX IF NOT EXISTS approvals_latest_idx
  ON approvals(episode_id, stage, target_id, target_version_id, decided_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS approvals_approved_idempotency_idx
  ON approvals(episode_id, stage, target_id, target_version_id)
  WHERE decision = 'APPROVED';

CREATE INDEX IF NOT EXISTS audit_events_project_created_id_idx
  ON audit_events(project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_target_created_idx
  ON audit_events(target_type, target_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS forge_outbox_pending_hot_idx
  ON forge_outbox(available_at, id)
  WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS forge_idempotency_expiry_live_idx
  ON forge_idempotency_keys(expires_at, key);

CREATE INDEX IF NOT EXISTS usage_events_episode_occurred_id_idx
  ON usage_events(episode_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS usage_events_project_occurred_id_idx
  ON usage_events(project_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS usage_events_retention_idx
  ON usage_events(created_at, id);
CREATE INDEX IF NOT EXISTS usage_reservations_expiry_hot_idx
  ON usage_reservations(expires_at, id)
  WHERE status = 'HELD';
CREATE INDEX IF NOT EXISTS usage_budgets_active_scope_idx
  ON usage_budgets(scope_type, scope_id, period_key, currency)
  WHERE state = 'ACTIVE';

CREATE INDEX IF NOT EXISTS artifact_lifecycle_candidate_hot_idx
  ON artifact_lifecycle_records(candidate_at, updated_at, artifact_id)
  WHERE state IN ('QUARANTINED','DELETION_PENDING');
CREATE INDEX IF NOT EXISTS artifact_lifecycle_active_project_idx
  ON artifact_lifecycle_records(project_id, state, updated_at DESC, artifact_id);
CREATE INDEX IF NOT EXISTS artifact_holds_active_expiry_idx
  ON artifact_holds(expires_at, artifact_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS publish_runs_reconciliation_hot_idx
  ON publish_runs(updated_at, id)
  WHERE status IN ('QUEUED','UPLOADING','RECONCILIATION_REQUIRED');
CREATE INDEX IF NOT EXISTS forge_scheduler_events_retention_idx
  ON forge_scheduler_events(created_at, id);

-- Avoid an accidental sequential scan when cleanup/reconciliation callers omit a bound.
CREATE OR REPLACE FUNCTION forge_require_bounded_batch(requested integer, maximum integer DEFAULT 1000)
RETURNS integer AS $$
BEGIN
  IF requested IS NULL OR requested < 1 OR requested > maximum THEN
    RAISE EXCEPTION 'batch size must be between 1 and %', maximum USING ERRCODE='22023';
  END IF;
  RETURN requested;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON INDEX forge_jobs_claim_hot_idx IS 'Hot-path queue claim: bounded, deterministic queued-job selection';
COMMENT ON INDEX usage_events_retention_idx IS 'Retention scans must walk by created_at/id with an explicit LIMIT';
COMMENT ON INDEX artifact_lifecycle_candidate_hot_idx IS 'Bounded lifecycle reconciliation candidates';

COMMIT;
