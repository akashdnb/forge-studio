CREATE TABLE IF NOT EXISTS artifact_lineage_edges (
  id bigserial PRIMARY KEY,
  tenant_id text,
  child_artifact_id text NOT NULL,
  parent_artifact_id text NOT NULL,
  relation text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(child_artifact_id, parent_artifact_id, relation)
);

CREATE INDEX IF NOT EXISTS artifact_lineage_edges_tenant_idx
  ON artifact_lineage_edges(tenant_id, child_artifact_id, parent_artifact_id);
