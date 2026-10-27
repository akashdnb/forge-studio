BEGIN;

CREATE TABLE IF NOT EXISTS forge_version_diffs (
  report_id text PRIMARY KEY,
  report_identity char(64) NOT NULL UNIQUE,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  target_version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED')),
  report_hash char(64),
  snapshot_hash char(64),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error jsonb,
  UNIQUE (episode_id, source_version_id, target_version_id, schema_version)
);
CREATE INDEX IF NOT EXISTS forge_version_diffs_episode_created_idx ON forge_version_diffs(episode_id, created_at DESC, report_id DESC);
CREATE INDEX IF NOT EXISTS forge_version_diffs_project_created_idx ON forge_version_diffs(project_id, created_at DESC, report_id DESC);

CREATE TABLE IF NOT EXISTS forge_version_diff_items (
  report_id text NOT NULL REFERENCES forge_version_diffs(report_id) ON DELETE RESTRICT,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  item_id char(64) NOT NULL,
  category text NOT NULL,
  path text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('ADDED','REMOVED','CHANGED')),
  source_id text,
  target_id text,
  before_value jsonb,
  after_value jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (report_id, ordinal),
  UNIQUE (report_id, item_id)
);
CREATE INDEX IF NOT EXISTS forge_version_diff_items_page_idx ON forge_version_diff_items(report_id, ordinal);
CREATE INDEX IF NOT EXISTS forge_version_diff_items_category_idx ON forge_version_diff_items(report_id, category, ordinal);

CREATE INDEX IF NOT EXISTS forge_version_diffs_source_target_idx ON forge_version_diffs(source_version_id, target_version_id, created_at DESC);

COMMIT;
