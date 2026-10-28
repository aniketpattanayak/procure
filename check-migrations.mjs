import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';

const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

// Check which migrations have run
console.log('\n═══ Migrations run on Render ═══');
try {
  const { rows } = await db.query(`SELECT * FROM platform.migration_log ORDER BY ran_at`);
  rows.forEach(r => console.log(' ', r.name ?? r.filename ?? r.migration ?? JSON.stringify(r)));
} catch(e) {
  console.log('No migration_log table:', e.message);
}

// Try drizzle migrations table
try {
  const { rows } = await db.query(`SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at`);
  rows.forEach(r => console.log(' ', r.hash, r.created_at));
} catch(e) {
  console.log('No drizzle migrations:', e.message);
}

// Check what platform tables exist
console.log('\n═══ Platform tables ═══');
const { rows: ptables } = await db.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'platform' ORDER BY table_name
`);
console.log(ptables.map(t => t.table_name).join(', '));

// Check what app tables exist
console.log('\n═══ App tables ═══');
const { rows: atables } = await db.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'app' ORDER BY table_name
`);
console.log(atables.map(t => t.table_name).join(', '));

// All platform permission tab keys
console.log('\n═══ All platform permission TABs ═══');
const { rows: tabs } = await db.query(`SELECT key, requires_feature FROM platform.permission_def WHERE kind = 'tab' ORDER BY sort_order`);
tabs.forEach(t => console.log(` ${t.key} [${t.requires_feature ?? 'always'}]`));

await db.end();
