BEGIN;

CREATE TABLE IF NOT EXISTS forge_rights_retention_tombstones (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text NOT NULL,
  legal_hold boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_rights_retention_scope_idx ON forge_rights_retention_tombstones(tenant_id,project_id,created_at DESC);

CREATE OR REPLACE VIEW forge_rights_compliance_export AS
SELECT s.id AS snapshot_id,s.tenant_id,s.project_id,s.episode_id,s.execution_type,s.execution_id,s.package_artifact_id,s.package_version_id,s.render_artifact_id,s.render_version_id,s.destination,s.territory,s.observed_at,s.effective_until,s.decision,s.diagnostics,s.resolved_rights,s.content_hash,s.override_evidence
FROM forge_rights_snapshots s;

CREATE OR REPLACE FUNCTION forge_rights_replay_snapshot(p_snapshot_id text,p_tenant_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM forge_rights_snapshots WHERE id=p_snapshot_id AND tenant_id=p_tenant_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'rights snapshot not found' USING ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('snapshotId',s.id,'tenantId',s.tenant_id,'projectId',s.project_id,'episodeId',s.episode_id,'executionType',s.execution_type,'executionId',s.execution_id,'destination',s.destination,'territory',s.territory,'decision',s.decision,'observedAt',s.observed_at,'effectiveUntil',s.effective_until,'diagnostics',s.diagnostics,'resolvedRights',s.resolved_rights,'contentHash',s.content_hash,'overrideEvidence',s.override_evidence);
END;
$$;

COMMIT;
