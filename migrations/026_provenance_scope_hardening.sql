BEGIN;

CREATE OR REPLACE FUNCTION forge_evidence_node_scope_guard() RETURNS trigger AS $$
DECLARE project_tenant text;
BEGIN
  SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id FOR SHARE;
  IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'evidence node tenant/project scope mismatch';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_evidence_node_scope_guard ON forge_evidence_nodes;
CREATE TRIGGER forge_evidence_node_scope_guard BEFORE INSERT ON forge_evidence_nodes FOR EACH ROW EXECUTE FUNCTION forge_evidence_node_scope_guard();

CREATE OR REPLACE FUNCTION forge_evidence_snapshot_scope_guard() RETURNS trigger AS $$
DECLARE project_tenant text;
BEGIN
  SELECT tenant_id INTO project_tenant FROM projects WHERE id=NEW.project_id FOR SHARE;
  IF project_tenant IS NULL OR project_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'evidence snapshot tenant/project scope mismatch';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS forge_evidence_snapshot_scope_guard ON forge_evidence_snapshots;
CREATE TRIGGER forge_evidence_snapshot_scope_guard BEFORE INSERT ON forge_evidence_snapshots FOR EACH ROW EXECUTE FUNCTION forge_evidence_snapshot_scope_guard();

COMMIT;
