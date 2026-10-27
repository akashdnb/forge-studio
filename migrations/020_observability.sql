BEGIN;
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS trace_id char(32);
ALTER TABLE forge_jobs ADD COLUMN IF NOT EXISTS correlation_id varchar(128);
CREATE INDEX IF NOT EXISTS forge_jobs_correlation_idx ON forge_jobs(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS forge_jobs_trace_idx ON forge_jobs(trace_id) WHERE trace_id IS NOT NULL;
COMMIT;
