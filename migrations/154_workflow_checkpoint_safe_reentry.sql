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
  ADD COLUMN IF NOT EXISTS validation_hash char(64),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE forge_workflow_checkpoints SET checkpoint_epoch=execution_epoch WHERE checkpoint_epoch IS NULL;
ALTER TABLE forge_workflow_checkpoints ALTER COLUMN checkpoint_epoch SET NOT NULL;

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

CREATE OR REPLACE FUNCTION forge_workflow_checkpoint_immutability_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.validity='VALID' AND (
    NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
    NEW.template_version_id IS DISTINCT FROM OLD.template_version_id OR NEW.execution_epoch IS DISTINCT FROM OLD.execution_epoch OR
    NEW.checkpoint_version IS DISTINCT FROM OLD.checkpoint_version OR NEW.stage_id IS DISTINCT FROM OLD.stage_id OR
    NEW.runtime_stage IS DISTINCT FROM OLD.runtime_stage OR NEW.safe_state IS DISTINCT FROM OLD.safe_state OR
    NEW.reentry_contract IS DISTINCT FROM OLD.reentry_contract OR NEW.schema_version IS DISTINCT FROM OLD.schema_version OR
    NEW.state_hash IS DISTINCT FROM OLD.state_hash OR NEW.checkpoint_epoch IS DISTINCT FROM OLD.checkpoint_epoch OR
    NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id OR NEW.stage_version IS DISTINCT FROM OLD.stage_version OR
    NEW.plan_hash IS DISTINCT FROM OLD.plan_hash OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint OR
    NEW.output_fingerprint IS DISTINCT FROM OLD.output_fingerprint OR NEW.provider_state_hash IS DISTINCT FROM OLD.provider_state_hash OR
    NEW.credential_state_hash IS DISTINCT FROM OLD.credential_state_hash OR NEW.admission_state_hash IS DISTINCT FROM OLD.admission_state_hash OR
    NEW.deadline_at IS DISTINCT FROM OLD.deadline_at OR NEW.side_effect_boundary IS DISTINCT FROM OLD.side_effect_boundary OR
    NEW.schema_family IS DISTINCT FROM OLD.schema_family OR NEW.schema_hash IS DISTINCT FROM OLD.schema_hash
  ) THEN
    RAISE EXCEPTION 'IMMUTABLE_WORKFLOW_CHECKPOINT' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS forge_workflow_checkpoint_immutability_guard ON forge_workflow_checkpoints;
CREATE TRIGGER forge_workflow_checkpoint_immutability_guard BEFORE UPDATE ON forge_workflow_checkpoints FOR EACH ROW EXECUTE FUNCTION forge_workflow_checkpoint_immutability_guard();

COMMIT;
