DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['media_validation_policies','media_validation_records','media_validation_overrides','media_quarantine'] LOOP
    IF to_regclass('public.'||table_name) IS NOT NULL AND to_regprocedure('public.forge_capture_evidence()') IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS evidence_capture_%s ON %I', table_name, table_name);
      EXECUTE format('CREATE TRIGGER evidence_capture_%s AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_capture_evidence()', table_name, table_name);
    END IF;
  END LOOP;
END $$;
