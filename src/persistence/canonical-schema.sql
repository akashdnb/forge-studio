BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS tenants(id text PRIMARY KEY,name text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
COMMIT;
