/**
 * fix-role-permissions3.mjs — direct DB approach
 * Reads the exact table that stores role→permission grants,
 * then inserts all needed rows directly.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

// ─── Step 1: Find the grant table ────────────────────────────────────────────
console.log('\n═══ Step 1: Find role permission grant table ═══');
const { rows: tables } = await db.query(`
  SELECT table_name, obj_description(pgc.oid) as comment
  FROM information_schema.tables t
  JOIN pg_class pgc ON pgc.relname = t.table_name
  WHERE table_schema = 'app' AND table_name ILIKE '%grant%' OR table_name ILIKE '%perm%' OR table_name ILIKE '%role%'
  ORDER BY table_name
`);
console.log('Candidate tables:', tables.map(t => t.table_name).join(', '));

// ─── Step 2: Describe those tables ───────────────────────────────────────────
console.log('\n═══ Step 2: Table columns ═══');
for (const t of tables) {
  const { rows: cols } = await db.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = $1
    ORDER BY ordinal_position
  `, [t.table_name]);
  console.log(`\n  app.${t.table_name}:`, cols.map(c => `${c.column_name}(${c.data_type})`).join(', '));
}

// ─── Step 3: Sample rows from each ───────────────────────────────────────────
console.log('\n═══ Step 3: Sample rows ═══');
for (const t of tables) {
  try {
    await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
    const { rows } = await db.query(`SELECT * FROM app.${t.table_name} LIMIT 3`);
    console.log(`  app.${t.table_name} (${rows.length} sample rows):`, JSON.stringify(rows).slice(0, 300));
  } catch(e) {
    console.log(`  app.${t.table_name}: ${e.message}`);
  }
}

await db.end();
