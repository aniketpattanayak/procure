/**
 * fix-locations.mjs
 *
 * PROBLEM: /api/v1/locations returns 500 Internal Server Error
 * This blocks creating an Indent (Location is a required field).
 *
 * THIS SCRIPT:
 * 1. Checks if app.location_node table exists
 * 2. Checks if ltree extension is enabled
 * 3. Seeds at least one location (Head Office) for the Jeevaka tenant
 * 4. Tests the /api/v1/locations endpoint after seeding
 *
 * Run: node ~/Desktop/OMM_SYS/procure/fix-locations.mjs
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9?sslmode=require';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';
const API       = 'https://procure-api-2g2v.onrender.com/api/v1';

const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();
console.log('✓ Connected to Render DB\n');

const step = s => console.log(`\n═══ ${s} ═══`);

const tenantTx = async (fn) => {
  await db.query('BEGIN');
  await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
  try {
    const r = await fn();
    await db.query('COMMIT');
    return r;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
};

// 1. Check ltree
step('1. Check ltree extension');
const { rows: ltreeRows } = await db.query(
  `SELECT extname, extversion FROM pg_extension WHERE extname = 'ltree'`
);
if (ltreeRows.length > 0) {
  console.log(`  ✓ ltree installed (v${ltreeRows[0].extversion})`);
} else {
  console.log('  ✗ ltree NOT installed');
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS ltree');
    console.log('  ✓ ltree installed now');
  } catch (e) {
    console.log(`  ✗ Cannot install ltree: ${e.message}`);
  }
}

// 2. Check tables
step('2. Location-related tables in app schema');
const { rows: tableRows } = await db.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'app' AND table_name IN ('location_node', 'location', 'locations')
  ORDER BY table_name
`);
if (tableRows.length === 0) {
  console.log('  ✗ No location tables found!');
  const { rows: allTables } = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='app' ORDER BY table_name`);
  console.log('  All app tables:', allTables.map(t => t.table_name).join(', '));
} else {
  tableRows.forEach(t => console.log(`  ✓ app.${t.table_name} exists`));
}

// 3. Inspect location_node
if (tableRows.some(t => t.table_name === 'location_node')) {
  step('3. app.location_node columns');
  const { rows: cols } = await db.query(`
    SELECT column_name, udt_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'location_node'
    ORDER BY ordinal_position
  `);
  cols.forEach(c => console.log(`  ${c.column_name.padEnd(20)} ${(c.udt_name||c.data_type).padEnd(20)} ${c.is_nullable==='NO'?'NOT NULL':''}`));

  // 4. Existing rows
  step('4. Existing location rows for Jeevaka tenant');
  let existing = [];
  try {
    const res = await tenantTx(() =>
      db.query(`SELECT id, code, name, depth, is_active, path::text as path FROM app.location_node WHERE tenant_id=$1 ORDER BY depth, name`, [TENANT_ID])
    );
    existing = res.rows;
  } catch(e) {
    console.log(`  ✗ Error reading: ${e.message}`);
    // Try without tenant filter
    try {
      const res2 = await db.query(`SELECT id, code, name, depth, is_active FROM app.location_node LIMIT 5`);
      console.log(`  Without RLS filter: ${res2.rows.length} rows`);
      res2.rows.forEach(r => console.log(`    code=${r.code} name=${r.name}`));
    } catch(e2) {
      console.log(`  Also failed without filter: ${e2.message}`);
    }
  }

  if (existing.length > 0) {
    console.log(`  ✓ ${existing.length} locations already exist:`);
    existing.forEach(r => console.log(`    ${(r.path||'?').padEnd(30)} ${r.name} active=${r.is_active}`));
  } else {
    console.log('  ✗ Zero rows — seeding now...');

    // 5. Seed
    step('5. Seeding locations');
    const hasTenantId = cols.some(c => c.column_name === 'tenant_id');
    const hasVersion  = cols.some(c => c.column_name === 'version');
    const hasSortOrder = cols.some(c => c.column_name === 'sort_order');
    const pathType    = cols.find(c => c.column_name === 'path')?.udt_name;
    const pathCast    = pathType === 'ltree' ? '::ltree' : '';

    const { rows: uuidFnRows } = await db.query(`SELECT proname FROM pg_proc WHERE proname='uuid_v7' LIMIT 1`);
    const uuidFn = uuidFnRows.length ? 'app.uuid_v7()' : 'gen_random_uuid()';
    console.log(`  uuid fn: ${uuidFn}, path type: ${pathType}, has tenant_id: ${hasTenantId}`);

    // Locations to seed
    const locs = [
      { code: 'HO',    name: 'Head Office',  depth: 0, parentCode: null, sortOrder: 1 },
      { code: 'PROD',  name: 'Production',   depth: 1, parentCode: 'HO', sortOrder: 1 },
      { code: 'STORE', name: 'Store Room',   depth: 1, parentCode: 'HO', sortOrder: 2 },
      { code: 'ADMIN', name: 'Admin Block',  depth: 1, parentCode: 'HO', sortOrder: 3 },
    ];

    const insertedIds = {};
    const insertedPaths = {};

    for (const loc of locs) {
      const parentId = loc.parentCode ? insertedIds[loc.parentCode] : null;
      const parentPath = loc.parentCode ? insertedPaths[loc.parentCode] : null;
      const path = parentPath ? `${parentPath}.${loc.code.toLowerCase()}` : loc.code.toLowerCase();

      const colParts = ['id', 'code', 'name', 'depth', 'parent_id', 'is_active'];
      const valParts = [`${uuidFn}`, '$1', '$2', '$3', '$4', 'true'];
      const params   = [loc.code, loc.name, loc.depth, parentId];

      // path column
      colParts.push('path');
      valParts.push(`$${params.length+1}${pathCast}`);
      params.push(path);

      if (hasTenantId) {
        colParts.push('tenant_id');
        valParts.push(`$${params.length+1}`);
        params.push(TENANT_ID);
      }
      if (hasSortOrder) {
        colParts.push('sort_order');
        valParts.push(`$${params.length+1}`);
        params.push(loc.sortOrder);
      }
      if (hasVersion) {
        colParts.push('version');
        valParts.push('1');
      }

      const sql = `INSERT INTO app.location_node (${colParts.join(', ')}) VALUES (${valParts.join(', ')}) RETURNING id, code, path::text as path`;

      try {
        await db.query('BEGIN');
        await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);
        const { rows: [ins] } = await db.query(sql, params);
        await db.query('COMMIT');
        insertedIds[loc.code] = ins.id;
        insertedPaths[loc.code] = ins.path;
        console.log(`  ✓ ${ins.path} (${loc.name}) → ${ins.id}`);
      } catch (e) {
        await db.query('ROLLBACK').catch(()=>{});
        console.log(`  ✗ ${loc.code}: ${e.message}`);
        // Try without transaction RLS
        try {
          const sql2 = sql.replace('RETURNING id, code, path::text as path',
            hasTenantId ? 'RETURNING id, code' : 'RETURNING id, code');
          const { rows: [ins2] } = await db.query(sql.replace(pathCast||'::ltree',''), params);
          insertedIds[loc.code] = ins2.id;
          insertedPaths[loc.code] = path;
          console.log(`  ✓ fallback insert ok: id=${ins2.id}`);
        } catch(e2) {
          console.log(`  ✗ fallback also failed: ${e2.message}`);
        }
      }
    }
  }
}

// 6. Test API
step('6. Test /api/v1/locations after fix');
try {
  const loginRes = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@jeevaka.local', password: 'Jeevaka@2026', tenantCode: 'jeevaka' })
  });
  const lj = await loginRes.json();
  const token = lj.accessToken;
  console.log(`  Login: ${loginRes.status} ${token ? '✓' : '✗ - ' + JSON.stringify(lj)}`);

  if (token) {
    for (const ep of ['/locations?view=active&scope=mine', '/locations/tree']) {
      const r = await fetch(`${API}${ep}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const body = await r.text();
      console.log(`\n  GET ${ep} → ${r.status}`);
      console.log(`  ${body.slice(0, 600)}`);
    }
  }
} catch(e) {
  console.log(`  ✗ API test: ${e.message}`);
}

// 7. Department check
step('7. Check departments (needed for Indent form)');
try {
  const { rows: depts } = await tenantTx(() =>
    db.query(`SELECT id, code, name, is_active FROM app.department WHERE tenant_id=$1 ORDER BY name LIMIT 10`, [TENANT_ID])
  );
  if (depts.length === 0) {
    console.log('  ✗ No departments! Seeding one...');
    await tenantTx(async () => {
      const { rows: uuidFnRows } = await db.query(`SELECT proname FROM pg_proc WHERE proname='uuid_v7' LIMIT 1`);
      const uuidFn = uuidFnRows.length ? 'app.uuid_v7()' : 'gen_random_uuid()';
      await db.query(`
        INSERT INTO app.department (id, tenant_id, code, name, is_active)
        VALUES (${uuidFn}, $1, 'GEN', 'General', true)
        ON CONFLICT DO NOTHING
      `, [TENANT_ID]);
    });
    console.log('  ✓ Seeded department: General');
  } else {
    console.log(`  ✓ ${depts.length} departments:`);
    depts.forEach(d => console.log(`    ${d.code} — ${d.name} active=${d.is_active}`));
  }
} catch(e) {
  console.log(`  ✗ Department check: ${e.message}`);
}

await db.end();
console.log('\n✓ Done. Now reload the Indent form and try picking a Location.');
