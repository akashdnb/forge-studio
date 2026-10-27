BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS forge_inbound_webhook_endpoints (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
 project_id text REFERENCES projects(id) ON DELETE RESTRICT, name text NOT NULL,
 active boolean NOT NULL DEFAULT true, max_body_bytes integer NOT NULL DEFAULT 1048576 CHECK(max_body_bytes BETWEEN 1024 AND 10485760),
 replay_window_seconds integer NOT NULL DEFAULT 300 CHECK(replay_window_seconds BETWEEN 30 AND 900),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,name)
);
CREATE INDEX IF NOT EXISTS forge_inbound_webhook_endpoint_scope_idx ON forge_inbound_webhook_endpoints(tenant_id,project_id,active);
CREATE TABLE IF NOT EXISTS forge_inbound_webhook_secrets (
 id text PRIMARY KEY, endpoint_id text NOT NULL REFERENCES forge_inbound_webhook_endpoints(id) ON DELETE RESTRICT,
 key_id text NOT NULL, secret_ciphertext text NOT NULL, active boolean NOT NULL DEFAULT true,
 valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(endpoint_id,key_id)
);
CREATE INDEX IF NOT EXISTS forge_inbound_webhook_secret_active_idx ON forge_inbound_webhook_secrets(endpoint_id,active,valid_from DESC);
CREATE TABLE IF NOT EXISTS forge_inbound_webhook_routes (
 endpoint_id text NOT NULL REFERENCES forge_inbound_webhook_endpoints(id) ON DELETE RESTRICT,
 event_type text NOT NULL, route_kind text NOT NULL CHECK(route_kind IN('workflow','provider','reconciliation','runner')),
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(endpoint_id,event_type)
);
CREATE TABLE IF NOT EXISTS forge_inbound_webhook_nonces (
 endpoint_id text NOT NULL REFERENCES forge_inbound_webhook_endpoints(id) ON DELETE RESTRICT,
 nonce text NOT NULL, event_id text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(endpoint_id,nonce)
);
CREATE INDEX IF NOT EXISTS forge_inbound_webhook_nonce_expiry_idx ON forge_inbound_webhook_nonces(expires_at);
CREATE TABLE IF NOT EXISTS forge_inbound_events (
 id text PRIMARY KEY, endpoint_id text NOT NULL REFERENCES forge_inbound_webhook_endpoints(id) ON DELETE RESTRICT,
 tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, project_id text REFERENCES projects(id) ON DELETE RESTRICT,
 external_event_id text NOT NULL, event_type text NOT NULL, version integer NOT NULL CHECK(version>0),
 payload_digest char(64) NOT NULL, envelope jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'ACCEPTED' CHECK(status IN('ACCEPTED','PROCESSING','PROCESSED','PARTIAL','DEAD_LETTER','REJECTED')),
 UNIQUE(endpoint_id,external_event_id)
);
CREATE INDEX IF NOT EXISTS forge_inbound_events_tenant_received_idx ON forge_inbound_events(tenant_id,received_at DESC);
CREATE INDEX IF NOT EXISTS forge_inbound_events_status_idx ON forge_inbound_events(status,received_at);
CREATE TABLE IF NOT EXISTS forge_inbound_event_effects (
 event_id text NOT NULL REFERENCES forge_inbound_events(id) ON DELETE RESTRICT, route_kind text NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','SUCCEEDED','FAILED','DEAD_LETTER')),
 job_id text REFERENCES forge_jobs(id) ON DELETE RESTRICT, attempts integer NOT NULL DEFAULT 0,
 last_error text, processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(event_id,route_kind)
);
CREATE INDEX IF NOT EXISTS forge_inbound_effect_status_idx ON forge_inbound_event_effects(status,updated_at);
CREATE TABLE IF NOT EXISTS forge_inbound_event_dlq (
 event_id text NOT NULL REFERENCES forge_inbound_events(id) ON DELETE RESTRICT, route_kind text NOT NULL,
 reason text NOT NULL, quarantined_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz, release_reason text,
 PRIMARY KEY(event_id,route_kind)
);
CREATE TABLE IF NOT EXISTS forge_inbound_webhook_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), endpoint_id text REFERENCES forge_inbound_webhook_endpoints(id) ON DELETE RESTRICT,
 tenant_id text REFERENCES tenants(id) ON DELETE RESTRICT, actor text NOT NULL, action text NOT NULL, outcome text NOT NULL,
 details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION forge_inbound_endpoint_scope_guard() RETURNS trigger AS $$ DECLARE t text; BEGIN IF NEW.project_id IS NOT NULL THEN SELECT tenant_id INTO t FROM projects WHERE id=NEW.project_id; IF t IS NULL OR t<>NEW.tenant_id THEN RAISE EXCEPTION 'webhook endpoint tenant mismatch' USING ERRCODE='23514'; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_inbound_endpoint_scope ON forge_inbound_webhook_endpoints;
CREATE TRIGGER forge_inbound_endpoint_scope BEFORE INSERT OR UPDATE OF tenant_id,project_id ON forge_inbound_webhook_endpoints FOR EACH ROW EXECUTE FUNCTION forge_inbound_endpoint_scope_guard();
CREATE OR REPLACE FUNCTION forge_inbound_event_scope_guard() RETURNS trigger AS $$ DECLARE t text; BEGIN IF NEW.project_id IS NOT NULL THEN SELECT tenant_id INTO t FROM projects WHERE id=NEW.project_id; IF t IS NULL OR t<>NEW.tenant_id THEN RAISE EXCEPTION 'inbound event tenant mismatch' USING ERRCODE='23514'; END IF; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_inbound_event_scope ON forge_inbound_events;
CREATE TRIGGER forge_inbound_event_scope BEFORE INSERT OR UPDATE OF tenant_id,project_id ON forge_inbound_events FOR EACH ROW EXECUTE FUNCTION forge_inbound_event_scope_guard();
COMMIT;
