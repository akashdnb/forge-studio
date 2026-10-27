BEGIN;

CREATE TABLE IF NOT EXISTS forge_schedules (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  trigger_type text NOT NULL CHECK (trigger_type IN ('CRON','ONCE','DELAY','CALENDAR')),
  cron_expr text,
  fire_at timestamptz,
  timezone text NOT NULL DEFAULT 'UTC',
  dst_gap_policy text NOT NULL DEFAULT 'SKIP' CHECK (dst_gap_policy IN ('SKIP','SHIFT_FORWARD')),
  dst_fold_policy text NOT NULL DEFAULT 'EARLIER' CHECK (dst_fold_policy IN ('EARLIER','LATER','BOTH')),
  misfire_policy text NOT NULL DEFAULT 'COALESCE' CHECK (misfire_policy IN ('SKIP','COALESCE','CATCH_UP')),
  catch_up_limit integer NOT NULL DEFAULT 10 CHECK (catch_up_limit BETWEEN 1 AND 1000),
  max_misfire_age_seconds integer NOT NULL DEFAULT 86400 CHECK (max_misfire_age_seconds >= 0),
  next_fire_at timestamptz,
  previous_fire_at timestamptz,
  execution_epoch bigint NOT NULL DEFAULT 0 CHECK (execution_epoch >= 0),
  idempotency_prefix text NOT NULL,
  handler_kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  paused boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((trigger_type='CRON' AND cron_expr IS NOT NULL AND fire_at IS NULL) OR (trigger_type='ONCE' AND fire_at IS NOT NULL AND cron_expr IS NULL) OR (trigger_type='DELAY' AND fire_at IS NOT NULL AND cron_expr IS NULL) OR (trigger_type='CALENDAR' AND cron_expr IS NOT NULL AND fire_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS forge_schedules_scope_identity_idx ON forge_schedules(tenant_id, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS forge_schedules_due_idx ON forge_schedules(next_fire_at, id) WHERE deleted_at IS NULL AND paused=false AND next_fire_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_schedules_scope_idx ON forge_schedules(tenant_id, project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS forge_schedule_occurrences (
  id bigserial PRIMARY KEY,
  schedule_id text NOT NULL REFERENCES forge_schedules(id) ON DELETE CASCADE,
  schedule_version bigint NOT NULL,
  execution_epoch bigint NOT NULL,
  fire_at timestamptz NOT NULL,
  effective_fire_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CLAIMED','TRIGGERED','SKIPPED','FAILED')),
  lease_owner text,
  lease_token text,
  lease_until timestamptz,
  claimed_at timestamptz,
  triggered_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  retry_at timestamptz,
  target_job_id text,
  error jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(schedule_id, schedule_version, execution_epoch, fire_at),
  UNIQUE(idempotency_key)
);
CREATE INDEX IF NOT EXISTS forge_schedule_occurrences_due_idx ON forge_schedule_occurrences(status, effective_fire_at, lease_until);
CREATE INDEX IF NOT EXISTS forge_schedule_occurrences_schedule_idx ON forge_schedule_occurrences(schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_schedule_occurrences_lease_idx ON forge_schedule_occurrences(lease_until) WHERE status='CLAIMED';
CREATE INDEX IF NOT EXISTS forge_schedule_occurrences_misfire_idx ON forge_schedule_occurrences(status, fire_at) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS forge_scheduler_workers (
  worker_id text PRIMARY KEY,
  fencing_epoch bigint NOT NULL DEFAULT 1 CHECK (fencing_epoch > 0),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lease_seconds integer NOT NULL DEFAULT 30 CHECK (lease_seconds BETWEEN 5 AND 600),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS forge_scheduler_workers_heartbeat_idx ON forge_scheduler_workers(heartbeat_at);

CREATE TABLE IF NOT EXISTS forge_schedule_audit (
  id bigserial PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text,
  schedule_id text NOT NULL,
  schedule_version bigint,
  execution_epoch bigint,
  actor text NOT NULL,
  action text NOT NULL,
  request_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_schedule_audit_scope_idx ON forge_schedule_audit(tenant_id, schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS forge_schedule_audit_action_idx ON forge_schedule_audit(action, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_scheduler_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  fencing_epoch bigint NOT NULL DEFAULT 1 CHECK (fencing_epoch > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO forge_scheduler_control(id) VALUES(true) ON CONFLICT(id) DO NOTHING;

COMMIT;
