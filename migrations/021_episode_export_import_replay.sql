BEGIN;
CREATE TABLE IF NOT EXISTS forge_bundle_imports (
  bundle_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  target_project_id text,
  status text NOT NULL CHECK (status IN ('VALIDATING','QUARANTINED','APPLYING','SUCCEEDED','PARTIAL','FAILED')),
  manifest_sha256 char(64),
  schema_version integer NOT NULL,
  source_tenant_fingerprint char(64),
  actor text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_bundle_imports_tenant_idx ON forge_bundle_imports(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_bundle_imports_manifest_idx ON forge_bundle_imports(manifest_sha256);
CREATE TABLE IF NOT EXISTS forge_replay_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  stage_kind text NOT NULL,
  source_job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  source_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  fixture jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_digest char(64) NOT NULL,
  output_digest char(64),
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  side_effects_suppressed boolean NOT NULL DEFAULT true,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_replay_runs_idempotency_idx ON forge_replay_runs(tenant_id, episode_id, stage_kind, input_digest);
CREATE INDEX IF NOT EXISTS forge_replay_runs_episode_idx ON forge_replay_runs(episode_id, created_at DESC);
COMMIT;
