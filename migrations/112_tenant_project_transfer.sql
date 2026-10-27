BEGIN;

CREATE TABLE IF NOT EXISTS forge_transfer_exports (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','PARTIAL','SUCCEEDED','FAILED','CANCELLED')),
  idempotency_key text NOT NULL,
  created_by text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  chunk_size_bytes integer NOT NULL DEFAULT 8388608 CHECK (chunk_size_bytes > 0),
  chunk_count integer,
  archive_size_bytes bigint,
  archive_sha256 char(64),
  manifest_sha256 char(64),
  content_root_sha256 char(64),
  checkpoint jsonb NOT NULL DEFAULT '{}',
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS forge_transfer_exports_scope_idx ON forge_transfer_exports(tenant_id,project_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_transfer_imports (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  target_project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('VALIDATING','QUARANTINED','READY','APPROVED','APPLYING','SUCCEEDED','FAILED','ROLLED_BACK')),
  idempotency_key text NOT NULL,
  created_by text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  package_sha256 char(64),
  manifest_sha256 char(64),
  content_root_sha256 char(64),
  chunk_size_bytes integer NOT NULL DEFAULT 8388608 CHECK (chunk_size_bytes > 0),
  chunk_count integer NOT NULL DEFAULT 0,
  checkpoint jsonb NOT NULL DEFAULT '{}',
  diagnostics jsonb NOT NULL DEFAULT '{}',
  lease_owner text,
  lease_until timestamptz,
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS forge_transfer_imports_scope_idx ON forge_transfer_imports(tenant_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_transfer_chunks (
  transfer_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('EXPORT','IMPORT','REPLAY')),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('READY','MISSING','CORRUPT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transfer_id,direction,ordinal),
  UNIQUE (transfer_id,direction,sha256)
);
CREATE INDEX IF NOT EXISTS forge_transfer_chunks_lookup_idx ON forge_transfer_chunks(transfer_id,direction,ordinal);

CREATE TABLE IF NOT EXISTS forge_transfer_identity_map (
  transfer_id text NOT NULL,
  table_name text NOT NULL,
  source_id text NOT NULL,
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transfer_id,table_name,source_id)
);
CREATE INDEX IF NOT EXISTS forge_transfer_identity_target_idx ON forge_transfer_identity_map(transfer_id,table_name,target_id);

CREATE TABLE IF NOT EXISTS forge_transfer_replays (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_job_id text NOT NULL REFERENCES forge_jobs(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  package_sha256 char(64) NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  content_root_sha256 char(64) NOT NULL,
  chunk_count integer NOT NULL CHECK (chunk_count > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_transfer_replays_scope_idx ON forge_transfer_replays(tenant_id,project_id,created_at DESC);

COMMIT;
