BEGIN;

ALTER TABLE forge_event_subscriptions
  ADD COLUMN IF NOT EXISTS endpoint_config_ref text,
  ADD COLUMN IF NOT EXISTS endpoint_fingerprint char(64),
  ADD COLUMN IF NOT EXISTS delivery_epoch bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS active_key_id text,
  ADD COLUMN IF NOT EXISTS circuit_state text NOT NULL DEFAULT 'CLOSED',
  ADD COLUMN IF NOT EXISTS circuit_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS circuit_opened_until timestamptz,
  ADD COLUMN IF NOT EXISTS circuit_failure_threshold integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS circuit_cooldown_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS governance_decision_id text,
  ADD COLUMN IF NOT EXISTS governance_policy_hash char(64),
  ADD COLUMN IF NOT EXISTS updated_by text;

UPDATE forge_event_subscriptions
SET endpoint_config_ref=COALESCE(endpoint_config_ref,'endpoint:'||id),
    endpoint_fingerprint=COALESCE(endpoint_fingerprint,encode(digest(endpoint_url,'sha256'),'hex'))
WHERE endpoint_config_ref IS NULL OR endpoint_fingerprint IS NULL;

ALTER TABLE forge_event_subscriptions
  ALTER COLUMN endpoint_config_ref SET NOT NULL,
  ALTER COLUMN endpoint_fingerprint SET NOT NULL;

ALTER TABLE forge_event_subscriptions
  ADD CONSTRAINT forge_event_subscription_circuit_state_ck
  CHECK (circuit_state IN ('CLOSED','OPEN','HALF_OPEN'));
ALTER TABLE forge_event_subscriptions
  ADD CONSTRAINT forge_event_subscription_limits_ck
  CHECK (circuit_failure_threshold BETWEEN 1 AND 100 AND circuit_cooldown_seconds BETWEEN 1 AND 86400 AND max_attempts BETWEEN 1 AND 32);

CREATE TABLE IF NOT EXISTS forge_event_subscription_keys (
  id text PRIMARY KEY,
  subscription_id text NOT NULL REFERENCES forge_event_subscriptions(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  key_epoch bigint NOT NULL CHECK (key_epoch > 0),
  secret_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE(subscription_id,key_epoch),
  UNIQUE(subscription_id,id)
);
CREATE INDEX IF NOT EXISTS forge_event_subscription_keys_lookup_idx
  ON forge_event_subscription_keys(subscription_id,status,key_epoch DESC);

INSERT INTO forge_event_subscription_keys(id,subscription_id,tenant_id,key_epoch,secret_ciphertext,status,created_by)
SELECT 'key:'||s.id||':1',s.id,s.tenant_id,1,s.secret_ciphertext,'ACTIVE',s.created_by
FROM forge_event_subscriptions s
WHERE NOT EXISTS (SELECT 1 FROM forge_event_subscription_keys k WHERE k.subscription_id=s.id);

UPDATE forge_event_subscriptions
SET active_key_id='key:'||id||':1'
WHERE active_key_id IS NULL;

ALTER TABLE forge_event_subscriptions
  ADD CONSTRAINT forge_event_subscription_active_key_fk
  FOREIGN KEY (active_key_id) REFERENCES forge_event_subscription_keys(id) ON DELETE RESTRICT;

ALTER TABLE forge_event_deliveries
  ADD COLUMN IF NOT EXISTS delivery_epoch bigint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS key_id text,
  ADD COLUMN IF NOT EXISTS endpoint_url_snapshot text,
  ADD COLUMN IF NOT EXISTS endpoint_config_ref_snapshot text,
  ADD COLUMN IF NOT EXISTS endpoint_fingerprint char(64),
  ADD COLUMN IF NOT EXISTS payload_hash char(64),
  ADD COLUMN IF NOT EXISTS schema_name text,
  ADD COLUMN IF NOT EXISTS schema_version integer,
  ADD COLUMN IF NOT EXISTS schema_hash char(64),
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS replay_of text;

UPDATE forge_event_deliveries d
SET key_id=COALESCE(d.key_id,s.active_key_id),
    endpoint_url_snapshot=COALESCE(d.endpoint_url_snapshot,s.endpoint_url),
    endpoint_config_ref_snapshot=COALESCE(d.endpoint_config_ref_snapshot,s.endpoint_config_ref),
    endpoint_fingerprint=COALESCE(d.endpoint_fingerprint,s.endpoint_fingerprint),
    payload_hash=COALESCE(d.payload_hash,e.payload_hash),
    schema_name=COALESCE(d.schema_name,e.schema_name),
    schema_version=COALESCE(d.schema_version,e.schema_version),
    schema_hash=COALESCE(d.schema_hash,encode(digest(e.schema::text,'sha256'),'hex')),
    idempotency_key=COALESCE(d.idempotency_key,d.id),
    delivery_epoch=COALESCE(d.delivery_epoch,s.delivery_epoch)
FROM forge_event_subscriptions s, forge_events e
WHERE s.id=d.subscription_id
  AND e.id=d.event_id;

ALTER TABLE forge_event_deliveries
  ALTER COLUMN key_id SET NOT NULL,
  ALTER COLUMN endpoint_url_snapshot SET NOT NULL,
  ALTER COLUMN endpoint_config_ref_snapshot SET NOT NULL,
  ALTER COLUMN endpoint_fingerprint SET NOT NULL,
  ALTER COLUMN payload_hash SET NOT NULL,
  ALTER COLUMN schema_name SET NOT NULL,
  ALTER COLUMN schema_version SET NOT NULL,
  ALTER COLUMN schema_hash SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE forge_event_deliveries
  ADD CONSTRAINT forge_event_delivery_key_fk
  FOREIGN KEY (key_id) REFERENCES forge_event_subscription_keys(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS forge_event_deliveries_epoch_uq
  ON forge_event_deliveries(event_id,subscription_id,delivery_epoch);
CREATE UNIQUE INDEX IF NOT EXISTS forge_event_deliveries_idempotency_uq
  ON forge_event_deliveries(subscription_id,idempotency_key);
CREATE INDEX IF NOT EXISTS forge_event_deliveries_endpoint_claim_idx
  ON forge_event_deliveries(subscription_id,status,available_at,delivery_epoch);

ALTER TABLE forge_event_delivery_attempts
  ADD COLUMN IF NOT EXISTS nonce text,
  ADD COLUMN IF NOT EXISTS request_timestamp bigint,
  ADD COLUMN IF NOT EXISTS key_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS response_body_hash char(64),
  ADD COLUMN IF NOT EXISTS retry_after_ms integer,
  ADD COLUMN IF NOT EXISTS error_class text;
CREATE UNIQUE INDEX IF NOT EXISTS forge_event_delivery_attempts_nonce_uq
  ON forge_event_delivery_attempts(delivery_id,nonce)
  WHERE nonce IS NOT NULL;

CREATE INDEX IF NOT EXISTS forge_event_deliveries_open_circuit_idx
  ON forge_event_deliveries(subscription_id,status,available_at)
  WHERE status IN ('PENDING','RETRY');

COMMIT;
