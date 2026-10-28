/**
 * check-doctypes2.mjs — full diagnosis
 * Run: node ~/Desktop/OMM_SYS/procure/check-doctypes2.mjs
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
  try { const r = await db.query(sql, params); await db.query('COMMIT'); return r; }
  catch (e) { await db.query('ROLLBACK'); console.log('   ! ', e.message); return { rows: [] }; }
};

// ─── 1. doc_type rows ────────────────────────────────────────────────────────
console.log('\n═══ 1. app.doc_type rows for Jeevaka ═══');
const { rows: dts } = await T(`SELECT key, name, kind, module_key, header_form_id, line_form_id, is_active FROM app.doc_type WHERE tenant_id=$1`, [TENANT_ID]);
if (!dts.length) console.log('  *** ZERO ROWS — this is why Indent/PO/GRN are missing ***');
dts.forEach(d => console.log(`   ${d.key} | ${d.name} | kind=${d.kind} | module=${d.module_key} | active=${d.is_active}`));

// ─── 2. CHECK constraints — legal values for kind ────────────────────────────
console.log('\n═══ 2. CHECK constraints on app.doc_type ═══');
const { rows: checks } = await db.query(`
  SELECT con.conname, pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname='app' AND rel.relname='doc_type'
`);
checks.forEach(c => console.log(`   ${c.def}`));

// ─── 3. app.form shape + rows ────────────────────────────────────────────────
console.log('\n═══ 3. app.form columns ═══');
const { rows: fcols } = await db.query(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema='app' AND table_name='form' ORDER BY ordinal_position
`);
fcols.forEach(c => console.log(`   ${c.column_name} ${c.data_type}${c.is_nullable==='NO'?' NOT NULL':''}${c.column_default?' def '+c.column_default:''}`));

console.log('\n═══ 3b. CHECK constraints on app.form ═══');
const { rows: fchecks } = await db.query(`
  SELECT pg_get_constraintdef(con.oid) AS def
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname='app' AND rel.relname='form'
`);
fchecks.forEach(c => console.log(`   ${c.def}`));

console.log('\n═══ 3c. app.form rows for Jeevaka ═══');
const { rows: forms } = await T(`SELECT * FROM app.form WHERE tenant_id=$1`, [TENANT_ID]);
forms.forEach(f => {
  const o = {...f};
  if (o.definition) o.definition = JSON.stringify(o.definition).slice(0,80)+'...';
  console.log('  ', JSON.stringify(o).slice(0,300));
});

// ─── 4. API: doc types ───────────────────────────────────────────────────────
console.log('\n═══ 4. API endpoints ═══');
const login = await fetch(`${API}/auth/login`, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ email:'admin@jeevaka.local', password:'Jeevaka@2026', tenantCode:'jeevaka' })
});
const lj = await login.json();
const token = lj.accessToken ?? lj.token;
const H = { 'Authorization': `Bearer ${token}`, 'Content-Type':'application/json' };

for (const p of ['/doc-types','/document-types','/config/doc-types','/forms','/documents']) {
  const r = await fetch(`${API}${p}`, { headers: H });
  const t = await r.text();
  console.log(`   GET ${p} → ${r.status}: ${t.slice(0,500)}`);
}

// ─── 5. Platform owner login + feature override endpoint (save button issue) ──
console.log('\n═══ 5. Platform owner login ═══');
const pl = await fetch(`${API}/auth/login`, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ email:'owner@procure.local', password:'Owner@12345', tenantCode:'__platform__' })
});
console.log(`   tenantCode=__platform__ → ${pl.status}: ${(await pl.text()).slice(0,200)}`);

for (const code of ['platform','owner','root','admin','']) {
  const r = await fetch(`${API}/auth/login`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email:'owner@procure.local', password:'Owner@12345', tenantCode: code })
  });
  const t = await r.text();
  console.log(`   tenantCode="${code}" → ${r.status}: ${t.slice(0,120)}`);
}

await db.end();
console.log('\nDone.');
