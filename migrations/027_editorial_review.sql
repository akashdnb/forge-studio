BEGIN;

CREATE TABLE IF NOT EXISTS review_threads (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  anchor_type text NOT NULL CHECK (anchor_type IN ('EPISODE','VERSION','SCENE','TIMELINE_RANGE','ARTIFACT_TIMESTAMP')),
  anchor jsonb NOT NULL DEFAULT '{}'::jsonb,
  title text NOT NULL,
  severity text NOT NULL DEFAULT 'NORMAL' CHECK (severity IN ('INFO','NORMAL','MAJOR','BLOCKER')),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','RESOLVED','REOPENED')),
  required_for_release boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_by text,
  resolved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS review_threads_scope_idx ON review_threads(tenant_id, project_id, episode_id, version_id, state, created_at, id);
CREATE INDEX IF NOT EXISTS review_threads_gate_idx ON review_threads(project_id, version_id, required_for_release, state, severity);

CREATE TABLE IF NOT EXISTS review_comment_revisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  thread_id text NOT NULL REFERENCES review_threads(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  body text NOT NULL,
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachment_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  operation text NOT NULL CHECK (operation IN ('CREATE','EDIT','DELETE')),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, revision)
);
CREATE INDEX IF NOT EXISTS review_comment_thread_order_idx ON review_comment_revisions(thread_id, revision ASC, created_at ASC, id);

CREATE TABLE IF NOT EXISTS review_decisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  thread_id text NOT NULL REFERENCES review_threads(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('APPROVED','CHANGES_REQUESTED','REJECTED')),
  actor text NOT NULL,
  rationale text NOT NULL DEFAULT '',
  evidence_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_decisions_scope_idx ON review_decisions(project_id, episode_id, version_id, thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS review_idempotency (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS review_gate_requirements (
  project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  block_on_required_findings boolean NOT NULL DEFAULT true,
  require_decision_for_release boolean NOT NULL DEFAULT false,
  minimum_approvals integer NOT NULL DEFAULT 1 CHECK (minimum_approvals >= 0 AND minimum_approvals <= 100),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS review_replay_checkpoints (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  version_id text NOT NULL REFERENCES version_records(id) ON DELETE RESTRICT,
  replay_hash char(64) NOT NULL,
  event_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version_id)
);

CREATE OR REPLACE FUNCTION forge_review_thread_tenant_guard() RETURNS trigger AS $$
DECLARE v_tenant text; v_project text; v_episode text;
BEGIN
  SELECT p.tenant_id, p.id, e.id INTO v_tenant, v_project, v_episode
  FROM version_records v JOIN episodes e ON e.id=v.episode_id JOIN projects p ON p.id=e.project_id
  WHERE v.id=NEW.version_id;
  IF v_tenant IS NULL OR v_tenant<>NEW.tenant_id OR v_project<>NEW.project_id OR v_episode<>NEW.episode_id THEN
    RAISE EXCEPTION 'review thread provenance scope mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM tenants t WHERE t.id=NEW.tenant_id AND t.lifecycle_state<>'ACTIVE') THEN
    RAISE EXCEPTION 'tenant lifecycle blocks review mutation';
  END IF;
  IF EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.lifecycle_state<>'ACTIVE') THEN
    RAISE EXCEPTION 'project lifecycle blocks review mutation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS review_thread_scope_guard ON review_threads;
CREATE TRIGGER review_thread_scope_guard BEFORE INSERT OR UPDATE OF tenant_id,project_id,episode_id,version_id ON review_threads FOR EACH ROW EXECUTE FUNCTION forge_review_thread_tenant_guard();

CREATE OR REPLACE FUNCTION forge_review_comment_scope_guard() RETURNS trigger AS $$
DECLARE t_tenant text; t_project text;
BEGIN
  SELECT tenant_id, project_id INTO t_tenant,t_project FROM review_threads WHERE id=NEW.thread_id;
  IF t_tenant IS NULL OR t_tenant<>NEW.tenant_id OR t_project<>NEW.project_id THEN RAISE EXCEPTION 'review comment scope mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS review_comment_scope_guard ON review_comment_revisions;
CREATE TRIGGER review_comment_scope_guard BEFORE INSERT OR UPDATE OF tenant_id,project_id,thread_id ON review_comment_revisions FOR EACH ROW EXECUTE FUNCTION forge_review_comment_scope_guard();

COMMIT;
