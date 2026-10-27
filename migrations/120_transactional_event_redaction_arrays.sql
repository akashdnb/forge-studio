BEGIN;

CREATE OR REPLACE FUNCTION forge_redact_event_payload(p_payload jsonb) RETURNS jsonb AS $$
DECLARE result jsonb; k text; v jsonb;
BEGIN
  IF p_payload IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF jsonb_typeof(p_payload) = 'array' THEN
    SELECT COALESCE(jsonb_agg(forge_redact_event_payload(value)), '[]'::jsonb) INTO result FROM jsonb_array_elements(p_payload);
    RETURN result;
  END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN RETURN p_payload; END IF;
  result := '{}'::jsonb;
  FOR k,v IN SELECT key,value FROM jsonb_each(p_payload) LOOP
    IF lower(k) ~ '(password|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|credential)' THEN
      result := result || jsonb_build_object(k, '[REDACTED]');
    ELSE
      result := result || jsonb_build_object(k, forge_redact_event_payload(v));
    END IF;
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMIT;
