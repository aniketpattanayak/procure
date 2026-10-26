-- 0007 Fix app.consume_storage: `false OR NULL` produced NULL for warned_* when no threshold was crossed
-- (NOT NULL violation on every normal upload). Same function, coalesced flags. Owner: Architect.

CREATE OR REPLACE FUNCTION app.consume_storage(p_bytes bigint)
RETURNS TABLE (allowed boolean, used_bytes bigint, limit_bytes bigint, crossed text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, platform, app AS $$
DECLARE
  t uuid := app.current_tenant_id();
  gb bigint;
  lim bigint;
  m platform.usage_meter;
  after bigint;
BEGIN
  IF t IS NULL THEN RAISE EXCEPTION 'no tenant context'; END IF;
  gb := platform.effective_limit('storage_gb', t);
  lim := CASE WHEN gb IS NULL THEN NULL ELSE gb * 1073741824 END;
  INSERT INTO platform.usage_meter (tenant_id, limit_key, period) VALUES (t, 'storage_gb', 'lifetime') ON CONFLICT DO NOTHING;
  SELECT * INTO m FROM platform.usage_meter WHERE tenant_id = t AND limit_key = 'storage_gb' AND period = 'lifetime' FOR UPDATE;
  after := greatest(0, m.used + p_bytes);
  IF p_bytes > 0 AND lim IS NOT NULL AND after > lim THEN
    RETURN QUERY SELECT false, m.used::bigint, lim, NULL::text;
    RETURN;
  END IF;
  crossed := NULL;
  IF lim IS NOT NULL AND lim > 0 AND p_bytes > 0 THEN
    IF after >= lim AND NOT m.warned_100 THEN crossed := '100';
    ELSIF after * 100 >= lim * 80 AND NOT m.warned_80 THEN crossed := '80';
    END IF;
  END IF;
  UPDATE platform.usage_meter
     SET used = after, updated_at = now(),
         warned_80 = warned_80 OR coalesce(crossed IN ('80', '100'), false),
         warned_100 = warned_100 OR coalesce(crossed = '100', false)
   WHERE tenant_id = t AND limit_key = 'storage_gb' AND period = 'lifetime';
  RETURN QUERY SELECT true, after, lim, crossed;
END$$;
