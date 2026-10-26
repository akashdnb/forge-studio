-- Durable asynchronous execution primitives for production workers.
-- Jobs are leased with SELECT ... FOR UPDATE SKIP LOCKED so multiple workers can safely share a database.

BEGIN;

CREATE TABLE IF NOT EXISTS forge_jobs (
  id text PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  priority integer NOT NULL DEFAULT 100,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_until timestamptz,
  worker_id text,
  result jsonb,
  error jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_jobs_claim_idx
  ON forge_jobs(status, available_at, priority, created_at)
  WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS forge_jobs_episode_idx ON forge_jobs(episode_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forge_outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_outbox_pending_idx
  ON forge_outbox(available_at, id)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS forge_idempotency_keys (
  key text PRIMARY KEY,
  actor text NOT NULL,
  request_hash char(64) NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS forge_idempotency_expiry_idx ON forge_idempotency_keys(expires_at);

COMMIT;
