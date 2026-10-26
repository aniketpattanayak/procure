#!/usr/bin/env node
/**
 * Performance seed: N (default 50,000) Item records for tenant `acme` in ONE master (`item`), inserted with SQL as
 * the DB owner (bypasses the API; data shaped exactly like API-saved items: uom / category / sub_category lookups by id,
 * decimal strings, formula value, current form version).
 *
 *   node load/phase-2/seed-master-records.mjs [count=50000]
 *
 * Idempotent: removes earlier perf rows (code LIKE 'PERF-%') first. Also inserts the matching record_ref rows so
 * delete protection / usage queries see a realistic reference table. Run `ANALYZE` at the end.
 */
import pg from 'pg';

const COUNT = Number(process.argv[2] ?? 50_000);
const url = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure';
const c = new pg.Client({ connectionString: url });
await c.connect();

const one = async (q, p = []) => (await c.query(q, p)).rows[0];
const t = await one(`select id from platform.tenant where code = 'acme'`);
if (!t) throw new Error('tenant acme not found — run pnpm db:seed first');
const m = await one(`select d.id, d.form_id, f.current_version_id from app.master_def d join app.form_def f on f.id = d.form_id
  where d.tenant_id = $1 and d.key = 'item'`, [t.id]);
const ids = async key => (await c.query(`select r.id, r.code from app.master_record r join app.master_def d on d.id = r.master_id
  where r.tenant_id = $1 and d.key = $2 and not r.is_deleted order by r.code`, [t.id, key])).rows;
const uoms = await ids('uom');
const cats = await ids('item_category');
const subs = (await c.query(`select r.id, r.code, r.data->>'category' as category from app.master_record r join app.master_def d on d.id = r.master_id
  where r.tenant_id = $1 and d.key = 'item_subcategory' and not r.is_deleted`, [t.id])).rows;
if (!uoms.length || !cats.length) throw new Error('acme seed masters missing');

console.log(`acme ${t.id}: item master ${m.id}; ${uoms.length} UoMs, ${cats.length} categories, ${subs.length} sub-categories`);
const started = Date.now();
await c.query('begin');
await c.query(`select set_config('app.tenant_id', $1, true)`, [t.id]);
const old = await c.query(`delete from app.record_ref where tenant_id = $1 and from_kind = 'master_record' and from_id in
  (select id from app.master_record where tenant_id = $1 and master_id = $2 and code::text like 'PERF-%')`, [t.id, m.id]);
const oldRec = await c.query(`delete from app.master_record where tenant_id = $1 and master_id = $2 and code::text like 'PERF-%'`, [t.id, m.id]);
if (oldRec.rowCount) console.log(`removed ${oldRec.rowCount} earlier perf rows (${old.rowCount} refs)`);

// Words make names realistic for prefix search ("bolt", "steel" ...) and give the planner a spread of values.
const words = ['Steel', 'Copper', 'Aluminium', 'Brass', 'Carton', 'Bolt', 'Nut', 'Washer', 'Bearing', 'Valve', 'Pipe', 'Flange',
  'Gasket', 'Cable', 'Switch', 'Motor', 'Pump', 'Filter', 'Hose', 'Clamp', 'Spring', 'Sheet', 'Plate', 'Rod', 'Wire', 'Paint',
  'Grease', 'Oil', 'Glove', 'Tape'];
await c.query(`
  insert into app.master_record (tenant_id, master_id, code, name, data, form_version_id, is_active)
  select $1::uuid, $2::uuid,
         'PERF-' || lpad(g::text, 6, '0'),
         ($6::text[])[1 + (g % array_length($6::text[], 1))] || ' ' || ($6::text[])[1 + ((g / 7) % array_length($6::text[], 1))] || ' ' || g,
         jsonb_strip_nulls(jsonb_build_object(
           'uom', ($4::uuid[])[1 + (g % array_length($4::uuid[], 1))],
           'category', cat.id,
           'sub_category', (select s.id from unnest($7::uuid[], $8::uuid[]) as s(id, category) where s.category = cat.id
                            order by s.id offset (g % greatest(1, (select count(*) from unnest($8::uuid[]) x where x = cat.id))) limit 1),
           'hsn_code', lpad((1000 + g % 8000)::text, 4, '0'),
           'pack_qty', ((g % 50) + 1)::text,
           'std_rate', round((10 + (g % 997) * 1.37)::numeric, 2)::text,
           'std_pack_value', round(((10 + (g % 997) * 1.37) * ((g % 50) + 1))::numeric, 2)::text,
           'track_batch', (g % 3 = 0),
           'track_expiry', false)),
         $3::uuid,
         (g % 10 <> 0)
  from generate_series(1, $5::int) g
  cross join lateral (select ($9::uuid[])[1 + (g % array_length($9::uuid[], 1))] as id) cat`,
[t.id, m.id, m.current_version_id, uoms.map(u => u.id), COUNT, words, subs.map(s => s.id), subs.map(s => s.category), cats.map(x => x.id)]);

// record_ref rows for the lookups (what the API's save pipeline writes).
await c.query(`
  insert into app.record_ref (tenant_id, from_kind, from_id, from_field, to_kind, to_id)
  select r.tenant_id, 'master_record', r.id, f.key, 'master_record', (r.data->>f.key)::uuid
  from app.master_record r cross join (values ('uom'), ('category'), ('sub_category')) f(key)
  where r.tenant_id = $1 and r.master_id = $2 and r.code::text like 'PERF-%' and r.data ? f.key`, [t.id, m.id]);
await c.query('commit');
await c.query('analyze app.master_record');
await c.query('analyze app.record_ref');
const n = await one(`select count(*)::int as n, count(*) filter (where is_active)::int as active from app.master_record where tenant_id = $1 and master_id = $2`, [t.id, m.id]);
console.log(`item master now has ${n.n} records (${n.active} active); seeded ${COUNT} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
await c.end();
