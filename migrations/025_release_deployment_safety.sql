BEGIN;

ALTER TABLE forge_release_manifests
  ADD COLUMN IF NOT EXISTS migration_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS worker_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS protocol_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS config_snapshot_hash char(64),
  ADD COLUMN IF NOT EXISTS required_protocol_version text NOT NULL DEFAULT '1',
  ADD COLUMN IF NOT EXISTS rollout_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS health_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE forge_jobs
  ADD COLUMN IF NOT EXISTS required_release_id text,
  ADD COLUMN IF NOT EXISTS required_release_epoch bigint,
  ADD COLUMN IF NOT EXISTS required_schema_version text,
  ADD COLUMN IF NOT EXISTS required_protocol_version text;

ALTER TABLE forge_execution_runs
  ADD COLUMN IF NOT EXISTS release_id text,
  ADD COLUMN IF NOT EXISTS release_epoch bigint;

CREATE TABLE IF NOT EXISTS forge_release_deployment_checks (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  check_key text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('PREFLIGHT','MIGRATION','ROLLOUT','HEALTH','RECOVERY')),
  status text NOT NULL CHECK (status IN ('PENDING','PASSED','FAILED','BLOCKED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  check_hash char(64),
  attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_id, check_key, attempt)
);
CREATE INDEX IF NOT EXISTS forge_release_deployment_checks_release_idx ON forge_release_deployment_checks(release_id, phase, status, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_release_audit (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  actor text NOT NULL,
  action text NOT NULL,
  from_state text,
  to_state text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_release_audit_release_idx ON forge_release_audit(release_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_migration_lock (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  release_id text REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  owner text,
  acquired_at timestamptz,
  expires_at timestamptz,
  state text NOT NULL DEFAULT 'FREE' CHECK (state IN ('FREE','HELD','DRAINING'))
);
INSERT INTO forge_migration_lock(id) VALUES(true) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS forge_release_recovery_checkpoints (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  checkpoint_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('READY','STARTED','COMPLETED','FAILED')),
  target_release_id text REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_id, checkpoint_key)
);

CREATE INDEX IF NOT EXISTS forge_execution_runs_release_epoch_idx ON forge_execution_runs(release_id, release_epoch, status);
CREATE INDEX IF NOT EXISTS forge_jobs_release_compatibility_idx ON forge_jobs(required_release_id, required_release_epoch, required_schema_version, required_protocol_version, status);

CREATE OR REPLACE FUNCTION forge_bind_job_release_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; m record;
BEGIN
  IF NEW.required_release_id IS NULL THEN
    SELECT active_release_id, epoch, state INTO s FROM forge_release_state WHERE id=true;
    IF s.active_release_id IS NOT NULL AND s.state IN ('DEPLOYING','DEPLOYED','DRAINING') THEN
      NEW.required_release_id := s.active_release_id;
      NEW.required_release_epoch := s.epoch;
      SELECT schema_version, required_protocol_version INTO m FROM forge_release_manifests WHERE release_id=s.active_release_id;
      NEW.required_schema_version := COALESCE(NEW.required_schema_version,m.schema_version);
      NEW.required_protocol_version := COALESCE(NEW.required_protocol_version,m.required_protocol_version);
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_job_release_binding ON forge_jobs;
CREATE TRIGGER forge_job_release_binding BEFORE INSERT ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_bind_job_release_epoch();

CREATE OR REPLACE FUNCTION forge_guard_job_release_compatibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; m record; allow_previous boolean;
BEGIN
  IF OLD.status IS DISTINCT FROM 'RUNNING' AND NEW.status='RUNNING' THEN
    SELECT active_release_id, epoch, state INTO s FROM forge_release_state WHERE id=true;
    IF s.active_release_id IS NOT NULL THEN
      SELECT * INTO m FROM forge_release_manifests WHERE release_id=s.active_release_id;
      IF m.release_id IS NULL OR s.state='ROLL_FORWARD_REQUIRED' THEN
        RAISE EXCEPTION 'No safe active release is available' USING ERRCODE='P0001';
      END IF;
      allow_previous := COALESCE((m.compatibility_window->>'allowPreviousEpoch')::boolean,false);
      IF NEW.required_release_epoch IS NOT NULL AND NEW.required_release_epoch<>s.epoch AND NOT allow_previous THEN
        RAISE EXCEPTION 'Job % belongs to stale release epoch % while active epoch is %', NEW.id, NEW.required_release_epoch, s.epoch USING ERRCODE='P0001';
      END IF;
      IF NEW.required_schema_version IS NOT NULL AND (NEW.required_schema_version < m.min_schema_version OR NEW.required_schema_version > m.max_schema_version) THEN
        RAISE EXCEPTION 'Job % schema version % is incompatible with release %', NEW.id, NEW.required_schema_version, s.active_release_id USING ERRCODE='P0001';
      END IF;
      IF NEW.required_protocol_version IS NOT NULL AND NEW.required_protocol_version<>m.required_protocol_version THEN
        RAISE EXCEPTION 'Job % protocol version % is incompatible with release %', NEW.id, NEW.required_protocol_version, s.active_release_id USING ERRCODE='P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_job_release_compatibility_guard ON forge_jobs;
CREATE TRIGGER forge_job_release_compatibility_guard BEFORE UPDATE OF status ON forge_jobs FOR EACH ROW EXECUTE FUNCTION forge_guard_job_release_compatibility();

CREATE OR REPLACE FUNCTION forge_guard_release_migration_workload() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_count integer; unsafe boolean;
BEGIN
  IF NEW.status='DEPLOYING' AND OLD.status IS DISTINCT FROM 'DEPLOYING' THEN
    SELECT count(*) INTO active_count FROM forge_jobs WHERE status='RUNNING';
    unsafe := EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.migration_manifest,'[]'::jsonb)) x WHERE COALESCE((x->>'unsafe')::boolean,false)=true);
    IF unsafe AND active_count>0 AND NOT COALESCE((NEW.rollout_policy->>'allowUnsafeWithActiveWorkload')::boolean,false) THEN
      RAISE EXCEPTION 'Unsafe release migration cannot start with % active jobs', active_count USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_release_migration_workload_guard ON forge_release_manifests;
CREATE TRIGGER forge_release_migration_workload_guard BEFORE UPDATE OF status ON forge_release_manifests FOR EACH ROW EXECUTE FUNCTION forge_guard_release_migration_workload();

COMMIT;
