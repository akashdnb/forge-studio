BEGIN;

ALTER TABLE forge_workflow_checkpoints
  ADD COLUMN IF NOT EXISTS checkpoint_epoch bigint,
  ADD COLUMN IF NOT EXISTS workflow_run_id text,
  ADD COLUMN IF NOT EXISTS stage_version text NOT NULL DEFAULT '1',
  ADD COLUMN IF NOT EXISTS plan_hash char(64),
  ADD COLUMN IF NOT EXISTS input_fingerprint char(64),
  ADD COLUMN IF NOT EXISTS output_fingerprint char(64),
  ADD COLUMN IF NOT EXISTS provider_state_hash char(64),
  ADD COLUMN IF NOT EXISTS credential_state_hash char(64),
  ADD COLUMN IF NOT EXISTS admission_state_hash char(64),
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS side_effect_boundary text NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS validity text NOT NULL DEFAULT 'UNVALIDATED' CHECK(validity IN ('UNVALIDATED','VALID','INVALID','QUARANTINED')),
  ADD COLUMN IF NOT EXISTS invalid_reason text,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS validated_by text,
  ADD COLUMN IF NOT EXISTS validation_hash char(64);

UPDATE forge_workflow_checkpoints SET checkpoint_epoch=execution_epoch WHERE checkpoint_epoch IS NULL;

ALTER TABLE forge_workflow_checkpoints
  ALTER COLUMN checkpoint_epoch SET NOT NULL;

CREATE INDEX IF NOT EXISTS forge_workflow_checkpoints_validity_idx
  ON forge_workflow_checkpoints(tenant_id,plan_id,validity,checkpoint_version DESC);
CREATE INDEX IF NOT EXISTS forge_workflow_checkpoints_run_idx
  ON forge_workflow_checkpoints(tenant_id,workflow_run_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS forge_workflow_checkpoint_epoch_stage_uq
  ON forge_workflow_checkpoints(plan_id,checkpoint_epoch,stage_id);

CREATE TABLE IF NOT EXISTS forge_workflow_checkpoint_diagnostics (
  id bigserial PRIMARY KEY,
  checkpoint_id text NOT NULL REFERENCES forge_workflow_checkpoints(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  plan_id text NOT NULL,
  execution_epoch bigint NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('VALID','INVALID','QUARANTINED')),
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_workflow_checkpoint_diagnostics_scope_idx
  ON forge_workflow_checkpoint_diagnostics(tenant_id,plan_id,created_at DESC);

CREATE TABLE IF NOT EXISTS forge_workflow_reentry_attempts (
  id uuid PRIMARY KEY,
  checkpoint_id text NOT NULL REFERENCES forge_workflow_checkpoints(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  plan_id text NOT NULL,
  execution_epoch bigint NOT NULL,
  requested_by text NOT NULL,
  status text NOT NULL CHECK(status IN ('REQUESTED','ADMITTED','DISPATCHED','REJECTED','QUARANTINED')),
  reason text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS forge_workflow_reentry_attempts_scope_idx
  ON forge_workflow_reentry_attempts(tenant_id,plan_id,created_at DESC);

COMMIT;
