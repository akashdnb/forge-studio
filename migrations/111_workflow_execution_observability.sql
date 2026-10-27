BEGIN;

CREATE TABLE IF NOT EXISTS forge_execution_traces (
  trace_id char(32) PRIMARY KEY,
  correlation_id varchar(128) NOT NULL,
  tenant_id text,
  project_id text REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text REFERENCES episodes(id) ON DELETE RESTRICT,
  root_kind varchar(96),
  status varchar(24) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','QUEUED','BLOCKED','RETRYING','FAILED','QUARANTINED','PUBLISHED','SUCCEEDED','CANCELLED','UNKNOWN')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_event_at timestamptz NOT NULL DEFAULT now(),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  sampled boolean NOT NULL DEFAULT true,
  diagnostic_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forge_execution_traces_project_idx ON forge_execution_traces(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS forge_execution_traces_correlation_idx ON forge_execution_traces(correlation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS forge_execution_traces_status_idx ON forge_execution_traces(status, last_event_at DESC);

CREATE TABLE IF NOT EXISTS forge_execution_attempts (
  id bigserial PRIMARY KEY,
  trace_id char(32) NOT NULL REFERENCES forge_execution_traces(trace_id) ON DELETE CASCADE,
  job_id text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  worker_id varchar(160),
  dispatch_generation integer,
  lease_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome varchar(32) NOT NULL DEFAULT 'RUNNING',
  retryable boolean,
  retry_cause varchar(96),
  admission jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (job_id, attempt)
);
CREATE INDEX IF NOT EXISTS forge_execution_attempts_trace_idx ON forge_execution_attempts(trace_id, started_at, id);
CREATE INDEX IF NOT EXISTS forge_execution_attempts_job_idx ON forge_execution_attempts(job_id, attempt DESC);

CREATE TABLE IF NOT EXISTS forge_execution_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id char(32) NOT NULL REFERENCES forge_execution_traces(trace_id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  event_time timestamptz,
  clock_skew_ms integer NOT NULL DEFAULT 0,
  kind varchar(64) NOT NULL,
  span_id char(16),
  parent_span_id char(16),
  job_id text,
  attempt integer,
  worker_id varchar(160),
  stage varchar(96),
  outcome varchar(32),
  reason varchar(128),
  duration_ms bigint,
  sampled boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (trace_id, sequence)
);
CREATE INDEX IF NOT EXISTS forge_execution_events_trace_order_idx ON forge_execution_events(trace_id, sequence);
CREATE INDEX IF NOT EXISTS forge_execution_events_job_idx ON forge_execution_events(job_id, observed_at DESC) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_execution_events_observed_idx ON forge_execution_events(observed_at DESC);

CREATE TABLE IF NOT EXISTS forge_execution_observability_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  sample_rate numeric(5,4) NOT NULL DEFAULT 0.1000 CHECK (sample_rate >= 0 AND sample_rate <= 1),
  max_events_per_trace integer NOT NULL DEFAULT 5000 CHECK (max_events_per_trace BETWEEN 100 AND 100000),
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  max_payload_bytes integer NOT NULL DEFAULT 4096 CHECK (max_payload_bytes BETWEEN 512 AND 65536),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO forge_execution_observability_config(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

COMMIT;
