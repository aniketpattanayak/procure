#!/usr/bin/env node
/**
 * Phase 8 volume seed (SQL, set-based, as the DB owner). Run AFTER bootstrap-tenants.mjs.
 *
 * For each tenant it writes reference data (location tree, departments, items, vendors, users with roles and data
 * scopes, settings) and then a full, CONSISTENT procurement chain shaped exactly like API-written rows:
 *
 *   indent ──(ordered, line_link)──▶ PO ──(received / accepted)──▶ GRN ──(stock receipt)──▶ store issue (stock issue)
 *
 * - every quantity change is a line_event; line_qty_summary is DERIVED from the events with the same effect table as
 *   the QuantityLedger (so the nightly drift check is clean);
 * - workflow runtime rows (wf_instance / wf_stage_state / wf_line_state / wf_action) for every submitted document,
 *   with a realistic share pending (recent documents mostly, plus a stale tail) and SLA already escalated for overdue
 *   stages (keeps the SLA job quiet during measurements);
 * - stock_movement rows for every accepted GRN line (receipt) and approved issue line (issue); stock_balance and
 *   item_avg_cost are DERIVED from the movements; one unit cost per item (WAC stays exact); never negative (each
 *   issue line is backed by its own earlier receipt and takes ≤ 50 % of it);
 * - ids are uuid v7 of the row's own created_at (as the API would have produced), rows are inserted in time order;
 * - numbering counters are advanced past the seeded numbers, so API-created documents keep unique numbers.
 *
 *   DATABASE_MIGRATOR_URL=postgres://postgres@localhost:5432/procure_load node load/phase-8/seed-volume.mjs big
 *   DATABASE_MIGRATOR_URL=… node load/phase-8/seed-volume.mjs small [from=1] [to=200]
 *
 * Re-running a tenant is refused (it checks for seeded rows); reset the DB and re-bootstrap to start over.
 */
import pg from 'pg';

const mode = process.argv[2] ?? 'big';
const url = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_load';

const BIG = {
  plants: ['Pune', 'Chennai', 'Nashik', 'Hosur', 'Vadodara'], storesPer: 3, binsPer: 2, items: 2000, vendors: 200, depts: 8,
  indents: Number(process.env.INDENTS ?? 38_000), issueShare: 0.5, reorderRules: 4000, big150: true,
  users: { indenters: 12, approvers: 5, plantBuyers: 5, allBuyers: 3, keepers: 15, managers: 5, auditors: 5 },
};
const SMALL = {
  plants: ['Main'], storesPer: 2, binsPer: 1, items: 60, vendors: 10, depts: 3,
  indents: 80, issueShare: 0.5, reorderRules: 20, big150: false,
  users: { indenters: 1, approvers: 1, plantBuyers: 1, allBuyers: 0, keepers: 1, managers: 0, auditors: 0 },
};

const MATERIALS = ['MS', 'SS304', 'SS316', 'EN8', 'Brass', 'Copper', 'Aluminium', 'PVC', 'HDPE', 'Nylon', 'Cast Iron', 'GI', 'PTFE', 'Rubber', 'Teflon', 'Bronze', 'Carbon Steel', 'Alloy', 'Zinc', 'Titanium'];
const FORMS = ['Bolt', 'Nut', 'Washer', 'Flange', 'Pipe', 'Elbow', 'Valve', 'Gasket', 'Bearing', 'Coupling', 'Sheet', 'Plate', 'Rod', 'Bush', 'Shaft', 'Spring', 'Hose', 'Filter', 'Seal', 'Clamp'];
const VENDOR_A = ['Deccan', 'Coromandel', 'Mysore', 'Konkan', 'Malabar', 'Narmada', 'Kaveri', 'Sahyadri', 'Vindhya', 'Ganga', 'Godavari', 'Indus', 'Krishna', 'Tapi', 'Aravali', 'Nilgiri', 'Satpura', 'Thar', 'Doaba', 'Kutch'];
const VENDOR_B = ['Steel Traders', 'Metals', 'Industrial Supplies', 'Engineering Works', 'Hydraulics', 'Polymers', 'Fasteners', 'Bearings Co', 'Valves Pvt Ltd', 'Tools & Spares'];
const DEPTS = ['Maintenance', 'Production', 'Quality', 'Utilities', 'Projects', 'Stores', 'Tool Room', 'Safety'];

const c = new pg.Client({ connectionString: url });
await c.connect();
{
  const orig = c.query.bind(c);
  c.query = async (text, params) => {
    try { return await orig(text, params); } catch (e) {
      const pos = Number(e.position ?? 0);
      console.error(`SQL failed: ${e.message}\n${typeof text === 'string' ? (pos ? text.slice(Math.max(0, pos - 300), pos + 100) : text.slice(0, 600)) : ''}`);
      throw e;
    }
  };
}
const q = async (text, params = []) => (await c.query(text, params)).rows;
const one = async (text, params = []) => (await q(text, params))[0];
let tStep = Date.now();
const step = (label, quiet) => { const ms = Date.now() - tStep; tStep = Date.now(); if (!quiet) console.log(`  ${label.padEnd(44)} ${String(ms).padStart(7)} ms`); };

// ---------------------------------------------------------------------------------------------- SQL helpers
await c.query(`
  create or replace function pg_temp.r(n bigint, salt int) returns float8 language sql immutable as
    $$ select (abs(hashint8(n * 1000003 + salt)::bigint) % 1000000)::float8 / 1000000 $$;
  create or replace function pg_temp.u7(ts timestamptz, n bigint, salt int) returns uuid language sql immutable as $$
    select (lpad(to_hex((extract(epoch from ts) * 1000)::bigint), 12, '0') || '7' || substr(md5(n::text || ':' || salt), 1, 3)
      || substr('89ab', 1 + (abs(hashint8(n + salt)::bigint) % 4)::int, 1) || substr(md5(salt || ':' || n::text), 1, 15))::uuid $$;
  create or replace function pg_temp.fy(d date) returns text language sql immutable as $$
    select case when extract(month from d) >= 4 then extract(year from d)::int else extract(year from d)::int - 1 end || '-'
      || lpad((((case when extract(month from d) >= 4 then extract(year from d)::int else extract(year from d)::int - 1 end) + 1) % 100)::text, 2, '0') $$;
  create or replace function pg_temp.fys(d date) returns text language sql immutable as $$ select substr(pg_temp.fy(d), 3) $$;
`);

// Grants copied from the demo roles of tenant acme (the demo seed extends the bundle roles with the procurement /
// store keys); capex keys excluded. Extra roles: indent_clerk (acme), manager (approver ∪ buyer ∪ reports).
async function roleGrants() {
  const rows = await q(`select r.key, g.perm_key from app.permission_grant g join app.role r on r.id = g.role_id
    join platform.tenant t on t.id = g.tenant_id where t.code = 'acme' and r.key <> 'tenant_admin' and g.perm_key not like 'doc.capex%'`);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.key)) by.set(r.key, new Set()); by.get(r.key).add(r.perm_key); }
  const extra = ['reports', 'reports:action.view', 'reports:action.export', 'reports:action.schedule', 'dashboards', 'dashboards:action.view',
    'approvals', 'approvals:action.view', 'stock', 'stock:action.view', 'stock:action.view_value', 'stock:view.available', 'stock:view.quarantine', 'stock:view.rejected'];
  by.set('manager', new Set([...(by.get('approver') ?? []), ...(by.get('buyer') ?? []), ...extra]));
  for (const k of ['approver', 'store_keeper', 'buyer']) for (const e of ['reports', 'reports:action.view', 'reports:action.export', 'dashboards', 'dashboards:action.view', 'approvals', 'approvals:action.view']) by.get(k)?.add(e);
  for (const e of ['stock', 'stock:action.view', 'stock:view.available']) by.get('buyer')?.add(e);
  return by;
}

async function seedTenant(code, cfg, grants) {
  const t = await one(`select id from platform.tenant where code = $1`, [code]);
  if (!t) throw new Error(`tenant ${code} not found — run bootstrap-tenants.mjs first`);
  const tid = t.id;
  if ((await one(`select count(*)::int n from app.document where tenant_id = $1`, [tid])).n > 0) { console.log(`${code}: already seeded, skipped`); return; }
  const quiet = code !== 'big';
  console.log(`${code}: seeding …`);
  tStep = Date.now();
  await c.query(`select set_config('app.tenant_id', $1, false)`, [tid]);
  await c.query('begin');
  await c.query('set local synchronous_commit = off');
  // ---------------------------------------------------------------- context
  await c.query(`drop table if exists cfg, typ, taxes, uoms, wf, nd, itm, ven, dep, usr, i_doc, i_line, p_cand, p_doc, p_line, g_doc, g_line, s_cand, s_doc, s_line, ev, mv, docs_all, lines_all`);
  await c.query(`
    create temp table cfg as
    select $1::uuid tid, now() - interval '5 minutes' t_end, now() - interval '365 days' t0,
      (select id from app.tenant_user where tenant_id = $1 and is_tenant_admin order by created_at limit 1) admin_id`, [tid]);
  await c.query(`create temp table typ as
    select d.key, d.id, hf.current_version_id hv, lf.current_version_id lv, w.current_version_id wv,
      (select s.id from app.numbering_series s where s.tenant_id = d.tenant_id and s.doc_type_id = d.id and s.is_active and s.location_node_id is null) series,
      (select s.pattern from app.numbering_series s where s.tenant_id = d.tenant_id and s.doc_type_id = d.id and s.is_active and s.location_node_id is null) pattern
    from app.doc_type d join app.form_def hf on hf.id = d.header_form_id left join app.form_def lf on lf.id = d.line_form_id
    left join app.workflow_def w on w.doc_type_id = d.id and w.tenant_id = d.tenant_id
    where d.tenant_id = $1 and d.key in ('indent', 'po', 'grn', 'store_issue')`, [tid]);
  const types = await q(`select * from typ`);
  if (types.length !== 4 || types.some(x => !x.series || !x.wv)) throw new Error(`${code}: system types incomplete ${JSON.stringify(types)}`);
  // ---------------------------------------------------------------- settings
  await c.query(`insert into app.tenant_setting (tenant_id, key, value) values
      ($1, 'labels.location_levels', '["Plant", "Store", "Bin"]'), ($1, 'flow.vendor_selection.enabled', 'false')
    on conflict (tenant_id, key) do update set value = excluded.value`, [tid]);
  // ---------------------------------------------------------------- locations (triggers compute path/depth)
  const P = cfg.plants.length, S = cfg.storesPer, B = cfg.binsPer;
  await c.query(`insert into app.location_node (tenant_id, parent_id, code, name, sort_order)
    select $1, null, 'P' || p, ($2::text[])[p] || ' Plant', p from generate_series(1, $3::int) p`, [tid, cfg.plants, P]);
  await c.query(`insert into app.location_node (tenant_id, parent_id, code, name, sort_order)
    select $1, pl.id, 'P' || p || '-S' || s, ($2::text[])[p] || ' ' || (array['Main Store', 'Spares Store', 'RM Store', 'Tool Store'])[s], s
    from generate_series(1, $3::int) p cross join generate_series(1, $4::int) s join app.location_node pl on pl.tenant_id = $1 and pl.code = 'P' || p`, [tid, cfg.plants, P, S]);
  await c.query(`insert into app.location_node (tenant_id, parent_id, code, name, sort_order)
    select $1, st.id, st.code || '-B' || b, st.name || ' Bin ' || b, b
    from app.location_node st cross join generate_series(1, $2::int) b where st.tenant_id = $1 and st.depth = 2`, [tid, B]);
  // document / stock nodes = stores and bins; k = 1..N; store_k = the store index (1..P*S)
  await c.query(`create temp table nd as
    select row_number() over (order by n.path)::int k, n.id, n.depth, coalesce(case when n.depth = 2 then n.id end, n.parent_id) store_id,
      dense_rank() over (order by case when n.depth = 2 then n.code::text else split_part(n.code::text, '-B', 1) end)::int store_k,
      split_part(n.code::text, '-', 1) plant_code
    from app.location_node n where n.tenant_id = $1 and n.depth >= 2`, [tid]);
  await c.query(`create index on nd (k)`);
  const ND = (await one(`select count(*)::int n from nd`)).n;
  step(`locations (${P + ND})`, quiet);
  // ---------------------------------------------------------------- masters
  const mf = async key => one(`select m.id, f.current_version_id fv from app.master_def m join app.form_def f on f.id = m.form_id where m.tenant_id = $1 and m.key = $2`, [tid, key]);
  const [mItem, mVendor, mDept] = [await mf('item'), await mf('vendor'), await mf('department')];
  await c.query(`insert into app.master_record (tenant_id, master_id, code, name, data, form_version_id)
    select $1, $2, 'D' || lpad(d::text, 2, '0'), ($3::text[])[d], '{}', $4 from generate_series(1, $5::int) d`, [tid, mDept.id, DEPTS, mDept.fv, cfg.depts]);
  await c.query(`create temp table dep as select row_number() over (order by code)::int k, id from app.master_record where tenant_id = $1 and master_id = $2`, [tid, mDept.id]);
  await c.query(`create temp table taxes as select row_number() over (order by code)::int k, id, (data->>'rate_pct')::numeric pct from app.master_record r
    where tenant_id = $1 and master_id = (select id from app.master_def where tenant_id = $1 and key = 'tax_code')`, [tid]);
  await c.query(`create temp table uoms as select row_number() over (order by code)::int k, id from app.master_record r
    where tenant_id = $1 and master_id = (select id from app.master_def where tenant_id = $1 and key = 'uom')`, [tid]);
  await c.query(`
    insert into app.master_record (tenant_id, master_id, code, name, data, form_version_id)
    select $1, $2, 'ITM-' || lpad(i::text, 5, '0'),
      ($3::text[])[1 + i % 20] || ' ' || ($4::text[])[1 + (i / 20) % 20] || ' ' || (6 + (i * 7) % 90) || ' mm' || case when i > 400 then ' T' || (i / 400) else '' end,
      jsonb_build_object('uom', (select id from uoms where k = 1 + i % (select count(*) from uoms)), 'tax_code', (select id from taxes where k = 1 + i % (select count(*) from taxes)),
        'std_rate', to_char(5 + (pg_temp.r(i, 21) * 2000)::int + 0.5 * (i % 2), 'FM999990.00'), 'hsn_code', (7000 + i % 999)::text, 'pack_qty', '10.000',
        'track_batch', false, 'track_expiry', false),
      $5
    from generate_series(1, $6::int) i`, [tid, mItem.id, MATERIALS, FORMS, mItem.fv, cfg.items]);
  await c.query(`create temp table itm as select row_number() over (order by r.code)::int k, r.id, (r.data->>'uom')::uuid uom, (r.data->>'std_rate')::numeric rate,
      (r.data->>'tax_code')::uuid tax_code, tx.pct tax_pct
    from app.master_record r join taxes tx on tx.id = (r.data->>'tax_code')::uuid where r.tenant_id = $1 and r.master_id = $2`, [tid, mItem.id]);
  await c.query(`create index on itm (k)`);
  await c.query(`
    insert into app.master_record (tenant_id, master_id, code, name, data, form_version_id)
    select $1, $2, 'VEN-' || lpad(v::text, 4, '0'), ($3::text[])[1 + v % 20] || ' ' || ($4::text[])[1 + (v / 20) % 10] || case when v > 200 then ' ' || v else '' end,
      jsonb_build_object('pan', 'AAB' || upper(substr(md5(v::text), 1, 6)) || 'E', 'email', 'sales' || v || '@vendor.example',
        'gstin', (case when v % 3 = 0 then '33' else '27' end) || 'AAB' || upper(substr(md5(v::text), 1, 6)) || 'E1Z' || (v % 10),
        'state_code', case when v % 3 = 0 then '33' else '27' end, 'address', 'Industrial Estate ' || v),
      $5
    from generate_series(1, $6::int) v`, [tid, mVendor.id, VENDOR_A, VENDOR_B, mVendor.fv, cfg.vendors]);
  await c.query(`create temp table ven as select row_number() over (order by code)::int k, id from app.master_record where tenant_id = $1 and master_id = $2`, [tid, mVendor.id]);
  await c.query(`create index on ven (k)`);
  const [NI_ITEMS, NV] = [cfg.items, cfg.vendors];
  step(`masters (${cfg.items} items, ${cfg.vendors} vendors)`, quiet);
  // ---------------------------------------------------------------- roles, users, data scopes
  for (const [key, keys] of grants) {
    if (!['approver', 'buyer', 'store_keeper', 'indent_clerk', 'requester', 'manager'].includes(key)) continue;
    let role = await one(`select id from app.role where tenant_id = $1 and key = $2`, [tid, key]);
    role ??= await one(`insert into app.role (tenant_id, key, name, description) values ($1, $2, initcap(replace($2, '_', ' ')), 'Phase 8 load role') returning id`, [tid, key]);
    await c.query(`insert into app.permission_grant (tenant_id, role_id, perm_key, effect) select $1, $2, k, 'allow' from unnest($3::text[]) k
      on conflict do nothing`, [tid, role.id, [...keys]]);
  }
  const u = cfg.users;
  const plan = [];
  const nStores = P * S;
  for (let i = 1; i <= u.indenters; i++) plan.push({ kind: 'indenter', roles: ['indent_clerk', 'requester'], stores: Array.from({ length: nStores }, (_, s) => s + 1).filter(s => (s - 1) % u.indenters === i - 1) });
  for (let i = 1; i <= u.approvers; i++) plan.push({ kind: 'approver', roles: ['approver'], plant: P === 1 ? null : `P${i}` });
  for (let i = 1; i <= u.plantBuyers; i++) plan.push({ kind: 'buyer', roles: ['buyer'], plant: P === 1 ? null : `P${i}` });
  for (let i = 1; i <= u.allBuyers; i++) plan.push({ kind: 'buyer_all', roles: ['buyer'], plant: null });
  for (let i = 1; i <= u.keepers; i++) plan.push({ kind: 'keeper', roles: ['store_keeper'], stores: Array.from({ length: nStores }, (_, s) => s + 1).filter(s => (s - 1) % u.keepers === i - 1) });
  for (let i = 1; i <= u.managers; i++) plan.push({ kind: 'manager', roles: ['manager'], plant: null });
  for (let i = 1; i <= u.auditors; i++) plan.push({ kind: 'auditor', roles: ['approver'], plant: `P${1 + ((i - 1) % P)}` });
  const hash = (await one(`select password_hash from app.tenant_user where tenant_id = $1 and is_tenant_admin limit 1`, [tid])).password_hash;
  await c.query(`create temp table usr (kind text, idx int, id uuid, store_k int, plant_code text)`);
  const counters = {};
  for (const p of plan) {
    const idx = (counters[p.kind] = (counters[p.kind] ?? 0) + 1);
    const email = `${p.kind}${idx}@${code}.test`;
    const user = await one(`insert into app.tenant_user (tenant_id, email, name, password_hash, is_tenant_admin, must_change_password)
      values ($1, $2, $3, $4, false, false) returning id`, [tid, email, `${p.kind[0].toUpperCase()}${p.kind.slice(1).replace('_', ' ')} ${idx}`, hash]);
    for (const rk of p.roles) await c.query(`insert into app.user_role (tenant_id, user_id, role_id) select $1, $2, id from app.role where tenant_id = $1 and key = $3`, [tid, user.id, rk]);
    if (p.stores) {
      for (const s of p.stores) {
        await c.query(`insert into app.scope_grant (tenant_id, user_id, node_id, all_nodes, include_descendants) select $1, $2, store_id, false, true from nd where store_k = $3 limit 1`, [tid, user.id, s]);
        await c.query(`insert into usr values ($1, $2, $3, $4, null)`, [p.kind, idx, user.id, s]);
      }
    } else if (p.plant) {
      await c.query(`insert into app.scope_grant (tenant_id, user_id, node_id, all_nodes, include_descendants) select $1, $2, id, false, true from app.location_node where tenant_id = $1 and code = $3`, [tid, user.id, p.plant]);
      await c.query(`insert into usr values ($1, $2, $3, null, $4)`, [p.kind, idx, user.id, p.plant]);
    } else {
      await c.query(`insert into app.scope_grant (tenant_id, user_id, all_nodes, include_descendants) values ($1, $2, true, true)`, [tid, user.id]);
      await c.query(`insert into usr values ($1, $2, $3, null, null)`, [p.kind, idx, user.id]);
    }
  }
  // actors per node: indenter / keeper of its store, approver / buyer of its plant (or the all-node one)
  await c.query(`alter table nd add column indenter uuid, add column keeper uuid, add column approver uuid, add column buyer uuid`);
  await c.query(`update nd set indenter = (select id from usr where kind = 'indenter' and usr.store_k = nd.store_k limit 1),
    keeper = (select id from usr where kind = 'keeper' and usr.store_k = nd.store_k limit 1),
    approver = coalesce((select id from usr where kind = 'approver' and usr.plant_code = nd.plant_code limit 1), (select id from usr where kind = 'approver' order by idx limit 1)),
    buyer = coalesce((select id from usr where kind = 'buyer' and usr.plant_code = nd.plant_code limit 1), (select id from usr where kind in ('buyer', 'buyer_all') order by idx limit 1))`);
  step(`users (${plan.length}) + roles + scopes`, quiet);

  // ================================================================ INDENTS
  await c.query(`create temp table i_doc as
    select g.n, pg_temp.u7(g.at, g.n, 101) id, g.at, nd.id node, nd.k node_k, nd.indenter creator, nd.approver,
      case when x < 0.03 then 'draft' when x < 0.05 then 'rejected' when x < 0.06 then 'on_hold'
           when x < 0.09 or (cfg.t_end - g.at < interval '10 days' and x < 0.55) then 'waiting_verify' else 'approved' end st,
      g.at + make_interval(hours => 1 + (pg_temp.r(g.n, 103) * 47)::int) decide_at,
      5 + g.n % 11 nlines, (select id from dep where k = 1 + g.n % (select count(*) from dep)) dept,
      case when pg_temp.r(g.n, 104) < 0.15 then 'Urgent' else 'Normal' end priority
    from (select n, cfg.t0 + ((n - 1 + pg_temp.r(n, 100)) / $1::float8) * (cfg.t_end - cfg.t0 - interval '2 hours') as at, pg_temp.r(n, 102) x
          from generate_series(1, $1::int) n cross join cfg) g
    cross join cfg join nd on nd.k = 1 + floor(pg_temp.r(g.n, 105) * ${ND})::int`, [cfg.indents]);
  // decided after t_end → still waiting
  await c.query(`update i_doc set st = 'waiting_verify' from cfg where st in ('approved', 'rejected', 'on_hold') and decide_at > cfg.t_end`);
  await c.query(`create temp table i_line as
    select pg_temp.u7(d.at, d.n * 100 + ln, 111) id, d.id document_id, d.n, ln line_no, d.n * 100 + ln gk, d.at, d.st, d.node, d.creator, d.approver, d.decide_at,
      it.id item_id, it.uom, it.rate, 10 * (1 + floor(pg_temp.r(d.n * 100 + ln, 112) * 50))::int qty,
      (d.at::date + 15 + floor(pg_temp.r(d.n * 100 + ln, 113) * 30)::int) required_date
    from i_doc d cross join lateral generate_series(1, d.nlines) ln
    join itm it on it.k = 1 + floor(${NI_ITEMS} * power(pg_temp.r(d.n * 100 + ln, 114), 2))::int`);
  await c.query(`create index on i_line (id)`);
  step(`indents planned (${(await one('select count(*)::int n from i_doc')).n} docs / ${(await one('select count(*)::int n from i_line')).n} lines)`, quiet);

  // ================================================================ PURCHASE ORDERS (from approved indent lines)
  await c.query(`create temp table p_cand as
    select l.*, nd.k node_k, row_number() over (partition by l.node order by l.decide_at, l.id) rn
    from i_line l join nd on nd.id = l.node cross join cfg
    where l.st = 'approved' and l.decide_at < cfg.t_end - interval '5 days' and pg_temp.r(l.gk, 120) < 0.85`);
  await c.query(`alter table p_cand add column grp int`);
  await c.query(`update p_cand set grp = case when ${cfg.big150} and node_k = 1 and rn <= 150 then 0
    when ${cfg.big150} and node_k = 1 then ((rn - 151) / 10)::int + 1 else ((rn - 1) / 10)::int end`);
  await c.query(`create temp table p_doc as
    select row_number() over (order by at, node, grp)::int n, * from (
      select node, grp, least(max(decide_at) + make_interval(hours => 1 + (pg_temp.r(hashtext(node::text || grp)::bigint, 121) * 71)::int), (select t_end - interval '1 hour' from cfg)) as at,
        count(*) nlines from p_cand group by node, grp) x`);
  await c.query(`alter table p_doc add column id uuid, add column st text, add column decide_at timestamptz, add column vendor uuid, add column creator uuid,
    add column approver uuid, add column expected date`);
  await c.query(`update p_doc p set id = pg_temp.u7(p.at, p.n, 131), vendor = (select id from ven where k = 1 + floor(pg_temp.r(p.n, 132) * ${NV})::int),
    creator = nd.buyer, approver = nd.approver, expected = p.at::date + 14 + (p.n % 10),
    decide_at = p.at + make_interval(hours => 2 + (pg_temp.r(p.n, 133) * 46)::int),
    st = case when pg_temp.r(p.n, 134) < 0.02 then 'draft' when pg_temp.r(p.n, 134) < 0.03 then 'rejected' when pg_temp.r(p.n, 134) < 0.04 then 'on_hold'
      when pg_temp.r(p.n, 134) < 0.07 or (cfg.t_end - p.at < interval '4 days' and pg_temp.r(p.n, 134) < 0.5) then 'waiting_approve' else 'approved' end
    from nd, cfg where nd.id = p.node`);
  await c.query(`update p_doc set st = 'waiting_approve' from cfg where st in ('approved', 'rejected', 'on_hold') and decide_at > cfg.t_end`);
  await c.query(`create unique index on p_doc (node, grp)`);
  await c.query(`create temp table p_line as
    select pg_temp.u7(p.at, c.gk, 141) id, p.id document_id, p.n pn, row_number() over (partition by p.id order by c.rn)::int line_no, c.gk, c.id indent_line, c.document_id indent_doc,
      c.item_id, c.uom, c.qty, c.rate, c.qty * c.rate amount, p.at, p.st, p.node, p.creator, p.approver, p.decide_at, p.expected, c.required_date,
      it.tax_code, it.tax_pct
    from p_cand c join p_doc p on p.node = c.node and p.grp = c.grp join itm it on it.id = c.item_id`);
  await c.query(`create index on p_line (document_id)`);
  await c.query(`create index on p_line (id)`);
  step(`POs planned (${(await one('select count(*)::int n from p_doc')).n} docs / ${(await one('select count(*)::int n from p_line')).n} lines)`, quiet);

  // ================================================================ GRNs (against approved POs)
  await c.query(`create temp table g_doc as
    with m as (
      select p.*, pg_temp.r(p.n, 150) x, p.decide_at + make_interval(days => 2 + (pg_temp.r(p.n, 151) * 13)::int, hours => (pg_temp.r(p.n, 152) * 8)::int) g1
      from p_doc p cross join cfg where p.st = 'approved' and p.decide_at < cfg.t_end - interval '3 days'
    ), m2 as (
      select m.*, m.g1 + make_interval(days => 3 + (pg_temp.r(m.n, 153) * 7)::int) g2,
        case when m.x < 0.10 then 'none' when m.x < 0.25 then 'partial' when m.x < 0.40 then 'split' else 'full' end mode
      from m cross join cfg where m.g1 < cfg.t_end - interval '2 hours'
    )
    select m2.id po, m2.n pn, 1 seq, m2.g1 as at, case when m2.mode = 'split' and m2.g2 >= cfg.t_end - interval '2 hours' then 'partial60' else m2.mode end mode, m2.node, m2.vendor
    from m2 cross join cfg where m2.mode <> 'none'
    union all
    select m2.id, m2.n, 2, m2.g2, 'rest', m2.node, m2.vendor from m2 cross join cfg where m2.mode = 'split' and m2.g2 < cfg.t_end - interval '2 hours'`);
  await c.query(`alter table g_doc add column n int, add column id uuid, add column st text, add column gate_at timestamptz, add column accept_at timestamptz,
    add column creator uuid, add column approver uuid`);
  await c.query(`update g_doc g set n = x.n from (select po, seq, row_number() over (order by at, po, seq)::int n from g_doc) x where x.po = g.po and x.seq = g.seq`);
  await c.query(`update g_doc g set id = pg_temp.u7(g.at, g.n, 161), creator = nd.keeper, approver = nd.approver,
    gate_at = g.at + make_interval(mins => 20 + (pg_temp.r(g.n, 162) * 100)::int),
    accept_at = g.at + make_interval(hours => 2 + (pg_temp.r(g.n, 163) * 22)::int),
    st = case when cfg.t_end - g.at < interval '3 days' and pg_temp.r(g.n, 164) < 0.5 then 'waiting_gate'
              when cfg.t_end - g.at < interval '6 days' and pg_temp.r(g.n, 164) < 0.7 then 'waiting_store' else 'approved' end
    from nd, cfg where nd.id = g.node`);
  await c.query(`update g_doc set st = 'waiting_gate' from cfg where st <> 'waiting_gate' and gate_at > cfg.t_end`);
  await c.query(`update g_doc set st = 'waiting_store' from cfg where st = 'approved' and accept_at > cfg.t_end`);
  await c.query(`create index on g_doc (po)`);
  await c.query(`create temp table g_line as
    select pg_temp.u7(g.at, g.n::bigint * 1000 + pl.line_no, 171) id, g.id document_id, g.n gn, g.seq, pl.line_no, pl.id po_line, pl.document_id po_doc, pl.indent_line, pl.indent_doc,
      pl.item_id, pl.uom, pl.rate, g.at, g.st, g.node, g.creator, g.approver, g.gate_at, g.accept_at,
      case g.mode when 'full' then pl.qty when 'partial' then round(pl.qty * 0.5) when 'split' then round(pl.qty * 0.6) when 'partial60' then round(pl.qty * 0.6)
        else pl.qty - round(pl.qty * 0.6) end qty
    from g_doc g join p_line pl on pl.document_id = g.po`);
  await c.query(`create index on g_line (id)`);
  step(`GRNs planned (${(await one('select count(*)::int n from g_doc')).n} docs / ${(await one('select count(*)::int n from g_line')).n} lines)`, quiet);

  // ================================================================ STORE ISSUES (direct; each line backed by one accepted GRN line)
  await c.query(`create temp table s_cand as
    select gl.*, row_number() over (partition by gl.node order by gl.accept_at, gl.id) rn
    from g_line gl cross join cfg where gl.st = 'approved' and gl.accept_at < cfg.t_end - interval '1 day' and pg_temp.r(gl.gn::bigint * 1000 + gl.line_no, 180) < ${cfg.issueShare}`);
  await c.query(`create temp table s_doc as
    select row_number() over (order by at, node, grp)::int n, * from (
      select node, ((rn - 1) / 10)::int grp, least(max(accept_at) + make_interval(days => 1 + (pg_temp.r(hashtext(node::text || ((rn - 1) / 10)::int)::bigint, 181) * 19)::int),
        (select t_end - interval '1 hour' from cfg)) as at
      from s_cand group by node, ((rn - 1) / 10)::int) x`);
  await c.query(`alter table s_doc add column id uuid, add column st text, add column decide_at timestamptz, add column creator uuid, add column approver uuid, add column dept uuid`);
  await c.query(`update s_doc s set id = pg_temp.u7(s.at, s.n, 191), creator = nd.keeper, approver = nd.approver,
    dept = (select id from dep where k = 1 + s.n % (select count(*) from dep)),
    decide_at = s.at + make_interval(hours => 1 + (pg_temp.r(s.n, 192) * 7)::int),
    st = case when pg_temp.r(s.n, 193) < 0.03 then 'draft' when pg_temp.r(s.n, 193) < 0.06 or (cfg.t_end - s.at < interval '2 days' and pg_temp.r(s.n, 193) < 0.5) then 'waiting_approve' else 'approved' end
    from nd, cfg where nd.id = s.node`);
  await c.query(`update s_doc set st = 'waiting_approve' from cfg where st = 'approved' and decide_at > cfg.t_end`);
  await c.query(`create unique index on s_doc (node, grp)`);
  await c.query(`create temp table s_line as
    select pg_temp.u7(s.at, s.n::bigint * 100 + row_number() over (partition by s.id order by c.rn), 201) id, s.id document_id, s.n sn,
      row_number() over (partition by s.id order by c.rn)::int line_no, c.item_id, c.uom, c.rate, greatest(1, floor(c.qty * 0.5)) qty,
      s.at, s.st, s.node, s.creator, s.approver, s.decide_at, c.id grn_line
    from s_cand c join s_doc s on s.node = c.node and s.grp = ((c.rn - 1) / 10)::int`);
  step(`issues planned (${(await one('select count(*)::int n from s_doc')).n} docs / ${(await one('select count(*)::int n from s_line')).n} lines)`, quiet);

  // ================================================================ derived PO receipt status
  await c.query(`alter table p_line add column rec numeric default 0, add column line_st text`);
  await c.query(`update p_line pl set rec = x.rec from (select po_line, sum(qty) rec from g_line group by po_line) x where x.po_line = pl.id`);
  await c.query(`update p_line set line_st = case when st <> 'approved' then st when rec >= qty then 'received' when rec > 0 then 'partially_received' else 'approved' end`);
  await c.query(`alter table p_doc add column final_st text`);
  await c.query(`update p_doc p set final_st = case when p.st <> 'approved' then p.st when x.all_rec then 'received' when x.any_rec then 'partially_received' else 'approved' end
    from (select document_id, bool_and(rec >= qty) all_rec, bool_or(rec > 0) any_rec from p_line group by document_id) x where x.document_id = p.id`);

  // ================================================================ write documents + lines (time order)
  await c.query(`create temp table docs_all as
    select d.id, 'indent' t, d.at, d.st, d.node, null::uuid party, d.creator, 0::numeric total, null::date required_by, d.n seqn,
      jsonb_build_object('purpose', 'Requirement for ' || (array['line maintenance', 'shutdown spares', 'consumables', 'project work', 'breakdown repair', 'safety stock'])[1 + d.n % 6]
        || ' #' || d.n, 'priority', d.priority, 'department', d.dept) custom, null::text cur
    from i_doc d
    union all
    select p.id, 'po', p.at, p.final_st, p.node, p.vendor, p.creator, x.total, null, p.n,
      jsonb_build_object('terms', '[]'::jsonb, 'freight', '0.00', 'currency', 'INR', 'taxable_amount', to_char(x.total, 'FM9999999990.00'),
        'tax_amount', to_char(x.tax, 'FM9999999990.00'), 'cgst_amount', to_char(x.tax / 2, 'FM9999999990.00'), 'sgst_amount', to_char(x.tax / 2, 'FM9999999990.00'),
        'igst_amount', '0.00', 'cess_amount', '0.00', 'grand_total', to_char(x.total + x.tax, 'FM9999999990.00'), 'expected_date', p.expected::text), 'INR'
    from p_doc p join (select document_id, sum(amount) total, sum(round(amount * tax_pct / 100, 2)) tax from p_line group by document_id) x on x.document_id = p.id
    union all
    select g.id, 'grn', g.at, g.st, g.node, g.vendor, g.creator, x.total, null, g.n,
      jsonb_build_object('po', g.po, 'challan_no', 'CH-' || (10000 + g.n), 'invoice_no', 'INV/' || (20000 + g.n), 'invoice_date', g.at::date::text, 'gate_entry_no', 'GE-' || lpad(g.n::text, 6, '0')), null
    from g_doc g join (select document_id, sum(qty * rate) total from g_line group by document_id) x on x.document_id = g.id
    union all
    select s.id, 'store_issue', s.at, s.st, s.node, null, s.creator, 0, null, s.n,
      jsonb_build_object('department', s.dept, 'issued_to', 'Shop floor ' || (1 + s.n % 9)), null
    from s_doc s`);
  // numbers: per type and FY of the submit date, in submit order (drafts have none)
  await c.query(`alter table docs_all add column number text`);
  await c.query(`update docs_all d set number = replace(replace(replace(t.pattern, '{FYS}', pg_temp.fys(d.at::date)), '{FY}', pg_temp.fy(d.at::date)), '{SEQ:5}', lpad(x.seq::text, 5, '0'))
    from typ t, (select id, row_number() over (partition by t, pg_temp.fy(at::date) order by at, id) seq from docs_all where st <> 'draft') x
    where x.id = d.id and t.key = d.t`);
  await c.query(`
    insert into app.document (id, tenant_id, doc_type_id, number, number_series_id, status_key, location_node_id, doc_date, required_by, party_id, currency, total_amount,
      custom, form_version_id, line_form_version_id, is_locked, submitted_at, submitted_by, created_at, created_by, updated_at, updated_by)
    select d.id, cfg.tid, t.id, d.number, case when d.number is not null then t.series end, d.st, d.node, d.at::date, d.required_by, d.party, d.cur, d.total,
      d.custom, t.hv, t.lv, d.st <> 'draft', case when d.st <> 'draft' then d.at end, case when d.st <> 'draft' then d.creator end, d.at, d.creator, d.at, d.creator
    from docs_all d join typ t on t.key = d.t cross join cfg order by d.at, d.id`);
  step(`documents written (${(await one('select count(*)::int n from docs_all')).n})`, quiet);
  await c.query(`create temp table lines_all as
    select l.id, l.document_id, 'indent' t, l.line_no, l.item_id, l.uom, l.qty, null::numeric rate, 0::numeric amount, l.required_date, l.node, l.st, l.at, l.creator,
      case when l.gk % 4 = 0 then jsonb_build_object('remarks', (array['As per drawing', 'Urgent for shutdown', 'Same make as existing', 'IS grade', 'Spare for line ' || (l.gk % 7)])[1 + (l.gk / 4) % 5]) else '{}'::jsonb end custom
    from i_line l
    union all
    select l.id, l.document_id, 'po', l.line_no, l.item_id, l.uom, l.qty, l.rate, l.amount, l.required_date, l.node, l.line_st, l.at, l.creator,
      jsonb_build_object('schedule', jsonb_build_array(jsonb_build_object('qty', l.qty::text, 'date', l.expected::text)), 'tax_code', l.tax_code, 'source_line', l.indent_line, 'expected_date', l.expected::text)
    from p_line l
    union all
    select l.id, l.document_id, 'grn', l.line_no, l.item_id, l.uom, l.qty, l.rate, l.qty * l.rate, null, l.node, l.st, l.at, l.creator,
      jsonb_build_object('po_line', l.po_line, 'requires_qc', false, 'accepted_qty', l.qty::text, 'rejected_qty', '0')
    from g_line l
    union all
    select l.id, l.document_id, 'store_issue', l.line_no, l.item_id, l.uom, l.qty, null, 0, null, l.node, l.st, l.at, l.creator,
      jsonb_build_object('purpose', 'Job ' || (1000 + l.sn % 500)) from s_line l`);
  await c.query(`
    insert into app.document_line (id, tenant_id, document_id, doc_type_id, line_no, item_id, uom_id, qty, rate, amount, required_date, location_node_id, status_key, custom,
      created_at, created_by, updated_at, updated_by)
    select l.id, cfg.tid, l.document_id, t.id, l.line_no, l.item_id, l.uom, l.qty, l.rate, l.amount, l.required_date, l.node, l.st, l.custom, l.at, l.creator, l.at, l.creator
    from lines_all l join typ t on t.key = l.t cross join cfg order by l.at, l.document_id, l.line_no`);
  step(`lines written (${(await one('select count(*)::int n from lines_all')).n})`, quiet);
  // PO taxes (intra-state CGST + SGST at the item's GST rate)
  await c.query(`insert into app.line_tax (tenant_id, line_id, document_id, component, rate_pct, taxable_amount, tax_amount)
    select cfg.tid, l.id, l.document_id, comp, l.tax_pct / 2, l.amount, round(l.amount * l.tax_pct / 200, 2)
    from p_line l cross join (values ('cgst'), ('sgst')) v(comp) cross join cfg`);
  // line links indent → PO (cancelled for rejected POs)
  await c.query(`insert into app.line_link (tenant_id, from_line_id, to_line_id, link_type, qty, created_at, created_by, is_cancelled)
    select cfg.tid, l.indent_line, l.id, 'ordered', l.qty, l.at, l.creator, l.st = 'rejected' from p_line l cross join cfg where l.st <> 'draft' order by l.at`);
  step('line_tax + line_link', quiet);

  // ================================================================ workflow runtime + action ids
  // one instance per submitted document; stage list per type; action ids are uuid v7 of their own time
  await c.query(`create temp table wf as
    select d.id doc, d.t, d.st, d.at, d.creator, x.approver, x.decide_at, x.gate_at, pg_temp.u7(d.at, d.seqn, 301 + length(d.t)) inst,
      pg_temp.u7(d.at, d.seqn, 311 + length(d.t)) a_submit, pg_temp.u7(coalesce(x.gate_at, x.decide_at), d.seqn, 321 + length(d.t)) a_gate,
      pg_temp.u7(x.decide_at, d.seqn, 331 + length(d.t)) a_dec, pg_temp.u7(x.decide_at, d.seqn, 341 + length(d.t)) a_end
    from docs_all d join (
      select id, approver, decide_at, null::timestamptz gate_at from i_doc union all select id, approver, decide_at, null from p_doc
      union all select id, approver, accept_at, gate_at from g_doc union all select id, approver, decide_at, null from s_doc) x on x.id = d.id
    where d.st <> 'draft'`);
  await c.query(`alter table wf add column running boolean`);
  await c.query(`update wf set running = st like 'waiting_%' or st = 'on_hold'`);
  await c.query(`create index on wf (doc)`);
  await c.query(`insert into app.wf_instance (id, tenant_id, document_id, workflow_version_id, status, started_at, started_by, completed_at)
    select w.inst, cfg.tid, w.doc, t.wv, case when w.running then 'running' else 'completed' end, w.at, w.creator, case when not w.running then w.decide_at end
    from wf w join typ t on t.key = w.t cross join cfg order by w.at`);
  await c.query(`
    insert into app.wf_stage_state (tenant_id, instance_id, stage_key, status, skip_reason, entered_at, due_at, next_reminder_at, reminders_sent, escalated_at, completed_at)
    select cfg.tid, w.inst, s.key, s.status, s.skip, s.entered, s.due, null, case when s.status = 'active' and s.due < cfg.t_end then 2 else 0 end,
      case when s.status = 'active' and s.due < cfg.t_end then s.due end, s.done
    from wf w cross join cfg cross join lateral (
      select * from (values
        -- single-stage types
        (case w.t when 'indent' then 'verify' else 'approve' end, case when w.running then 'active' else 'done' end, null::text, w.at,
          case when w.running then w.at + interval '48 hours' end, case when not w.running then w.decide_at end)
      ) v(key, status, skip, entered, due, done) where w.t <> 'grn'
      union all
      select * from (values
        ('gate', case when w.st = 'waiting_gate' then 'active' else 'done' end, null::text, w.at,
          case when w.st = 'waiting_gate' then w.at + interval '48 hours' end, case when w.st <> 'waiting_gate' then w.gate_at end),
        ('store', case when w.st = 'waiting_gate' then 'pending' when w.st = 'waiting_store' then 'active' else 'done' end, null,
          case when w.st <> 'waiting_gate' then w.gate_at end, case when w.st = 'waiting_store' then w.gate_at + interval '48 hours' end,
          case when w.st = 'approved' then w.decide_at end),
        ('quality', 'skipped', 'condition_false', null::timestamptz, null::timestamptz, null::timestamptz),
        ('disposition', 'skipped', 'condition_false', null, null, null)
      ) v(key, status, skip, entered, due, done) where w.t = 'grn'
    ) s`);
  await c.query(`
    insert into app.wf_action (id, tenant_id, instance_id, document_id, stage_key, action, actor_id, decisions, at)
    select id, cfg.tid, inst, doc, stage, action, actor, '[]'::jsonb, at from (
      select w.a_submit id, w.inst, w.doc, '_start' stage, 'submit' action, w.creator actor, w.at as at from wf w
      union all select w.a_gate, w.inst, w.doc, 'gate', 'decide', w.approver, w.gate_at from wf w where w.t = 'grn' and w.st <> 'waiting_gate'
      union all select w.a_dec, w.inst, w.doc, case w.t when 'indent' then 'verify' when 'grn' then 'store' else 'approve' end, 'decide', w.approver, w.decide_at
        from wf w where w.st in ('approved', 'rejected', 'on_hold', 'received', 'partially_received')
      union all select w.a_end, w.inst, w.doc, '_end', 'complete', null, w.decide_at from wf w where not w.running
    ) a cross join cfg order by a.at`);
  await c.query(`
    insert into app.wf_line_state (tenant_id, instance_id, line_id, stage_key, pending_qty, held_qty, entered_at, updated_at)
    select cfg.tid, w.inst, l.id, case w.t when 'indent' then 'verify' when 'grn' then (case when w.st = 'waiting_gate' then 'gate' else 'store' end) else 'approve' end,
      case when w.st = 'on_hold' then 0 else l.qty end, case when w.st = 'on_hold' then l.qty else 0 end,
      coalesce(case when w.st = 'waiting_store' then w.gate_at end, w.at), coalesce(case when w.st = 'on_hold' then w.decide_at end, w.at)
    from wf w join lines_all l on l.document_id = w.doc cross join cfg where w.running`);
  step(`workflow runtime (${(await one('select count(*)::int n from wf')).n} instances)`, quiet);

  // ================================================================ quantity ledger
  await c.query(`create temp table ev (line_id uuid, document_id uuid, event_type text, qty numeric, ref_line_id uuid, stage_key text, wf_action_id uuid, actor_id uuid, reason text, at timestamptz)`);
  // indents: requested at submit; outcome at verify
  await c.query(`insert into ev select l.id, l.document_id, 'requested', l.qty, null, null, null, l.creator, null, l.at from i_line l where l.st <> 'draft'`);
  await c.query(`insert into ev select l.id, l.document_id, case l.st when 'approved' then 'approved' when 'rejected' then 'rejected' else 'held' end, l.qty, null, 'verify', w.a_dec, l.approver,
      case when l.st = 'rejected' then 'Not required' when l.st = 'on_hold' then 'Check stock first' end, l.decide_at
    from i_line l join wf w on w.doc = l.document_id where l.st in ('approved', 'rejected', 'on_hold')`);
  // POs: PO requested + indent ordered at submit; approval → PO approved + ordered; rejection → PO rejected + indent order_cancelled
  await c.query(`insert into ev select l.id, l.document_id, 'requested', l.qty, null, null, null, l.creator, null, l.at from p_line l where l.st <> 'draft'`);
  await c.query(`insert into ev select l.indent_line, l.indent_doc, 'ordered', l.qty, l.id, null, null, l.creator, null, l.at from p_line l where l.st <> 'draft'`);
  await c.query(`insert into ev select l.id, l.document_id, x.e, l.qty, null, case when x.e = 'ordered' then null else 'approve' end, case when x.e = 'ordered' then null else w.a_dec end,
      l.approver, case when x.e = 'rejected' then 'Rate too high' when x.e = 'held' then 'Awaiting budget' end, l.decide_at
    from p_line l join wf w on w.doc = l.document_id
    cross join lateral (select unnest(case l.st when 'approved' then array['approved', 'ordered'] when 'rejected' then array['rejected'] when 'on_hold' then array['held'] else array[]::text[] end) e) x`);
  await c.query(`insert into ev select l.indent_line, l.indent_doc, 'order_cancelled', l.qty, l.id, null, null, l.approver, 'PO rejected', l.decide_at from p_line l where l.st = 'rejected'`);
  // GRNs: GRN requested + PO/indent received at submit; store approval → GRN accepted + approved, PO/indent accepted
  await c.query(`insert into ev select l.id, l.document_id, 'requested', l.qty, null, null, null, l.creator, null, l.at from g_line l`);
  await c.query(`insert into ev select l.po_line, l.po_doc, 'received', l.qty, l.id, null, null, l.creator, null, l.at from g_line l`);
  await c.query(`insert into ev select l.indent_line, l.indent_doc, 'received', l.qty, l.id, null, null, l.creator, null, l.at from g_line l`);
  await c.query(`insert into ev select l.id, l.document_id, x.e, l.qty, null, 'store', w.a_dec, l.approver, null, l.accept_at
    from g_line l join wf w on w.doc = l.document_id cross join (values ('accepted'), ('approved')) x(e) where l.st = 'approved'`);
  await c.query(`insert into ev select l.po_line, l.po_doc, 'accepted', l.qty, l.id, null, null, l.approver, null, l.accept_at from g_line l where l.st = 'approved'`);
  await c.query(`insert into ev select l.indent_line, l.indent_doc, 'accepted', l.qty, l.id, null, null, l.approver, null, l.accept_at from g_line l where l.st = 'approved'`);
  // issues: requested; approve → approved + issued
  await c.query(`insert into ev select l.id, l.document_id, 'requested', l.qty, null, null, null, l.creator, null, l.at from s_line l where l.st <> 'draft'`);
  await c.query(`insert into ev select l.id, l.document_id, x.e, l.qty, null, 'approve', w.a_dec, l.approver, null, l.decide_at
    from s_line l join wf w on w.doc = l.document_id cross join (values ('approved'), ('issued')) x(e) where l.st = 'approved'`);
  await c.query(`insert into app.line_event (tenant_id, line_id, document_id, event_type, qty, ref_line_id, wf_action_id, stage_key, reason, actor_id, at)
    select cfg.tid, line_id, document_id, event_type, qty, ref_line_id, wf_action_id, stage_key, reason, actor_id, at from ev cross join cfg order by at, line_id, event_type`);
  // summaries DERIVED from the events (QuantityLedger effect table, incl. the negative effects)
  await c.query(`
    insert into app.line_qty_summary (line_id, tenant_id, document_id, requested, approved, held, rejected, cancelled, short_closed, over_approved, selected, ordered,
      received, accepted, rejected_at_receipt, issued, returned, last_event_id, updated_at)
    select e.line_id, e.tenant_id, min(e.document_id::text)::uuid,
      coalesce(sum(qty) filter (where event_type = 'requested'), 0), coalesce(sum(qty) filter (where event_type = 'approved'), 0),
      coalesce(sum(qty) filter (where event_type = 'held'), 0) - coalesce(sum(qty) filter (where event_type = 'unheld'), 0),
      coalesce(sum(qty) filter (where event_type = 'rejected'), 0), coalesce(sum(qty) filter (where event_type = 'cancelled'), 0),
      coalesce(sum(qty) filter (where event_type = 'short_closed'), 0),
      coalesce(sum(qty) filter (where event_type = 'over_approved'), 0) - coalesce(sum(qty) filter (where event_type = 'over_approval_cancelled'), 0),
      coalesce(sum(qty) filter (where event_type = 'selected'), 0) - coalesce(sum(qty) filter (where event_type = 'selection_cancelled'), 0),
      coalesce(sum(qty) filter (where event_type = 'ordered'), 0) - coalesce(sum(qty) filter (where event_type = 'order_cancelled'), 0),
      coalesce(sum(qty) filter (where event_type = 'received'), 0), coalesce(sum(qty) filter (where event_type = 'accepted'), 0),
      coalesce(sum(qty) filter (where event_type = 'rejected_at_receipt'), 0), coalesce(sum(qty) filter (where event_type = 'issued'), 0),
      coalesce(sum(qty) filter (where event_type = 'returned'), 0), max(e.id), max(e.at)
    from app.line_event e where e.tenant_id = $1 group by e.line_id, e.tenant_id`, [tid]);
  step(`ledger (${(await one('select count(*)::int n from ev')).n} events) + summaries`, quiet);

  // ================================================================ stock
  await c.query(`create temp table mv as
    select l.item_id, l.node, 'receipt' typ, l.qty qin, 0::numeric qout, l.rate, l.qty * l.rate val, l.document_id, l.id line_id, l.approver actor, l.accept_at as at
    from g_line l where l.st = 'approved'
    union all
    select l.item_id, l.node, 'issue', 0, l.qty, l.rate, -(l.qty * l.rate), l.document_id, l.id, l.approver, l.decide_at from s_line l where l.st = 'approved'`);
  await c.query(`insert into app.stock_movement (tenant_id, item_id, node_id, batch_id, stock_status, movement_type, qty_in, qty_out, unit_cost, value, document_id, line_id, actor_id, at)
    select cfg.tid, item_id, node, null, 'available', typ, qin, qout, rate, val, document_id, line_id, actor, at from mv cross join cfg order by at, line_id`);
  await c.query(`insert into app.stock_balance (tenant_id, item_id, node_id, batch_key, stock_status, qty, value, last_movement_id, updated_at)
    select tenant_id, item_id, node_id, '00000000-0000-0000-0000-000000000000', stock_status, sum(qty_in - qty_out), sum(value), max(id), max(at)
    from app.stock_movement where tenant_id = $1 group by tenant_id, item_id, node_id, stock_status`, [tid]);
  await c.query(`insert into app.item_avg_cost (tenant_id, item_id, node_id, qty, value, avg_cost, updated_at)
    select b.tenant_id, b.item_id, b.node_id, sum(b.qty), sum(b.value), max(it.rate), max(b.updated_at)
    from app.stock_balance b join itm it on it.id = b.item_id where b.tenant_id = $1 group by b.tenant_id, b.item_id, b.node_id`, [tid]);
  // re-order rules on the busiest pairs; min = 120 % of a fifth of the pairs' qty → about a fifth below min
  await c.query(`insert into app.reorder_rule (tenant_id, item_id, node_id, min_qty, reorder_qty, max_qty, created_by)
    select b.tenant_id, b.item_id, b.node_id, case when pg_temp.r(abs(hashtext(b.item_id::text || b.node_id))::bigint, 400) < 0.2 then ceil(b.qty * 1.2) + 10 else greatest(1, floor(b.qty * 0.3)) end,
      100, null, cfg.admin_id
    from (select * from app.stock_balance where tenant_id = $1 order by qty desc limit ${cfg.reorderRules}) b cross join cfg`, [tid]);
  step(`stock (${(await one('select count(*)::int n from mv')).n} movements)`, quiet);

  // ================================================================ numbering counters past the seeded numbers
  await c.query(`insert into app.numbering_counter (tenant_id, series_id, period, value)
    select cfg.tid, t.series, pg_temp.fy(d.at::date), count(*) from docs_all d join typ t on t.key = d.t cross join cfg where d.st <> 'draft'
    group by cfg.tid, t.series, pg_temp.fy(d.at::date)
    on conflict (tenant_id, series_id, period) do update set value = greatest(app.numbering_counter.value, excluded.value)`);
  await c.query('commit');
  await c.query(`drop table if exists cfg, typ, nd, itm, ven, dep, taxes, uoms, usr, i_doc, i_line, p_cand, p_doc, p_line, g_doc, g_line, s_cand, s_doc, s_line, ev, mv, docs_all, lines_all, wf`);
  step('counters + commit', quiet);
}

const grants = await roleGrants();
const t0 = Date.now();
if (mode === 'big') {
  await seedTenant('big', BIG, grants);
} else {
  const from = Number(process.argv[3] ?? 1), to = Number(process.argv[4] ?? 200);
  for (let i = from; i <= to; i++) {
    await seedTenant(`s${String(i).padStart(3, '0')}`, SMALL, grants);
    if (i % 20 === 0) console.log(`  … ${i} small tenants (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
}
console.log(`seed ${mode} done in ${Math.round((Date.now() - t0) / 1000)} s`);
await c.end();
