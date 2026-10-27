BEGIN;

ALTER TABLE episode_packages ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS forge_release_calendar_controls (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  emergency_hold boolean NOT NULL DEFAULT false,
  release_epoch bigint NOT NULL DEFAULT 1 CHECK (release_epoch > 0),
  updated_by text NOT NULL DEFAULT 'system',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id)
);
CREATE INDEX IF NOT EXISTS forge_release_calendar_controls_scope_idx ON forge_release_calendar_controls(tenant_id, COALESCE(project_id, ''));

CREATE TABLE IF NOT EXISTS forge_release_schedules (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','CANCELLED','COMPLETED')),
  current_version bigint NOT NULL CHECK (current_version > 0),
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_execution_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_release_schedules_due_idx ON forge_release_schedules(status, next_run_at, priority, id);
CREATE INDEX IF NOT EXISTS forge_release_schedules_scope_idx ON forge_release_schedules(tenant_id, project_id, episode_id, status);

CREATE TABLE IF NOT EXISTS forge_release_schedule_versions (
  schedule_id text NOT NULL REFERENCES forge_release_schedules(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version > 0),
  timezone text NOT NULL,
  schedule_kind text NOT NULL CHECK (schedule_kind IN ('ONCE','DAILY','WEEKLY')),
  local_date date,
  local_time time NOT NULL,
  weekdays jsonb NOT NULL DEFAULT '[]'::jsonb,
  destinations jsonb NOT NULL,
  destination_windows jsonb NOT NULL DEFAULT '{}'::jsonb,
  blackout_policy text NOT NULL DEFAULT 'DEFER' CHECK (blackout_policy IN ('DEFER','SKIP')),
  missed_window_policy text NOT NULL DEFAULT 'NEXT_WINDOW' CHECK (missed_window_policy IN ('NEXT_WINDOW','SKIP','RUN_IMMEDIATELY')),
  max_missed_window_age_seconds integer NOT NULL DEFAULT 86400 CHECK (max_missed_window_age_seconds >= 0),
  canonical_snapshot jsonb NOT NULL,
  snapshot_hash char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(schedule_id, version),
  CHECK ((schedule_kind <> 'ONCE' AND local_date IS NULL) OR (schedule_kind = 'ONCE' AND local_date IS NOT NULL)),
  CHECK (jsonb_typeof(destinations) = 'array')
);
CREATE INDEX IF NOT EXISTS forge_release_schedule_versions_hash_idx ON forge_release_schedule_versions(snapshot_hash);

CREATE TABLE IF NOT EXISTS forge_release_calendar_blackouts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  destination text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS forge_release_calendar_blackouts_window_idx ON forge_release_calendar_blackouts(tenant_id, project_id, destination, starts_at, ends_at) WHERE status='ACTIVE';

CREATE TABLE IF NOT EXISTS forge_release_schedule_executions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  schedule_id text NOT NULL REFERENCES forge_release_schedules(id) ON DELETE RESTRICT,
  schedule_version bigint NOT NULL,
  occurrence_key text NOT NULL,
  destination text NOT NULL,
  planned_at timestamptz NOT NULL,
  window_deadline_at timestamptz,
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','BLOCKED','QUEUED','RUNNING','PUBLISHED','FAILED','CANCELLED','SKIPPED','RECONCILIATION_REQUIRED')),
  publish_run_id text REFERENCES publish_runs(id) ON DELETE RESTRICT,
  publish_job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  gate_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  gate_fingerprint char(64),
  execution_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_fingerprint char(64),
  release_epoch bigint NOT NULL CHECK (release_epoch > 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  block_reason text,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(schedule_id, schedule_version, occurrence_key, destination)
);
CREATE INDEX IF NOT EXISTS forge_release_schedule_executions_due_idx ON forge_release_schedule_executions(status, planned_at);
CREATE INDEX IF NOT EXISTS forge_release_schedule_executions_scope_idx ON forge_release_schedule_executions(tenant_id, project_id, episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_release_schedule_executions_run_idx ON forge_release_schedule_executions(publish_run_id);

CREATE TABLE IF NOT EXISTS forge_release_schedule_audit (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  schedule_id text REFERENCES forge_release_schedules(id) ON DELETE RESTRICT,
  schedule_version bigint,
  actor text NOT NULL,
  action text NOT NULL,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_release_schedule_audit_scope_idx ON forge_release_schedule_audit(tenant_id, project_id, schedule_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_release_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0)
);
INSERT INTO forge_release_state(id) VALUES(true) ON CONFLICT(id) DO NOTHING;

CREATE OR REPLACE FUNCTION forge_fill_scheduled_publish_package() RETURNS trigger AS $$
BEGIN
  IF COALESCE((NEW.metadata->>'scheduledRelease')::boolean, false) AND NEW.package_artifact_id IS NULL THEN
    SELECT ep.id, ep.version_id INTO NEW.package_artifact_id, NEW.package_version_id
      FROM episode_packages ep
     WHERE ep.episode_id = NEW.episode_id
       AND ep.final_media_artifact_id = NEW.render_artifact_id
       AND ep.final_media_version_id = NEW.render_version_id
       AND ep.status = 'READY'
     ORDER BY ep.created_at DESC LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_scheduled_publish_package ON publish_runs;
CREATE TRIGGER forge_scheduled_publish_package BEFORE INSERT ON publish_runs FOR EACH ROW EXECUTE FUNCTION forge_fill_scheduled_publish_package();

COMMIT;
