#!/usr/bin/env node
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(join(here, 'apps/api/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const c = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await c.connect();

const schemas = await c.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast') ORDER BY 1`);
console.log('Schemas:', schemas.rows.map(r=>r.schema_name).join(', '));

const tables = await c.query(`SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('platform','app','public') ORDER BY 1,2`);
console.log('\nTables:');
tables.rows.forEach(r => console.log(`  ${r.table_schema}.${r.table_name}`));

const migs = await c.query(`SELECT filename FROM public._migration ORDER BY filename`).catch(()=>({rows:[]}));
console.log(`\n_migration rows: ${migs.rows.length}`);
migs.rows.forEach(r => console.log(`  ${r.filename}`));

await c.end();
