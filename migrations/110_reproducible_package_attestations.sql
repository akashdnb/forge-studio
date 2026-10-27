BEGIN;

CREATE TABLE IF NOT EXISTS package_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_artifact_id text NOT NULL REFERENCES artifacts(id) ON DELETE RESTRICT,
  package_version_id text NOT NULL,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  attestation_version integer NOT NULL CHECK (attestation_version > 0),
  build_fingerprint char(64) NOT NULL,
  payload_hash char(64) NOT NULL,
  signature char(64) NOT NULL,
  signature_algorithm text NOT NULL CHECK (signature_algorithm IN ('HMAC-SHA256')),
  reason text NOT NULL DEFAULT 'package-build',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'VERIFIED' CHECK (status IN ('VERIFIED','DRIFTED','REVOKED')),
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  toolchain jsonb NOT NULL DEFAULT '{}'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(package_artifact_id, build_fingerprint),
  UNIQUE(package_artifact_id, attestation_version)
);
ALTER TABLE package_attestations ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT 'package-build';
ALTER TABLE package_attestations ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS package_attestations_scope_idx ON package_attestations(tenant_id, project_id, episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS package_attestations_status_idx ON package_attestations(status, created_at DESC);

CREATE TABLE IF NOT EXISTS package_build_inputs (
  package_artifact_id text PRIMARY KEY REFERENCES artifacts(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  package_manifest_hash char(64) NOT NULL,
  canonical_inputs_hash char(64) NOT NULL,
  dependency_inventory_hash char(64) NOT NULL,
  toolchain_fingerprint char(64) NOT NULL,
  release_epoch bigint,
  policy_epoch bigint,
  source_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  dependency_inventory jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS package_build_inputs_scope_idx ON package_build_inputs(tenant_id, project_id, episode_id);

CREATE OR REPLACE FUNCTION forge_package_attestation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'package attestations are append-only'; END IF;
  IF OLD.package_artifact_id IS DISTINCT FROM NEW.package_artifact_id OR OLD.package_version_id IS DISTINCT FROM NEW.package_version_id OR OLD.attestation_version IS DISTINCT FROM NEW.attestation_version OR OLD.build_fingerprint IS DISTINCT FROM NEW.build_fingerprint OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash OR OLD.signature IS DISTINCT FROM NEW.signature OR OLD.reason IS DISTINCT FROM NEW.reason OR OLD.payload IS DISTINCT FROM NEW.payload OR OLD.inputs IS DISTINCT FROM NEW.inputs OR OLD.toolchain IS DISTINCT FROM NEW.toolchain THEN RAISE EXCEPTION 'package attestation identity is immutable'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS package_attestation_immutable ON package_attestations;
CREATE TRIGGER package_attestation_immutable BEFORE UPDATE OR DELETE ON package_attestations FOR EACH ROW EXECUTE FUNCTION forge_package_attestation_immutable();

CREATE OR REPLACE FUNCTION forge_package_build_inputs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'package build inputs are append-only'; END IF;
  IF OLD.package_artifact_id IS DISTINCT FROM NEW.package_artifact_id OR OLD.package_manifest_hash IS DISTINCT FROM NEW.package_manifest_hash OR OLD.canonical_inputs_hash IS DISTINCT FROM NEW.canonical_inputs_hash OR OLD.dependency_inventory_hash IS DISTINCT FROM NEW.dependency_inventory_hash OR OLD.toolchain_fingerprint IS DISTINCT FROM NEW.toolchain_fingerprint OR OLD.canonical_inputs IS DISTINCT FROM NEW.canonical_inputs OR OLD.dependency_inventory IS DISTINCT FROM NEW.dependency_inventory THEN RAISE EXCEPTION 'package build inputs are immutable'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS package_build_inputs_immutable ON package_build_inputs;
CREATE TRIGGER package_build_inputs_immutable BEFORE UPDATE OR DELETE ON package_build_inputs FOR EACH ROW EXECUTE FUNCTION forge_package_build_inputs_immutable();

DO $$ BEGIN
  IF to_regclass('public.evidence_ledger') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS evidence_capture_package_attestations ON package_attestations';
    EXECUTE 'CREATE TRIGGER evidence_capture_package_attestations AFTER INSERT OR UPDATE OR DELETE ON package_attestations FOR EACH ROW EXECUTE FUNCTION forge_capture_evidence()';
    EXECUTE 'DROP TRIGGER IF EXISTS evidence_capture_package_build_inputs ON package_build_inputs';
    EXECUTE 'CREATE TRIGGER evidence_capture_package_build_inputs AFTER INSERT OR UPDATE OR DELETE ON package_build_inputs FOR EACH ROW EXECUTE FUNCTION forge_capture_evidence()';
  END IF;
END $$;

COMMIT;
