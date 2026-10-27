BEGIN;

CREATE TABLE IF NOT EXISTS forge_rights_records (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('ARTIFACT','VERSION')),
  target_id text NOT NULL,
  current_version_no integer NOT NULL DEFAULT 1 CHECK (current_version_no > 0),
  review_state text NOT NULL DEFAULT 'DRAFT' CHECK (review_state IN ('DRAFT','APPROVED','HOLD','REVOKED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,target_type,target_id)
);
CREATE INDEX IF NOT EXISTS forge_rights_records_tenant_project_idx ON forge_rights_records(tenant_id,project_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS forge_rights_records_target_idx ON forge_rights_records(target_type,target_id);

CREATE TABLE IF NOT EXISTS forge_rights_versions (
  id text PRIMARY KEY,
  rights_record_id text NOT NULL REFERENCES forge_rights_records(id) ON DELETE RESTRICT,
  version_no integer NOT NULL CHECK (version_no > 0),
  owner text NOT NULL,
  licensor text,
  license_type text NOT NULL,
  permitted_uses jsonb NOT NULL DEFAULT '[]'::jsonb,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  territories jsonb NOT NULL DEFAULT '[]'::jsonb,
  destinations jsonb NOT NULL DEFAULT '[]'::jsonb,
  valid_from timestamptz,
  expires_at timestamptz,
  embargo_until timestamptz,
  timezone text NOT NULL DEFAULT 'UTC',
  seat_limit integer CHECK (seat_limit IS NULL OR seat_limit > 0),
  usage_limit integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  derivative_allowed boolean NOT NULL DEFAULT false,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  canonical_hash char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rights_record_id,version_no),
  UNIQUE (rights_record_id,canonical_hash),
  CHECK (expires_at IS NULL OR valid_from IS NULL OR expires_at > valid_from),
  CHECK (embargo_until IS NULL OR valid_from IS NULL OR embargo_until >= valid_from),
  CHECK (jsonb_typeof(permitted_uses)='array' AND jsonb_typeof(territories)='array' AND jsonb_typeof(destinations)='array' AND jsonb_typeof(evidence_refs)='array')
);
CREATE INDEX IF NOT EXISTS forge_rights_versions_record_idx ON forge_rights_versions(rights_record_id,version_no DESC);
CREATE INDEX IF NOT EXISTS forge_rights_versions_expiry_idx ON forge_rights_versions(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS forge_rights_actions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  rights_record_id text REFERENCES forge_rights_records(id) ON DELETE RESTRICT,
  rights_version_id text REFERENCES forge_rights_versions(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('CREATE','REPLACE','APPROVE','RENEW','HOLD','RELEASE_HOLD','REVOKE','OVERRIDE','SNAPSHOT','IMPORT','DELETE_REQUEST')),
  actor text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_rights_actions_scope_idx ON forge_rights_actions(tenant_id,project_id,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_rights_snapshots (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  execution_type text NOT NULL CHECK (execution_type IN ('PACKAGE','PUBLISH','EXPORT','REPLAY')),
  execution_id text NOT NULL,
  package_artifact_id text,
  package_version_id text,
  render_artifact_id text,
  render_version_id text,
  destination text,
  territory text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  decision text NOT NULL CHECK (decision IN ('ALLOW','BLOCK','OVERRIDE')),
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved_rights jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash char(64) NOT NULL,
  override_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (execution_type,execution_id)
);
CREATE INDEX IF NOT EXISTS forge_rights_snapshots_scope_idx ON forge_rights_snapshots(tenant_id,project_id,episode_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS forge_rights_snapshots_hash_idx ON forge_rights_snapshots(content_hash);

CREATE TABLE IF NOT EXISTS forge_rights_usage (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  rights_version_id text NOT NULL REFERENCES forge_rights_versions(id) ON DELETE RESTRICT,
  execution_id text NOT NULL,
  destination text NOT NULL,
  state text NOT NULL CHECK (state IN ('RESERVED','CONSUMED','RELEASED')),
  reserved_until timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rights_version_id,execution_id,destination)
);
CREATE INDEX IF NOT EXISTS forge_rights_usage_active_idx ON forge_rights_usage(rights_version_id,state,reserved_until);

CREATE TABLE IF NOT EXISTS forge_rights_overrides (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  rights_snapshot_id text NOT NULL REFERENCES forge_rights_snapshots(id) ON DELETE RESTRICT,
  destination text NOT NULL,
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  approved_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS forge_rights_overrides_active_idx ON forge_rights_overrides(tenant_id,project_id,episode_id,destination,expires_at);

ALTER TABLE publish_runs ADD COLUMN IF NOT EXISTS rights_snapshot_id text REFERENCES forge_rights_snapshots(id) ON DELETE RESTRICT;
ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS rights_snapshot_id text REFERENCES forge_rights_snapshots(id) ON DELETE RESTRICT;
ALTER TABLE episode_packages ADD COLUMN IF NOT EXISTS rights_snapshot_id text REFERENCES forge_rights_snapshots(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION forge_rights_normalize_scope(input jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE((SELECT jsonb_agg(DISTINCT lower(trim(value)) ORDER BY lower(trim(value))) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(input)='array' THEN input ELSE '[]'::jsonb END) value), '[]'::jsonb)
$$;

CREATE OR REPLACE FUNCTION forge_rights_collect_artifacts(p_episode_id text,p_root_artifact_id text)
RETURNS TABLE(artifact_id text,version_id text,is_root boolean) LANGUAGE sql STABLE AS $$
WITH RECURSIVE version_closure(id) AS (
  SELECT a.version_id FROM artifacts a WHERE a.id=p_root_artifact_id AND a.episode_id=p_episode_id
  UNION
  SELECT vd.depends_on_version_id FROM version_dependencies vd JOIN version_closure vc ON vc.id=vd.version_id WHERE vd.episode_id=p_episode_id
), artifact_seed(id) AS (
  SELECT a.id FROM artifacts a WHERE a.episode_id=p_episode_id AND a.version_id IN (SELECT id FROM version_closure)
  UNION
  SELECT p_root_artifact_id
), artifact_closure(id) AS (
  SELECT id FROM artifact_seed
  UNION
  SELECT md.source_artifact_id FROM media_derivatives md JOIN artifact_closure ac ON ac.id=md.artifact_id
), dedup AS (
  SELECT a.id,a.version_id FROM artifacts a JOIN artifact_closure ac ON ac.id=a.id WHERE a.episode_id=p_episode_id
)
SELECT d.id,d.version_id,(d.id=p_root_artifact_id) FROM dedup d;
$$;

CREATE OR REPLACE FUNCTION forge_rights_resolve(p_episode_id text,p_root_artifact_id text,p_use text,p_destination text,p_territory text,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  missing jsonb := '[]'::jsonb;
  diagnostics jsonb := '[]'::jsonb;
  resolved jsonb := '[]'::jsonb;
  row record;
  rv record;
  uses jsonb;
  territories jsonb;
  destinations jsonb;
  effective_until timestamptz := NULL;
  max_embargo timestamptz := NULL;
  root_found boolean := false;
  conflict boolean := false;
  derived_block boolean := false;
  usage_count integer;
BEGIN
  FOR row IN SELECT * FROM forge_rights_collect_artifacts(p_episode_id,p_root_artifact_id) LOOP
    IF row.is_root THEN root_found := true; END IF;
    SELECT r.id AS record_id,r.review_state,v.* INTO rv
      FROM forge_rights_records r JOIN forge_rights_versions v ON v.rights_record_id=r.id AND v.version_no=r.current_version_no
      WHERE r.project_id=(SELECT project_id FROM episodes WHERE id=p_episode_id) AND ((r.target_type='ARTIFACT' AND r.target_id=row.artifact_id) OR (r.target_type='VERSION' AND r.target_id=row.version_id))
      ORDER BY CASE WHEN r.target_type='ARTIFACT' THEN 0 ELSE 1 END LIMIT 1;
    IF rv.record_id IS NULL THEN
      missing := missing || jsonb_build_array(jsonb_build_object('code','RIGHTS_MISSING','artifactId',row.artifact_id,'versionId',row.version_id));
      CONTINUE;
    END IF;
    IF rv.review_state <> 'APPROVED' THEN
      diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_NOT_APPROVED','artifactId',row.artifact_id,'state',rv.review_state));
    END IF;
    IF rv.valid_from IS NOT NULL AND p_at < rv.valid_from THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_NOT_YET_EFFECTIVE','artifactId',row.artifact_id,'validFrom',rv.valid_from)); END IF;
    IF rv.expires_at IS NOT NULL AND p_at >= rv.expires_at THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_EXPIRED','artifactId',row.artifact_id,'expiresAt',rv.expires_at)); END IF;
    IF rv.embargo_until IS NOT NULL AND p_at < rv.embargo_until THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_EMBARGOED','artifactId',row.artifact_id,'embargoUntil',rv.embargo_until)); END IF;
    IF NOT (rv.permitted_uses ? lower(p_use)) THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_USE_DENIED','artifactId',row.artifact_id,'use',lower(p_use))); END IF;
    territories := forge_rights_normalize_scope(rv.territories); destinations := forge_rights_normalize_scope(rv.destinations); uses := forge_rights_normalize_scope(rv.permitted_uses);
    IF jsonb_array_length(territories)>0 AND NOT (territories ? lower(p_territory)) AND NOT (territories ? 'global') THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_TERRITORY_DENIED','artifactId',row.artifact_id,'territory',lower(p_territory))); END IF;
    IF jsonb_array_length(destinations)>0 AND NOT (destinations ? lower(p_destination)) AND NOT (destinations ? 'all') THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_DESTINATION_DENIED','artifactId',row.artifact_id,'destination',lower(p_destination))); END IF;
    IF NOT row.is_root AND NOT rv.derivative_allowed THEN derived_block := true; diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_DERIVATIVE_DENIED','artifactId',row.artifact_id)); END IF;
    IF rv.expires_at IS NOT NULL AND (effective_until IS NULL OR rv.expires_at<effective_until) THEN effective_until:=rv.expires_at; END IF;
    IF rv.embargo_until IS NOT NULL AND (max_embargo IS NULL OR rv.embargo_until>max_embargo) THEN max_embargo:=rv.embargo_until; END IF;
    SELECT count(*)::int INTO usage_count FROM forge_rights_usage u WHERE u.rights_version_id=rv.id AND u.destination=lower(p_destination) AND u.state IN ('RESERVED','CONSUMED') AND (u.state='CONSUMED' OR u.reserved_until>p_at);
    IF rv.usage_limit IS NOT NULL AND usage_count >= rv.usage_limit THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_USAGE_LIMIT','artifactId',row.artifact_id,'limit',rv.usage_limit,'used',usage_count)); END IF;
    resolved := resolved || jsonb_build_array(jsonb_build_object('artifactId',row.artifact_id,'versionId',row.version_id,'rightsVersionId',rv.id,'recordId',rv.record_id,'licenseType',rv.license_type,'owner',rv.owner,'licensor',rv.licensor,'permittedUses',uses,'territories',territories,'destinations',destinations,'expiresAt',rv.expires_at,'embargoUntil',rv.embargo_until,'derivativeAllowed',rv.derivative_allowed,'usageLimit',rv.usage_limit,'seatLimit',rv.seat_limit,'attribution',rv.attribution,'evidenceRefs',rv.evidence_refs,'providerMetadata',rv.provider_metadata));
  END LOOP;
  IF NOT root_found THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','ROOT_ARTIFACT_NOT_FOUND','artifactId',p_root_artifact_id)); END IF;
  IF jsonb_array_length(missing)>0 THEN diagnostics := diagnostics || missing; END IF;
  IF jsonb_array_length(resolved)=0 THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_RESOLUTION_EMPTY')); END IF;
  RETURN jsonb_build_object('decision',CASE WHEN jsonb_array_length(diagnostics)=0 THEN 'ALLOW' ELSE 'BLOCK' END,'diagnostics',diagnostics,'resolved',resolved,'effectiveUntil',effective_until,'embargoUntil',max_embargo,'conflict',conflict,'derivativeBlocked',derived_block);
END;
$$;

CREATE OR REPLACE FUNCTION forge_rights_snapshot_package() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; result jsonb; hash char(64); snapshot_id text;
BEGIN
  SELECT ep.project_id,p.tenant_id INTO e FROM episodes ep JOIN projects p ON p.id=ep.project_id WHERE ep.id=NEW.episode_id;
  IF e.project_id IS NULL THEN RAISE EXCEPTION 'rights compliance: package episode scope missing' USING ERRCODE='P0001'; END IF;
  result := forge_rights_resolve(NEW.episode_id,NEW.final_media_artifact_id,'PACKAGE','package','global',now());
  hash := encode(digest(result::text,'sha256'),'hex'); snapshot_id := 'rights-package:'||NEW.id;
  IF result->>'decision' <> 'ALLOW' THEN RAISE EXCEPTION 'rights compliance blocked packaging: %',result->'diagnostics' USING ERRCODE='P0001',DETAIL='RIGHTS_COMPLIANCE_BLOCKED'; END IF;
  INSERT INTO forge_rights_snapshots(id,tenant_id,project_id,episode_id,execution_type,execution_id,package_artifact_id,package_version_id,render_artifact_id,render_version_id,observed_at,effective_until,decision,diagnostics,resolved_rights,content_hash)
  VALUES(snapshot_id,e.tenant_id,e.project_id,NEW.episode_id,'PACKAGE',NEW.id,NEW.id,NEW.version_id,NEW.final_media_artifact_id,NEW.final_media_version_id,now(),NULL,'ALLOW',result->'diagnostics',result->'resolved',hash)
  ON CONFLICT(execution_type,execution_id) DO NOTHING;
  NEW.rights_snapshot_id:=snapshot_id; RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_episode_package_rights_gate ON episode_packages;
CREATE TRIGGER forge_episode_package_rights_gate BEFORE INSERT ON episode_packages FOR EACH ROW EXECUTE FUNCTION forge_rights_snapshot_package();

CREATE OR REPLACE FUNCTION forge_rights_require_publish_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM forge_rights_snapshots WHERE id=NEW.rights_snapshot_id AND execution_type='PUBLISH' AND decision IN ('ALLOW','OVERRIDE');
  IF s.id IS NULL OR s.tenant_id<>NEW.tenant_id OR s.project_id<>NEW.project_id OR s.episode_id<>NEW.episode_id THEN RAISE EXCEPTION 'rights compliance: publish request requires a matching rights snapshot' USING ERRCODE='P0001',DETAIL='RIGHTS_SNAPSHOT_REQUIRED'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_publish_request_rights_gate ON publish_requests;
CREATE TRIGGER forge_publish_request_rights_gate BEFORE INSERT OR UPDATE OF rights_snapshot_id ON publish_requests FOR EACH ROW EXECUTE FUNCTION forge_rights_require_publish_request();

CREATE OR REPLACE FUNCTION forge_rights_consume_publish_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE forge_rights_usage u SET state='CONSUMED',consumed_at=now() WHERE u.execution_id=(SELECT id FROM forge_rights_snapshots WHERE id=(SELECT rights_snapshot_id FROM publish_requests WHERE id=NEW.request_id)) AND u.state='RESERVED';
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS forge_publish_receipt_consume_rights ON publish_receipts;
CREATE TRIGGER forge_publish_receipt_consume_rights AFTER INSERT ON publish_receipts FOR EACH ROW EXECUTE FUNCTION forge_rights_consume_publish_receipt();

COMMIT;
