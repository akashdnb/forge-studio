CREATE TABLE IF NOT EXISTS forge_release_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  previous_release_id text,
  active_release_id text,
  state text NOT NULL DEFAULT 'IDLE',
  epoch bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO forge_release_state(id) VALUES (true) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS forge_jobs (id text PRIMARY KEY, status text NOT NULL, worker_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS storage_objects (artifact_id text PRIMARY KEY, status text NOT NULL DEFAULT 'READY', storage_key text, size_bytes bigint, content_hash text, encryption_mode text NOT NULL DEFAULT 'NONE', encryption_key_id text, integrity_manifest_id bigint);
CREATE TABLE IF NOT EXISTS forge_release_manifests (id text PRIMARY KEY, release_id text NOT NULL UNIQUE, commit_sha text NOT NULL, manifest_hash text NOT NULL, app_version text NOT NULL, schema_version text NOT NULL, min_schema_version text NOT NULL, max_schema_version text NOT NULL, compatibility_window jsonb NOT NULL DEFAULT '{}'::jsonb, required_config jsonb NOT NULL DEFAULT '{}'::jsonb, required_indexes jsonb NOT NULL DEFAULT '[]'::jsonb, feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb, worker_contracts jsonb NOT NULL DEFAULT '{}'::jsonb, dependency_requirements jsonb NOT NULL DEFAULT '{}'::jsonb, rollback_policy jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'CREATED', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS forge_release_manifests_status_idx ON forge_release_manifests(status);
CREATE TABLE IF NOT EXISTS forge_release_approvals (id bigserial PRIMARY KEY, release_id text NOT NULL, actor text NOT NULL, decision text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS forge_release_checkpoints (id bigserial PRIMARY KEY, release_id text NOT NULL, phase text NOT NULL, status text NOT NULL, evidence jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS forge_worker_fences (worker_id text PRIMARY KEY, release_id text NOT NULL, app_version text NOT NULL, schema_version text NOT NULL, status text NOT NULL, lease_epoch bigint NOT NULL DEFAULT 0, last_seen_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE INDEX IF NOT EXISTS forge_worker_fences_release_idx ON forge_worker_fences(release_id);
CREATE TABLE IF NOT EXISTS forge_feature_flag_rollouts (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, rollout_percent integer NOT NULL DEFAULT 0, min_release_id text, max_release_id text, safe_for_rollback boolean NOT NULL DEFAULT true, updated_by text NOT NULL DEFAULT 'system', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS forge_schema_drift_snapshots (id bigserial PRIMARY KEY, release_id text NOT NULL, schema_hash text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS forge_schema_drift_snapshots_release_idx ON forge_schema_drift_snapshots(release_id);
