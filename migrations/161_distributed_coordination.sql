CREATE TABLE IF NOT EXISTS forge_coordination_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key text NOT NULL UNIQUE,
  tenant_id text,
  project_id text,
  owner_id text NOT NULL,
  fencing_token bigint NOT NULL DEFAULT 1,
  epoch bigint NOT NULL DEFAULT 1,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_renewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  wait_policy text NOT NULL DEFAULT 'bounded',
  priority integer NOT NULL DEFAULT 0,
  purpose text NOT NULL,
  resource_version text,
  state text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','RELEASED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (length(scope_key) BETWEEN 1 AND 512),
  CHECK (length(owner_id) BETWEEN 1 AND 512),
  CHECK (length(purpose) BETWEEN 1 AND 512),
  CHECK (expires_at >= acquired_at)
);

CREATE INDEX IF NOT EXISTS idx_forge_coordination_locks_active ON forge_coordination_locks (tenant_id, project_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_forge_coordination_locks_owner ON forge_coordination_locks (owner_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_forge_coordination_locks_expiry ON forge_coordination_locks (expires_at) WHERE state = 'HELD';

CREATE TABLE IF NOT EXISTS forge_coordination_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lock_id uuid NOT NULL REFERENCES forge_coordination_locks(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  tenant_id text,
  project_id text,
  event_type text NOT NULL,
  owner_id text,
  fencing_token bigint,
  epoch bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_forge_coordination_audit_scope_time ON forge_coordination_audit (scope_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_forge_coordination_audit_tenant_time ON forge_coordination_audit (tenant_id, created_at DESC);

COMMENT ON TABLE forge_coordination_locks IS 'Durable cross-process locks/leases. fencing_token and epoch monotonically reject stale writers.';
COMMENT ON COLUMN forge_coordination_locks.fencing_token IS 'Monotonic per-scope fencing token. Every ownership change increments it.';
COMMENT ON COLUMN forge_coordination_locks.epoch IS 'Monotonic ownership epoch. Renewals never increment it.';
COMMENT ON COLUMN forge_coordination_locks.expires_at IS 'Authoritative DB-clock expiry; application clocks are never used for ownership decisions.';
