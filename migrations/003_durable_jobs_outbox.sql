-- Durable job queue/outbox for resumable workflow execution.
BEGIN;

CREATE TABLE IF NOT EXISTS workflow_jobs (
  id text PRIMARY KEY,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN ('RESEARCH','SCRIPT','SCENE_PLAN','NARRATION','ASSETS','TIMELINE','RENDER','QA','PUBLISH')),
  capability text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  priority integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  result jsonb,
  error jsonb,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'RUNNING' AND locked_by IS NOT NULL AND lease_expires_at IS NOT NULL) OR
         (status <> 'RUNNING' AND locked_by IS NULL AND locked_at IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS workflow_jobs_ready_idx ON workflow_jobs(priority DESC, available_at, created_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS workflow_jobs_lease_idx ON workflow_jobs(lease_expires_at) WHERE status = 'RUNNING';

CREATE TABLE IF NOT EXISTS workflow_job_events (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES workflow_jobs(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_job_events_job_created_idx ON workflow_job_events(job_id, created_at);

-- Outbox rows are created in the same DB transaction as corresponding domain changes.
CREATE TABLE IF NOT EXISTS event_outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERING','DELIVERED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS event_outbox_pending_idx ON event_outbox(available_at, id) WHERE status IN ('PENDING','FAILED');

COMMIT;
