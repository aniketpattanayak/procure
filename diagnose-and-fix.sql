-- ══════════════════════════════════════════════════
-- Run this in Render DB shell or psql to fix locations
-- ══════════════════════════════════════════════════

-- 1. Check ltree
SELECT CASE WHEN COUNT(*) > 0 THEN '✓ ltree OK' ELSE '✗ ltree MISSING' END 
FROM pg_extension WHERE extname = 'ltree';

-- 2. Install ltree if missing (needs superuser - Render usually allows this)
CREATE EXTENSION IF NOT EXISTS ltree;

-- 3. Check table
SELECT CASE WHEN COUNT(*) > 0 THEN '✓ location_node table EXISTS' ELSE '✗ TABLE MISSING' END
FROM information_schema.tables 
WHERE table_schema='app' AND table_name='location_node';

-- 4. Check existing rows
SELECT COUNT(*) as "locations in DB" FROM app.location_node;

-- 5. Seed locations (trigger auto-sets path/depth, so we don't pass them)
DO $$
DECLARE
  v_tenant uuid := '01a17d6a-ce85-7c29-a7d7-719d8dae970a';
  v_count int;
  v_ho uuid;
BEGIN
  SELECT COUNT(*) INTO v_count FROM app.location_node WHERE tenant_id = v_tenant;
  IF v_count > 0 THEN
    RAISE NOTICE 'Already % locations exist - skipping', v_count;
    RETURN;
  END IF;

  -- Set RLS context
  PERFORM set_config('app.tenant_id', v_tenant::text, true);

  -- Root: Head Office  
  INSERT INTO app.location_node (id, tenant_id, code, name, sort_order)
  VALUES (app.uuid_v7(), v_tenant, 'HO', 'Head Office', 1)
  RETURNING id INTO v_ho;
  RAISE NOTICE 'Head Office id=%', v_ho;

  -- Children
  INSERT INTO app.location_node (id, tenant_id, code, name, parent_id, sort_order) VALUES
    (app.uuid_v7(), v_tenant, 'PROD',  'Production',  v_ho, 1),
    (app.uuid_v7(), v_tenant, 'STORE', 'Store Room',  v_ho, 2),
    (app.uuid_v7(), v_tenant, 'ADMIN', 'Admin Block', v_ho, 3);
  RAISE NOTICE 'Child locations inserted';
END $$;

-- 6. Show result
SELECT code, name, depth, is_active, path::text FROM app.location_node ORDER BY depth, sort_order;
