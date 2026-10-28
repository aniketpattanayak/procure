-- ══════════════════════════════════════════════════════════════
-- FIX: path column is text, needs to be ltree
-- ══════════════════════════════════════════════════════════════

-- 1. Confirm current type
SELECT column_name, udt_name, data_type 
FROM information_schema.columns 
WHERE table_schema = 'app' AND table_name = 'location_node' AND column_name = 'path';

-- 2. Change path column from text → ltree
ALTER TABLE app.location_node 
  ALTER COLUMN path TYPE ltree USING path::ltree;

-- 3. Confirm fix
SELECT column_name, udt_name, data_type 
FROM information_schema.columns 
WHERE table_schema = 'app' AND table_name = 'location_node' AND column_name = 'path';

-- 4. Recreate the GiST index (needed for ltree performance)
DROP INDEX IF EXISTS app.location_node_path;
CREATE INDEX location_node_path ON app.location_node USING gist (path);

-- 5. Verify the @> operator now works
SET "app.tenant_id" = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

SELECT n.code, n.name, n.depth, n.path::text,
  (SELECT array_agg(a.name ORDER BY a.depth) 
   FROM app.location_node a 
   WHERE a.path @> n.path AND a.id <> n.id) as path_names
FROM app.location_node n
WHERE n.is_active
ORDER BY n.depth, n.sort_order
LIMIT 10;
