CREATE TABLE IF NOT EXISTS forge_provider_contracts (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  capability text NOT NULL,
  contract_version text NOT NULL,
  contract_hash text NOT NULL,
  schema_version integer NOT NULL,
  contract jsonb NOT NULL,
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED','QUARANTINED')),
  valid_until timestamptz,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, capability, contract_version),
  CHECK (contract_hash <> ''),
  CHECK (signature <> '')
);

CREATE TABLE IF NOT EXISTS forge_provider_contract_state (
  provider text NOT NULL,
  capability text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','QUARANTINED')),
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 1,
  updated_by text NOT NULL DEFAULT 'system',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider, capability)
);

CREATE TABLE IF NOT EXISTS forge_provider_contract_decisions (
  decision_id text PRIMARY KEY,
  tenant_id text,
  project_id text,
  run_id text,
  capability text,
  operation text,
  model text,
  decision_hash text NOT NULL,
  decision_signature text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED','BLOCKED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_contracts_lookup ON forge_provider_contracts(provider, capability, status, contract_version DESC);
CREATE INDEX IF NOT EXISTS idx_provider_contract_decisions_scope ON forge_provider_contract_decisions(tenant_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_contract_state_quarantine ON forge_provider_contract_state(state, updated_at DESC);

CREATE OR REPLACE FUNCTION forge_provider_contract_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.contract_hash <> NEW.contract_hash OR OLD.contract_version <> NEW.contract_version OR OLD.schema_version <> NEW.schema_version OR OLD.signature <> NEW.signature OR OLD.contract <> NEW.contract THEN
    RAISE EXCEPTION 'provider contract versions are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS forge_provider_contract_immutable ON forge_provider_contracts;
CREATE TRIGGER forge_provider_contract_immutable BEFORE UPDATE ON forge_provider_contracts FOR EACH ROW EXECUTE FUNCTION forge_provider_contract_immutable_guard();

CREATE OR REPLACE FUNCTION forge_provider_contract_decision_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider contract decision evidence is immutable';
END;
$$;
DROP TRIGGER IF EXISTS forge_provider_contract_decision_immutable ON forge_provider_contract_decisions;
CREATE TRIGGER forge_provider_contract_decision_immutable BEFORE UPDATE OR DELETE ON forge_provider_contract_decisions FOR EACH ROW EXECUTE FUNCTION forge_provider_contract_decision_immutable_guard();

CREATE OR REPLACE FUNCTION forge_provider_contract_sensitive_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evidence::text ~* '(token|secret|password|authorization|api[_-]?key|private[_-]?key|bearer )' THEN
    RAISE EXCEPTION 'sensitive provider contract evidence is not permitted';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS forge_provider_contract_decision_sensitive_evidence ON forge_provider_contract_decisions;
CREATE TRIGGER forge_provider_contract_decision_sensitive_evidence BEFORE INSERT OR UPDATE ON forge_provider_contract_decisions FOR EACH ROW EXECUTE FUNCTION forge_provider_contract_sensitive_evidence_guard();

COMMENT ON TABLE forge_provider_contracts IS 'Versioned signed provider capability contracts. Contract bodies and signatures are immutable per version.';
COMMENT ON TABLE forge_provider_contract_decisions IS 'Signed, redacted compatibility negotiation evidence. Never stores raw provider payloads or secrets.';
