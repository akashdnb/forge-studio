BEGIN;

CREATE TABLE IF NOT EXISTS forge_regions (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEGRADED','FENCED','OFFLINE')),
  provider_regions jsonb NOT NULL DEFAULT '[]'::jsonb,
  capacity jsonb NOT NULL DEFAULT '{}'::jsonb,
  health jsonb NOT NULL DEFAULT '{}'::jsonb,
  fence_token bigint NOT NULL DEFAULT 1,
  last_heartbeat_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forge_tenant_residency_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  version bigint NOT NULL,
  home_region text NOT NULL REFERENCES forge_regions(id),
  allowed_regions jsonb NOT NULL,
  artifact_replication jsonb NOT NULL DEFAULT '{"mode":"NONE","regions":[]}'::jsonb,
  control_plane_replication jsonb NOT NULL DEFAULT '{"mode":"AUTHORITATIVE_ONLY"}'::jsonb,
  provider_region_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_tenant_residency_active_idx ON forge_tenant_residency_policies(tenant_id) WHERE active;

CREATE TABLE IF NOT EXISTS forge_tenant_region_assignments (
  tenant_id text PRIMARY KEY,
  region_id text NOT NULL REFERENCES forge_regions(id),
  routing_epoch bigint NOT NULL DEFAULT 1,
  fence_token bigint NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'PRIMARY' CHECK (state IN ('PRIMARY','FAILOVER','RECOVERING','FENCED')),
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forge_region_control_leases (
  region_id text PRIMARY KEY REFERENCES forge_regions(id),
  owner text NOT NULL,
  lease_until timestamptz NOT NULL,
  routing_epoch bigint NOT NULL,
  fence_token bigint NOT NULL,
  purpose text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS forge_region_failovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  source_region text NOT NULL,
  target_region text NOT NULL,
  from_epoch bigint NOT NULL,
  to_epoch bigint NOT NULL,
  fence_token bigint NOT NULL,
  mode text NOT NULL CHECK (mode IN ('PLANNED','EMERGENCY','RECOVERY','FAILBACK')),
  state text NOT NULL CHECK (state IN ('DRY_RUN','PREPARED','COMMITTED','ABORTED')),
  operator_id text NOT NULL,
  reason text,
  dependency_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_movement jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_region_failovers_tenant_epoch_idx ON forge_region_failovers(tenant_id,to_epoch);

CREATE TABLE IF NOT EXISTS forge_region_audit (
  id bigserial PRIMARY KEY,
  tenant_id text,
  region_id text,
  routing_epoch bigint,
  fence_token bigint,
  action text NOT NULL,
  outcome text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS region_id text;
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS routing_epoch bigint;
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS region_fence_token bigint;
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS residency_policy_version bigint;
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS routing_admission_token text;
CREATE INDEX IF NOT EXISTS forge_jobs_region_status_idx ON forge_jobs(region_id,status,leased_until);

INSERT INTO forge_regions(id,status,health) VALUES
  ('primary','ACTIVE','{"source":"bootstrap","healthy":true}'::jsonb)
ON CONFLICT(id) DO NOTHING;

COMMIT;
