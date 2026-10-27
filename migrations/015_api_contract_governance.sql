BEGIN;

CREATE TABLE IF NOT EXISTS forge_api_contracts (
  id bigserial PRIMARY KEY,
  route_identity text NOT NULL,
  method text NOT NULL,
  path_pattern text NOT NULL,
  api_version text NOT NULL,
  request_schema_fingerprint char(64) NOT NULL,
  response_schema_fingerprint char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('supported','deprecated','sunset','disabled')),
  activated_at timestamptz,
  deprecated_at timestamptz,
  sunset_at timestamptz,
  compatibility_mode text NOT NULL DEFAULT 'additive' CHECK (compatibility_mode IN ('strict','additive','legacy-adapter','disabled')),
  tenant_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  migration_notes text NOT NULL DEFAULT '',
  request_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  version_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(route_identity, api_version),
  CHECK (length(route_identity) > 0),
  CHECK (method = upper(method)),
  CHECK (api_version ~ '^v[0-9]+$'),
  CHECK (sunset_at IS NULL OR deprecated_at IS NULL OR sunset_at >= deprecated_at)
);
CREATE INDEX IF NOT EXISTS forge_api_contracts_route_idx ON forge_api_contracts(route_identity, method, path_pattern);
CREATE INDEX IF NOT EXISTS forge_api_contracts_status_idx ON forge_api_contracts(status, sunset_at);

CREATE TABLE IF NOT EXISTS forge_api_contract_history (
  id bigserial PRIMARY KEY,
  contract_id bigint NOT NULL REFERENCES forge_api_contracts(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_id text,
  tenant_id text,
  before_state jsonb,
  after_state jsonb,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_api_contract_history_lookup_idx ON forge_api_contract_history(contract_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_api_consumers (
  id bigserial PRIMARY KEY,
  consumer_key text NOT NULL,
  tenant_id text,
  project_id text,
  plan_key text,
  actor_id text,
  declared_version text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_route_identity text,
  last_status integer,
  request_count bigint NOT NULL DEFAULT 0,
  deprecated_request_count bigint NOT NULL DEFAULT 0,
  rejected_request_count bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(consumer_key, tenant_id, project_id)
);
CREATE INDEX IF NOT EXISTS forge_api_consumers_tenant_idx ON forge_api_consumers(tenant_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS forge_api_usage (
  bucket_start timestamptz NOT NULL,
  route_identity text NOT NULL,
  api_version text NOT NULL,
  tenant_id text NOT NULL DEFAULT '',
  plan_key text NOT NULL DEFAULT '',
  status_class smallint NOT NULL CHECK (status_class BETWEEN 1 AND 5),
  request_count bigint NOT NULL DEFAULT 0,
  deprecated_count bigint NOT NULL DEFAULT 0,
  rejected_count bigint NOT NULL DEFAULT 0,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(bucket_start, route_identity, api_version, tenant_id, plan_key, status_class)
);
CREATE INDEX IF NOT EXISTS forge_api_usage_route_idx ON forge_api_usage(route_identity, api_version, bucket_start DESC);
CREATE INDEX IF NOT EXISTS forge_api_usage_tenant_idx ON forge_api_usage(tenant_id, bucket_start DESC);

CREATE TABLE IF NOT EXISTS forge_api_version_policies (
  id bigserial PRIMARY KEY,
  tenant_id text,
  plan_key text,
  api_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('enabled','disabled','migration-only','sunset-exempt')),
  effective_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  reason text NOT NULL DEFAULT '',
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > effective_at)
);
CREATE INDEX IF NOT EXISTS forge_api_version_policies_lookup_idx ON forge_api_version_policies(tenant_id, plan_key, api_version, effective_at DESC);

CREATE TABLE IF NOT EXISTS forge_api_migration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_identity text NOT NULL,
  from_version text NOT NULL,
  to_version text NOT NULL,
  tenant_id text,
  consumer_key text,
  state text NOT NULL CHECK (state IN ('planned','running','verified','rolled_back','failed')),
  compatibility_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  actor_id text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_api_migration_runs_lookup_idx ON forge_api_migration_runs(route_identity, tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION forge_api_contract_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS forge_api_contracts_touch_updated_at ON forge_api_contracts;
CREATE TRIGGER forge_api_contracts_touch_updated_at BEFORE UPDATE ON forge_api_contracts FOR EACH ROW EXECUTE FUNCTION forge_api_contract_touch_updated_at();

COMMIT;
