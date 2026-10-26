-- Production workflow domain: research provenance, channels/styles, timeline snapshots, storage lifecycle and publishing reconciliation.
BEGIN;

CREATE TABLE IF NOT EXISTS channels (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name text NOT NULL,
  destination text NOT NULL DEFAULT 'youtube',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS channels_project_idx ON channels(project_id);

ALTER TABLE episodes ADD CONSTRAINT episodes_channel_fk
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS style_profiles (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  name text NOT NULL,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS research_packages (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SOURCED','REVIEWED','ACCEPTED','REJECTED')),
  notes text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_packages_episode_idx ON research_packages(episode_id, created_at DESC);

CREATE TABLE IF NOT EXISTS research_sources (
  id text PRIMARY KEY,
  package_id text NOT NULL REFERENCES research_packages(id) ON DELETE RESTRICT,
  url text NOT NULL,
  title text NOT NULL DEFAULT '',
  publisher text NOT NULL DEFAULT '',
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  content_hash char(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS research_sources_package_idx ON research_sources(package_id);

CREATE TABLE IF NOT EXISTS research_claims (
  id text PRIMARY KEY,
  package_id text NOT NULL REFERENCES research_packages(id) ON DELETE RESTRICT,
  claim text NOT NULL,
  status text NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN ('DISCOVERED','SOURCED','REVIEWED','ACCEPTED','CONTESTED','REJECTED')),
  source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS research_claims_package_idx ON research_claims(package_id);

CREATE TABLE IF NOT EXISTS timeline_snapshots (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  timeline jsonb NOT NULL,
  duration_seconds numeric(12,3) NOT NULL CHECK (duration_seconds >= 0),
  content_hash char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timeline_snapshots_episode_idx ON timeline_snapshots(episode_id, created_at DESC);

CREATE TABLE IF NOT EXISTS storage_objects (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  artifact_id text REFERENCES artifacts(id) ON DELETE RESTRICT,
  uri text NOT NULL,
  content_hash char(64),
  media_type text,
  size_bytes bigint CHECK (size_bytes >= 0),
  retention_class text NOT NULL DEFAULT 'HOT' CHECK (retention_class IN ('HOT','WARM','COLD','EXPIRABLE')),
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS storage_objects_uri_idx ON storage_objects(uri);
CREATE INDEX IF NOT EXISTS storage_objects_retention_idx ON storage_objects(retention_class, expires_at);

CREATE TABLE IF NOT EXISTS publish_runs (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  render_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  render_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  destination text NOT NULL DEFAULT 'youtube',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','UPLOADING','PUBLISHED','FAILED','CANCELLED')),
  external_id text,
  external_url text,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  error jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS publish_runs_episode_idx ON publish_runs(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS publish_runs_external_idx ON publish_runs(destination, external_id);

CREATE TABLE IF NOT EXISTS project_members (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  role text NOT NULL DEFAULT 'EDITOR' CHECK (role IN ('OWNER','EDITOR','VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id, actor_id)
);

COMMIT;
