BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS forge_evidence_nodes (
  node_id char(64) PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  node_type text NOT NULL,
  source_id text NOT NULL,
  content_digest char(64) NOT NULL,
  lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, node_type, source_id),
  CHECK (node_id = encode(digest('forge-evidence-node:v1|' || tenant_id || '|' || project_id || '|' || node_type || '|' || source_id || '|' || content_digest, 'sha256'), 'hex'))
);
CREATE INDEX IF NOT EXISTS forge_evidence_nodes_scope_idx ON forge_evidence_nodes(tenant_id, project_id, node_type, source_id);

CREATE TABLE IF NOT EXISTS forge_evidence_edges (
  edge_id char(64) PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  source_node_id char(64) NOT NULL REFERENCES forge_evidence_nodes(node_id) ON DELETE RESTRICT,
  relation text NOT NULL,
  target_node_id char(64) NOT NULL REFERENCES forge_evidence_nodes(node_id) ON DELETE RESTRICT,
  evidence_digest char(64) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_node_id, relation, target_node_id, evidence_digest),
  CHECK (edge_id = encode(digest('forge-evidence-edge:v1|' || source_node_id || '|' || relation || '|' || target_node_id || '|' || evidence_digest, 'sha256'), 'hex')),
  CHECK (source_node_id <> target_node_id)
);
CREATE INDEX IF NOT EXISTS forge_evidence_edges_scope_idx ON forge_evidence_edges(tenant_id, project_id, source_node_id);
CREATE INDEX IF NOT EXISTS forge_evidence_edges_target_idx ON forge_evidence_edges(tenant_id, project_id, target_node_id);

CREATE TABLE IF NOT EXISTS forge_evidence_reconciliation_runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('READ_ONLY','REPAIR_PLAN')),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  checked_nodes bigint NOT NULL DEFAULT 0,
  checked_edges bigint NOT NULL DEFAULT 0,
  issue_count bigint NOT NULL DEFAULT 0,
  report_hash char(64),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_evidence_reconciliation_scope_idx ON forge_evidence_reconciliation_runs(tenant_id, project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS forge_evidence_snapshots (
  snapshot_id char(64) PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  version_id text REFERENCES version_records(id) ON DELETE RESTRICT,
  snapshot_digest char(64) NOT NULL UNIQUE,
  graph jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (snapshot_id = encode(digest('forge-evidence-snapshot:v1|' || tenant_id || '|' || project_id || '|' || coalesce(episode_id, '') || '|' || coalesce(version_id, '') || '|' || snapshot_digest, 'sha256'), 'hex'))
);
CREATE INDEX IF NOT EXISTS forge_evidence_snapshots_scope_idx ON forge_evidence_snapshots(tenant_id, project_id, created_at DESC);

CREATE OR REPLACE FUNCTION forge_evidence_node_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'evidence nodes are immutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_evidence_node_immutable_guard ON forge_evidence_nodes;
CREATE TRIGGER forge_evidence_node_immutable_guard BEFORE UPDATE OR DELETE ON forge_evidence_nodes FOR EACH ROW EXECUTE FUNCTION forge_evidence_node_immutable();

CREATE OR REPLACE FUNCTION forge_evidence_edge_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'evidence edges are immutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_evidence_edge_immutable_guard ON forge_evidence_edges;
CREATE TRIGGER forge_evidence_edge_immutable_guard BEFORE UPDATE OR DELETE ON forge_evidence_edges FOR EACH ROW EXECUTE FUNCTION forge_evidence_edge_immutable();

CREATE OR REPLACE FUNCTION forge_evidence_scope_guard() RETURNS trigger AS $$
DECLARE source_scope record; target_scope record;
BEGIN
  SELECT tenant_id, project_id INTO source_scope FROM forge_evidence_nodes WHERE node_id = NEW.source_node_id FOR SHARE;
  SELECT tenant_id, project_id INTO target_scope FROM forge_evidence_nodes WHERE node_id = NEW.target_node_id FOR SHARE;
  IF source_scope IS NULL OR target_scope IS NULL THEN RAISE EXCEPTION 'evidence edge references missing node'; END IF;
  IF source_scope.tenant_id <> NEW.tenant_id OR source_scope.project_id <> NEW.project_id OR target_scope.tenant_id <> NEW.tenant_id OR target_scope.project_id <> NEW.project_id THEN RAISE EXCEPTION 'cross-tenant or cross-project evidence edge rejected'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_evidence_edge_scope_guard ON forge_evidence_edges;
CREATE TRIGGER forge_evidence_edge_scope_guard BEFORE INSERT ON forge_evidence_edges FOR EACH ROW EXECUTE FUNCTION forge_evidence_scope_guard();

COMMIT;
