BEGIN;

CREATE TABLE IF NOT EXISTS forge_release_plans (
  release_id text PRIMARY KEY REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  tenant_id text,
  project_id text,
  candidate_id text NOT NULL,
  plan_hash char(64) NOT NULL,
  rollout_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  health_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','APPROVED','RUNNING','PAUSED','ABORTED','HALTED','ROLLING_BACK','ROLLED_BACK','COMPLETED','FAILED')),
  deployment_epoch bigint NOT NULL DEFAULT 0,
  current_stage integer NOT NULL DEFAULT 0,
  target_stage integer NOT NULL DEFAULT 0,
  abort_reason text,
  rollback_reason text,
  rollback_target_release_id text REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  rollback_target_candidate_id text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forge_release_candidates (
  candidate_id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  tenant_id text,
  project_id text,
  artifact_id text NOT NULL,
  artifact_version_id text NOT NULL,
  content_hash char(64) NOT NULL,
  provenance_hash char(64) NOT NULL,
  manifest_hash char(64) NOT NULL,
  immutable_snapshot jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_id, artifact_id, artifact_version_id)
);
ALTER TABLE forge_release_plans ADD CONSTRAINT forge_release_plans_rollback_candidate_fk FOREIGN KEY (rollback_target_candidate_id) REFERENCES forge_release_candidates(candidate_id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS forge_release_stages (
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  stage_index integer NOT NULL CHECK (stage_index >= 0),
  name text NOT NULL,
  rollout_percent numeric(5,2) NOT NULL CHECK (rollout_percent > 0 AND rollout_percent <= 100),
  batch_size integer NOT NULL CHECK (batch_size > 0),
  observation_seconds integer NOT NULL DEFAULT 300 CHECK (observation_seconds >= 0),
  health_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','PASSED','HALTED','ABORTED','ROLLED_BACK')),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(release_id, stage_index)
);

CREATE TABLE IF NOT EXISTS forge_release_health_samples (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  deployment_epoch bigint NOT NULL,
  stage_index integer NOT NULL,
  source text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('PASS','FAIL','UNKNOWN')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  sample_hash char(64) NOT NULL,
  UNIQUE(release_id, deployment_epoch, stage_index, source, sample_hash)
);

CREATE TABLE IF NOT EXISTS forge_release_provider_publications (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  deployment_epoch bigint NOT NULL,
  stage_index integer NOT NULL,
  tenant_id text,
  project_id text,
  provider text NOT NULL,
  artifact_id text NOT NULL,
  artifact_version_id text NOT NULL,
  idempotency_key text NOT NULL,
  provider_ref text,
  status text NOT NULL CHECK (status IN ('PENDING','PUBLISHING','PUBLISHED','FAILED','ROLLING_BACK','ROLLED_BACK','UNKNOWN')),
  callback_id text,
  provider_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, idempotency_key),
  UNIQUE(provider, callback_id)
);

CREATE TABLE IF NOT EXISTS forge_release_progressive_approvals (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  stage_index integer NOT NULL,
  actor text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forge_release_events (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  deployment_epoch bigint NOT NULL,
  stage_index integer,
  actor text NOT NULL,
  action text NOT NULL,
  from_state text,
  to_state text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_release_events_release_idx ON forge_release_events(release_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_release_health_samples_idx ON forge_release_health_samples(release_id, deployment_epoch, stage_index, observed_at DESC);
CREATE INDEX IF NOT EXISTS forge_release_provider_publications_idx ON forge_release_provider_publications(release_id, deployment_epoch, stage_index, status);
CREATE INDEX IF NOT EXISTS forge_release_plans_rollback_target_idx ON forge_release_plans(rollback_target_release_id, rollback_target_candidate_id);

CREATE OR REPLACE FUNCTION forge_release_plan_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.release_id IS DISTINCT FROM NEW.release_id OR OLD.candidate_id IS DISTINCT FROM NEW.candidate_id OR OLD.plan_hash IS DISTINCT FROM NEW.plan_hash OR OLD.rollout_policy IS DISTINCT FROM NEW.rollout_policy OR OLD.health_policy IS DISTINCT FROM NEW.health_policy OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'Release plan immutable evidence cannot be rewritten' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_release_plan_immutable ON forge_release_plans;
CREATE TRIGGER forge_release_plan_immutable BEFORE UPDATE ON forge_release_plans FOR EACH ROW EXECUTE FUNCTION forge_release_plan_immutable_guard();

CREATE OR REPLACE FUNCTION forge_release_candidate_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Release candidates are immutable' USING ERRCODE='P0001'; END; $$;
DROP TRIGGER IF EXISTS forge_release_candidate_immutable ON forge_release_candidates;
CREATE TRIGGER forge_release_candidate_immutable BEFORE UPDATE OR DELETE ON forge_release_candidates FOR EACH ROW EXECUTE FUNCTION forge_release_candidate_immutable_guard();

CREATE OR REPLACE FUNCTION forge_release_stage_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.release_id IS DISTINCT FROM NEW.release_id OR OLD.stage_index IS DISTINCT FROM NEW.stage_index OR OLD.name IS DISTINCT FROM NEW.name OR OLD.rollout_percent IS DISTINCT FROM NEW.rollout_percent OR OLD.batch_size IS DISTINCT FROM NEW.batch_size OR OLD.observation_seconds IS DISTINCT FROM NEW.observation_seconds OR OLD.health_policy IS DISTINCT FROM NEW.health_policy THEN
    RAISE EXCEPTION 'Release rollout stages are immutable' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_release_stage_immutable ON forge_release_stages;
CREATE TRIGGER forge_release_stage_immutable BEFORE UPDATE ON forge_release_stages FOR EACH ROW EXECUTE FUNCTION forge_release_stage_immutable_guard();

CREATE OR REPLACE FUNCTION forge_release_provider_callback_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF NEW.status IN ('PUBLISHED','FAILED','UNKNOWN','ROLLED_BACK') THEN
    SELECT * INTO p FROM forge_release_plans WHERE release_id=NEW.release_id;
    IF p.release_id IS NULL OR p.deployment_epoch<>NEW.deployment_epoch OR p.state IN ('ABORTED','ROLLED_BACK','FAILED') THEN
      RAISE EXCEPTION 'Stale release provider callback fenced' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_release_provider_callback_fence ON forge_release_provider_publications;
CREATE TRIGGER forge_release_provider_callback_fence BEFORE INSERT OR UPDATE ON forge_release_provider_publications FOR EACH ROW EXECUTE FUNCTION forge_release_provider_callback_fence();

COMMIT;
