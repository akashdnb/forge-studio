CREATE TABLE IF NOT EXISTS forge_release_manifests (
  id text PRIMARY KEY,
  release_id text NOT NULL UNIQUE,
  commit_sha text NOT NULL,
  manifest_hash char(64) NOT NULL,
  app_version text NOT NULL,
  schema_version text NOT NULL,
  min_schema_version text NOT NULL,
  max_schema_version text NOT NULL,
  compatibility_window jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_indexes jsonb NOT NULL DEFAULT '[]'::jsonb,
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  worker_contracts jsonb NOT NULL DEFAULT '{}'::jsonb,
  dependency_requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  rollback_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','PREFLIGHT_PASSED','DEPLOYING','DEPLOYED','BLOCKED','ROLLED_BACK','ROLL_FORWARD_REQUIRED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_release_manifests_status_idx ON forge_release_manifests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_release_checkpoints (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  phase text NOT NULL CHECK (phase IN ('PREFLIGHT','MIGRATION','DEPLOY','POST_DEPLOY','ROLLBACK','ROLL_FORWARD')),
  status text NOT NULL CHECK (status IN ('STARTED','PASSED','FAILED','BLOCKED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_release_checkpoints_release_idx ON forge_release_checkpoints(release_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_schema_drift_snapshots (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL,
  schema_hash char(64) NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_schema_drift_release_idx ON forge_schema_drift_snapshots(release_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_worker_fences (
  worker_id text PRIMARY KEY,
  release_id text NOT NULL,
  app_version text NOT NULL,
  schema_version text NOT NULL,
  lease_epoch bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FENCED','DRAINING')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS forge_worker_fences_release_idx ON forge_worker_fences(release_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS forge_feature_flag_rollouts (
  flag text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  rollout_percent integer NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  min_release_id text,
  max_release_id text,
  safe_for_rollback boolean NOT NULL DEFAULT true,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forge_release_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  active_release_id text REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  previous_release_id text REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'STABLE' CHECK (state IN ('STABLE','DEPLOYING','DRAINING','ROLLBACK_INTERRUPTED','ROLL_FORWARD_REQUIRED')),
  epoch bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO forge_release_state(id) VALUES(true) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS forge_release_approvals (
  id bigserial PRIMARY KEY,
  release_id text NOT NULL REFERENCES forge_release_manifests(release_id) ON DELETE RESTRICT,
  actor text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_release_approvals_release_idx ON forge_release_approvals(release_id, created_at DESC);
