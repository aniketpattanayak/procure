/**
 * check-doctypes.mjs — find out why Indent/PO/GRN are missing
 * Run: node ~/Desktop/OMM_SYS/procure/check-doctypes.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const API = 'https://procure-api-2g2v.onrender.com/api/v1';
const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

const T = async (sql, params=[]) => {
  await db.query('BEGIN');
  await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
  const r = await db.query(sql, params);
  await db.query('COMMIT');
  return r;
};

// ─── 1. doc_type table shape ─────────────────────────────────────────────────
console.log('\n═══ 1. app.doc_type columns ═══');
const { rows: cols } = await db.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema='app' AND table_name='doc_type' ORDER BY ordinal_position
`);
cols.forEach(c => console.log(`  ${c.column_name} ${c.data_type} ${c.is_nullable==='NO'?'NOT NULL':''} ${c.column_default?'default '+c.column_default:''}`));

// ─── 2. existing doc_type rows for Jeevaka ───────────────────────────────────
console.log('\n═══ 2. app.doc_type rows for Jeevaka ═══');
const { rows: dts } = await T(`SELECT * FROM app.doc_type WHERE tenant_id=$1 ORDER BY sort_order NULLS LAST`, [TENANT_ID]);
if (!dts.length) console.log('  *** NONE — this is the problem ***');
dts.forEach(d => console.log('  ', JSON.stringify(d)));

// ─── 3. CHECK constraints on doc_type (what values are legal) ────────────────
console.log('\n═══ 3. CHECK constraints on app.doc_type ═══');
const { rows: checks } = await db.query(`
  SELECT con.conname, pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname='app' AND rel.relname='doc_type'
`);
checks.forEach(c => console.log(`  ${c.conname}: ${c.def}`));

// ─── 4. form table — doc forms vs master forms ───────────────────────────────
console.log('\n═══ 4. app.form rows for Jeevaka ═══');
const { rows: formCols } = await db.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema='app' AND table_name='form' ORDER BY ordinal_position
`);
console.log('  form columns:', formCols.map(c=>c.column_name).join(', '));
const { rows: forms } = await T(`SELECT * FROM app.form WHERE tenant_id=$1`, [TENANT_ID]);
forms.forEach(f => console.log(`   ${f.code ?? f.key} kind=${f.kind ?? f.scope ?? '?'} id=${f.id}`));

// ─── 5. What does the API say? ───────────────────────────────────────────────
console.log('\n═══ 5. API /doc-types ═══');
const login = await fetch(`${API}/auth/login`, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ email:'admin@jeevaka.local', password:'Jeevaka@2026', tenantCode:'jeevaka' })
});
const { accessToken } = await login.json();
const H = { 'Authorization': `Bearer ${accessToken}` };

for (const p of ['/doc-types','/document-types','/docTypes','/documents/types','/config/doc-types']) {
  const r = await fetch(`${API}${p}`, { headers: H });
  const t = await r.text();
  console.log(`  ${p} → ${r.status}: ${t.slice(0,400)}`);
}

// ─── 6. What nav/tabs does the API expose? ───────────────────────────────────
console.log('\n═══ 6. API nav / tabs endpoints ═══');
for (const p of ['/nav','/me/nav','/navigation','/me/tabs','/tabs','/me']) {
  const r = await fetch(`${API}${p}`, { headers: H });
  const t = await r.text();
  console.log(`  ${p} → ${r.status}: ${t.slice(0,300)}`);
}

await db.end();
console.log('\nDone.');
