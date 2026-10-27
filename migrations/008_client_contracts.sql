BEGIN;

CREATE TABLE IF NOT EXISTS forge_client_contract_revisions (
  id text PRIMARY KEY,
  contract_version text NOT NULL,
  api_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','ROLLED_BACK','REJECTED')),
  source_commit text,
  route_count integer NOT NULL DEFAULT 0,
  contract_fingerprint char(64) NOT NULL,
  compatibility_fingerprint char(64) NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  published_by text,
  previous_revision_id text REFERENCES forge_client_contract_revisions(id) ON DELETE RESTRICT,
  compatibility_decision_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(contract_version, api_version, contract_fingerprint)
);

CREATE INDEX IF NOT EXISTS forge_client_contract_revisions_api_idx
  ON forge_client_contract_revisions(api_version, generated_at DESC);
CREATE INDEX IF NOT EXISTS forge_client_contract_revisions_status_idx
  ON forge_client_contract_revisions(status, published_at DESC);

CREATE TABLE IF NOT EXISTS forge_client_contract_routes (
  revision_id text NOT NULL REFERENCES forge_client_contract_revisions(id) ON DELETE CASCADE,
  route_identity text NOT NULL,
  method text NOT NULL,
  path_pattern text NOT NULL,
  auth_scope text NOT NULL DEFAULT 'bearer',
  tenant_required boolean NOT NULL DEFAULT true,
  deprecated boolean NOT NULL DEFAULT false,
  sunset_at timestamptz,
  route_fingerprint char(64) NOT NULL,
  request_schema jsonb,
  response_schema jsonb,
  examples jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(revision_id, route_identity)
);
CREATE INDEX IF NOT EXISTS forge_client_contract_routes_identity_idx
  ON forge_client_contract_routes(route_identity, revision_id);

CREATE TABLE IF NOT EXISTS forge_client_contract_artifacts (
  id text PRIMARY KEY,
  revision_id text NOT NULL REFERENCES forge_client_contract_revisions(id) ON DELETE RESTRICT,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('openapi-json','json-schema-bundle')),
  filename text NOT NULL,
  media_type text NOT NULL,
  content text NOT NULL,
  checksum char(64) NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(revision_id, artifact_kind)
);
CREATE INDEX IF NOT EXISTS forge_client_contract_artifacts_revision_idx
  ON forge_client_contract_artifacts(revision_id, artifact_kind);

CREATE TABLE IF NOT EXISTS forge_client_contract_compatibility_decisions (
  id text PRIMARY KEY,
  from_revision_id text REFERENCES forge_client_contract_revisions(id) ON DELETE RESTRICT,
  to_contract_fingerprint char(64) NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED_BREAKING','APPROVED_NON_BREAKING','REJECTED')),
  rationale text NOT NULL,
  actor_id text NOT NULL,
  tenant_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_client_contract_decisions_target_idx
  ON forge_client_contract_compatibility_decisions(to_contract_fingerprint, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_client_contract_consumers (
  consumer_key text NOT NULL,
  tenant_id text NOT NULL,
  declared_api_version text,
  declared_contract_fingerprint char(64),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_compatible_at timestamptz,
  last_incompatible_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(consumer_key, tenant_id)
);

CREATE TABLE IF NOT EXISTS forge_client_contract_audit (
  id bigserial PRIMARY KEY,
  revision_id text REFERENCES forge_client_contract_revisions(id) ON DELETE RESTRICT,
  action text NOT NULL,
  actor_id text NOT NULL,
  tenant_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_client_contract_audit_revision_idx
  ON forge_client_contract_audit(revision_id, created_at DESC);

COMMIT;
