BEGIN;
CREATE TABLE IF NOT EXISTS workflow_sla_policies (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  job_kind text NOT NULL DEFAULT '*',
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  run_deadline_seconds integer NOT NULL CHECK(run_deadline_seconds>0),
  stage_deadline_seconds integer NOT NULL CHECK(stage_deadline_seconds>0),
  warning_seconds integer NOT NULL CHECK(warning_seconds>=0),
  grace_seconds integer NOT NULL CHECK(grace_seconds>=0),
  lease_grace_seconds integer NOT NULL CHECK(lease_grace_seconds>=0),
  max_extension_seconds integer NOT NULL CHECK(max_extension_seconds>0),
  max_recovery_attempts integer NOT NULL CHECK(max_recovery_attempts>=0),
  clock_skew_seconds integer NOT NULL CHECK(clock_skew_seconds>=0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,project_id,job_kind,version)
);
CREATE INDEX IF NOT EXISTS workflow_sla_policy_lookup_idx ON workflow_sla_policies(tenant_id,project_id,job_kind,version DESC);
CREATE TABLE IF NOT EXISTS workflow_sla_runs (
  id text PRIMARY KEY,
  job_id text NOT NULL UNIQUE REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  policy_id text NOT NULL REFERENCES workflow_sla_policies(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  state text NOT NULL CHECK(state IN('ACTIVE','WARNING','GRACE','EXTENDED','EXPIRED','COMPLETED')),
  started_at timestamptz NOT NULL,
  run_deadline_at timestamptz NOT NULL,
  stage_deadline_at timestamptz NOT NULL,
  warning_at timestamptz NOT NULL,
  grace_until timestamptz,
  last_heartbeat_at timestamptz,
  lease_expired_at timestamptz,
  expired_at timestamptz,
  completed_at timestamptz,
  clock_observed_at timestamptz NOT NULL,
  extension_count integer NOT NULL DEFAULT 0,
  recovery_count integer NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_sla_runs_deadline_idx ON workflow_sla_runs(state,run_deadline_at);
CREATE INDEX IF NOT EXISTS workflow_sla_runs_project_idx ON workflow_sla_runs(project_id,state,run_deadline_at);
CREATE TABLE IF NOT EXISTS workflow_sla_deadline_history (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  run_id text NOT NULL REFERENCES workflow_sla_runs(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  deadline_at timestamptz NOT NULL,
  stage_deadline_at timestamptz NOT NULL,
  warning_at timestamptz NOT NULL,
  reason text NOT NULL,
  actor text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_sla_deadline_history_job_idx ON workflow_sla_deadline_history(job_id,recorded_at DESC);
CREATE TABLE IF NOT EXISTS workflow_sla_events (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  run_id text NOT NULL REFERENCES workflow_sla_runs(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  actor text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS workflow_sla_events_job_idx ON workflow_sla_events(job_id,observed_at DESC);
CREATE OR REPLACE FUNCTION forge_sla_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'workflow_sla_events is append-only'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workflow_sla_events_immutable ON workflow_sla_events;
CREATE TRIGGER workflow_sla_events_immutable BEFORE UPDATE OR DELETE ON workflow_sla_events FOR EACH ROW EXECUTE FUNCTION forge_sla_immutable_history();
CREATE OR REPLACE FUNCTION forge_sla_deadline_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'workflow_sla_deadline_history is append-only'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workflow_sla_deadline_history_immutable ON workflow_sla_deadline_history;
CREATE TRIGGER workflow_sla_deadline_history_immutable BEFORE UPDATE OR DELETE ON workflow_sla_deadline_history FOR EACH ROW EXECUTE FUNCTION forge_sla_deadline_history_immutable();
CREATE OR REPLACE FUNCTION forge_sla_record_deadline_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workflow_sla_deadline_history(id,job_id,run_id,version,deadline_at,stage_deadline_at,warning_at,reason,actor)
  VALUES(gen_random_uuid()::text,NEW.job_id,NEW.id,NEW.version*1000000+NEW.extension_count,NEW.run_deadline_at,NEW.stage_deadline_at,NEW.warning_at,CASE WHEN TG_OP='INSERT' THEN 'INITIAL' ELSE 'UPDATE' END,NEW.created_by);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workflow_sla_deadline_history_capture ON workflow_sla_runs;
CREATE TRIGGER workflow_sla_deadline_history_capture AFTER INSERT OR UPDATE OF run_deadline_at,stage_deadline_at,warning_at,extension_count ON workflow_sla_runs FOR EACH ROW EXECUTE FUNCTION forge_sla_record_deadline_history();
CREATE OR REPLACE FUNCTION forge_sla_deadline_open(job_id_in text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM workflow_sla_runs r WHERE r.job_id=job_id_in AND r.state='EXPIRED' AND r.completed_at IS NULL)
$$;
COMMIT;
