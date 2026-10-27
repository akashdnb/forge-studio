BEGIN;

ALTER FUNCTION forge_rights_resolve(text,text,text,text,text,timestamptz) RENAME TO forge_rights_resolve_raw;

CREATE OR REPLACE FUNCTION forge_rights_resolve(p_episode_id text,p_root_artifact_id text,p_use text,p_destination text,p_territory text,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw jsonb;
  diagnostics jsonb;
  resolved jsonb;
  item jsonb;
  common_uses jsonb := NULL;
  common_territories jsonb := NULL;
  common_destinations jsonb := NULL;
  item_uses jsonb;
  item_territories jsonb;
  item_destinations jsonb;
  first_item boolean := true;
  conflict boolean := false;
  decision text;
BEGIN
  raw := forge_rights_resolve_raw(p_episode_id,p_root_artifact_id,p_use,p_destination,p_territory,p_at);
  diagnostics := COALESCE(raw->'diagnostics','[]'::jsonb);
  resolved := COALESCE(raw->'resolved','[]'::jsonb);
  FOR item IN SELECT value FROM jsonb_array_elements(resolved) LOOP
    item_uses := COALESCE(item->'permittedUses','[]'::jsonb);
    item_territories := COALESCE(item->'territories','[]'::jsonb);
    item_destinations := COALESCE(item->'destinations','[]'::jsonb);
    IF first_item THEN
      common_uses := item_uses;
      common_territories := item_territories;
      common_destinations := item_destinations;
      first_item := false;
    ELSE
      IF jsonb_array_length(common_uses)>0 AND jsonb_array_length(item_uses)>0 THEN
        SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO common_uses
        FROM (SELECT jsonb_array_elements_text(common_uses) value INTERSECT SELECT jsonb_array_elements_text(item_uses) value) x;
      END IF;
      IF jsonb_array_length(common_territories)>0 AND jsonb_array_length(item_territories)>0 THEN
        SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO common_territories
        FROM (SELECT jsonb_array_elements_text(common_territories) value INTERSECT SELECT jsonb_array_elements_text(item_territories) value) x;
      END IF;
      IF jsonb_array_length(common_destinations)>0 AND jsonb_array_length(item_destinations)>0 THEN
        SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO common_destinations
        FROM (SELECT jsonb_array_elements_text(common_destinations) value INTERSECT SELECT jsonb_array_elements_text(item_destinations) value) x;
      END IF;
    END IF;
  END LOOP;
  IF NOT first_item THEN
    IF jsonb_array_length(common_uses)=0 THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_CONFLICT','field','permittedUses')); conflict:=true; END IF;
    IF jsonb_array_length(common_territories)=0 AND EXISTS (SELECT 1 FROM jsonb_array_elements(resolved) x WHERE jsonb_array_length(COALESCE(x->'territories','[]'::jsonb))>0) THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_CONFLICT','field','territories')); conflict:=true; END IF;
    IF jsonb_array_length(common_destinations)=0 AND EXISTS (SELECT 1 FROM jsonb_array_elements(resolved) x WHERE jsonb_array_length(COALESCE(x->'destinations','[]'::jsonb))>0) THEN diagnostics := diagnostics || jsonb_build_array(jsonb_build_object('code','RIGHTS_CONFLICT','field','destinations')); conflict:=true; END IF;
  END IF;
  decision := CASE WHEN jsonb_array_length(diagnostics)=0 THEN 'ALLOW' ELSE 'BLOCK' END;
  RETURN jsonb_build_object('decision',decision,'diagnostics',diagnostics,'resolved',resolved,'effectiveUntil',raw->'effectiveUntil','embargoUntil',raw->'embargoUntil','conflict',conflict,'derivativeBlocked',COALESCE((raw->>'derivativeBlocked')::boolean,false),'effectivePermittedUses',COALESCE(common_uses,'[]'::jsonb),'effectiveTerritories',COALESCE(common_territories,'[]'::jsonb),'effectiveDestinations',COALESCE(common_destinations,'[]'::jsonb));
END;
$$;

COMMIT;
