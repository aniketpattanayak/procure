#!/usr/bin/env node
/**
 * Phase 3 performance seed: N documents (default 20,000) × L lines (default 10) of the Capex type for tenant `acme`
 * (≈ 200,000 document lines), plus one 100-line document, inserted with SQL as the DB owner — shaped like API-written
 * rows: header/line custom JSON, form versions, numbers, locations across the Pune/Chennai trees, workflow instances
 * with stage + line state for documents in approval, and a CONSISTENT ledger: `line_event` rows (requested / approved /
 * held / rejected) whose sums equal `line_qty_summary` for every line, and wf_line_state pending + held = the line's
 * pending approval.
 *
 *   DATABASE_MIGRATOR_URL=postgres://postgres@localhost:5432/procure_qa_load node load/phase-3/seed-documents.mjs [docs] [lines]
 *
 * Status mix: draft 5 %, waiting_hod 30 %, waiting_finance 10 %, on_hold 5 %, approved 35 %, partially_approved 10 %,
 * rejected 5 %. Idempotent: removes earlier perf rows (number LIKE 'PERF/%' or custom.purpose = 'PERF') first.
 * Ends with ANALYZE and a ledger consistency check (fails loudly on drift).
 */
import pg from 'pg';

const DOCS = Number(process.argv[2] ?? 20_000);
const LINES = Number(process.argv[3] ?? 10);
const url = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_qa_load';
const c = new pg.Client({ connectionString: url });
await c.connect();
const one = async (q, p = []) => (await c.query(q, p)).rows[0];
const t0 = Date.now();

const t = await one(`select id from platform.tenant where code = 'acme'`);
if (!t) throw new Error('tenant acme not found — migrate + seed this database first');
const dt = await one(`select d.id, hf.current_version_id as hv, lf.current_version_id as lv from app.doc_type d
  join app.form_def hf on hf.id = d.header_form_id join app.form_def lf on lf.id = d.line_form_id where d.tenant_id = $1 and d.key = 'capex'`, [t.id]);
const wf = await one(`select current_version_id as v from app.workflow_def where tenant_id = $1 and doc_type_id = $2`, [t.id, dt.id]);
const users = await one(`select (select id from app.tenant_user where tenant_id = $1 and email = 'indenter@acme.test') as indenter,
  (select id from app.tenant_user where tenant_id = $1 and email = 'approver@acme.test') as approver`, [t.id]);

console.log('cleaning earlier perf rows …');
await c.query('begin');
await c.query(`create temp table perf_docs on commit drop as select id from app.document where tenant_id = $1 and doc_type_id = $2 and custom->>'purpose' = 'PERF'`, [t.id, dt.id]);
for (const tbl of ['wf_line_state', 'wf_stage_state', 'wf_assignment']) {
  await c.query(`delete from app.${tbl} where instance_id in (select i.id from app.wf_instance i join perf_docs p on p.id = i.document_id)`);
}
await c.query(`delete from app.wf_action where document_id in (select id from perf_docs)`);
await c.query(`delete from app.wf_instance where document_id in (select id from perf_docs)`);
await c.query(`delete from app.line_qty_summary where document_id in (select id from perf_docs)`);
await c.query(`delete from app.line_event where document_id in (select id from perf_docs)`);
await c.query(`delete from app.document_line where document_id in (select id from perf_docs)`);
await c.query(`delete from app.document where id in (select id from perf_docs)`);
await c.query('commit');

console.log(`inserting ${DOCS} documents × ${LINES} lines …`);
await c.query('begin');
await c.query(`set local synchronous_commit = off`);
// documents: status by bucket of n
await c.query(`
  create temp table g on commit drop as
  select n,
    case when n % 100 < 5 then 'draft' when n % 100 < 35 then 'waiting_hod' when n % 100 < 45 then 'waiting_finance'
         when n % 100 < 50 then 'on_hold' when n % 100 < 85 then 'approved' when n % 100 < 95 then 'partially_approved' else 'rejected' end as st,
    (array(select id from app.location_node where tenant_id = $1 and code in ('PUNE', 'PUNE-MAIN', 'PUNE-MAIN-A1', 'CHENNAI', 'CHENNAI-RM') order by code))[1 + n % 5] as loc,
    now() - make_interval(mins => ($2::int - n)) as at
  from generate_series(1, $2::int) n`, [t.id, DOCS]);
await c.query(`
  insert into app.document (tenant_id, doc_type_id, number, status_key, location_node_id, doc_date, total_amount, custom, form_version_id, line_form_version_id,
    is_locked, submitted_at, submitted_by, created_at, created_by, updated_at)
  select $1::uuid, $2, case when st = 'draft' then null else 'PERF/' || lpad(n::text, 6, '0') end, st, loc, (at)::date, ${LINES} * 10 * (100 + n % 900),
    jsonb_build_object('purpose', 'PERF', 'priority', case when n % 7 = 0 then 'Urgent' else 'Normal' end, 'justification', case when n % 7 = 0 then 'perf urgent' end),
    $3, $4, st <> 'draft', case when st <> 'draft' then at end, case when st <> 'draft' then $5::uuid end, at, $5, at
  from g`, [t.id, dt.id, dt.hv, dt.lv, users.indenter]);
await c.query(`create temp table d on commit drop as
  select doc.id, g.n, g.st, g.loc, g.at from app.document doc join g on doc.created_at = g.at
  where doc.tenant_id = $1 and doc.doc_type_id = $2 and doc.custom->>'purpose' = 'PERF'`, [t.id, dt.id]);
await c.query(`create index on d (id)`);
const items = (await c.query(`select r.id, (r.data->>'uom')::uuid as uom from app.master_record r join app.master_def m on m.id = r.master_id
  where r.tenant_id = $1 and m.key = 'item' and not r.is_deleted order by r.code limit 5`, [t.id])).rows;
await c.query(`create temp table it as select * from json_to_recordset($1::json) as x(id uuid, uom uuid)`, [JSON.stringify(items)]);
await c.query(`
  insert into app.document_line (tenant_id, document_id, doc_type_id, line_no, item_id, uom_id, qty, amount, location_node_id, status_key, custom, created_at, created_by, updated_at)
  select $1::uuid, d.id, $2, ln, it.id, it.uom, 10, 10 * (100 + d.n % 900),
    d.loc,
    case when d.st = 'partially_approved' then (case when ln % 2 = 0 then 'partially_approved' else 'approved' end) else d.st end,
    jsonb_build_object('est_rate', (100 + d.n % 900)::text, 'remarks', 'perf line ' || ln), d.at, $3, d.at
  from d cross join generate_series(1, ${LINES}) ln
  join lateral (select * from it offset ((d.n + ln) % ${items.length}) limit 1) it on true`, [t.id, dt.id, users.indenter]);
await c.query(`create temp table l on commit drop as select dl.id, dl.document_id, dl.line_no, d.st, d.at from app.document_line dl join d on d.id = dl.document_id`);

// ledger events: requested 10 for submitted; outcomes per status
await c.query(`
  insert into app.line_event (tenant_id, line_id, document_id, event_type, qty, stage_key, actor_id, at)
  select $1::uuid, l.id, l.document_id, 'requested', 10, null, $2::uuid, l.at from l where l.st <> 'draft'
  union all select $1::uuid, l.id, l.document_id, 'held', 10, 'hod', $3::uuid, l.at + interval '1 hour' from l where l.st = 'on_hold'
  union all select $1::uuid, l.id, l.document_id, 'approved', 10, 'hod', $3::uuid, l.at + interval '1 hour' from l where l.st = 'approved'
  union all select $1::uuid, l.id, l.document_id, 'rejected', 10, 'hod', $3::uuid, l.at + interval '1 hour' from l where l.st = 'rejected'
  union all select $1::uuid, l.id, l.document_id, 'approved', case when l.line_no % 2 = 0 then 9 else 10 end, 'hod', $3::uuid, l.at + interval '1 hour' from l where l.st = 'partially_approved'
  union all select $1::uuid, l.id, l.document_id, 'rejected', 1, 'hod', $3::uuid, l.at + interval '1 hour' from l where l.st = 'partially_approved' and l.line_no % 2 = 0`,
[t.id, users.indenter, users.approver]);
await c.query(`
  insert into app.line_qty_summary (line_id, tenant_id, document_id, requested, approved, held, rejected, last_event_id)
  select e.line_id, $1, min(e.document_id::text)::uuid,
    coalesce(sum(qty) filter (where event_type = 'requested'), 0), coalesce(sum(qty) filter (where event_type = 'approved'), 0),
    coalesce(sum(qty) filter (where event_type = 'held'), 0) - coalesce(sum(qty) filter (where event_type = 'unheld'), 0),
    coalesce(sum(qty) filter (where event_type = 'rejected'), 0), max(e.id)
  from app.line_event e join l on l.id = e.line_id group by e.line_id`, [t.id]);
await c.query(`insert into app.line_qty_summary (line_id, tenant_id, document_id) select l.id, $1, l.document_id from l where l.st = 'draft'`, [t.id]);

// workflow instances + stage state + line state
await c.query(`
  insert into app.wf_instance (tenant_id, document_id, workflow_version_id, status, started_at, started_by, completed_at)
  select $1::uuid, d.id, $2, case when d.st in ('waiting_hod', 'waiting_finance', 'on_hold') then 'running' else 'completed' end, d.at, $3,
    case when d.st in ('waiting_hod', 'waiting_finance', 'on_hold') then null else d.at + interval '1 hour' end
  from d where d.st <> 'draft'`, [t.id, wf.v, users.indenter]);
await c.query(`create temp table i on commit drop as select wi.id, wi.document_id, d.st, d.at from app.wf_instance wi join d on d.id = wi.document_id`);
await c.query(`
  insert into app.wf_stage_state (tenant_id, instance_id, stage_key, status, skip_reason, entered_at, due_at, next_reminder_at, completed_at)
  select $1::uuid, i.id, s.k,
    case when s.k = 'hod' then (case when i.st in ('waiting_hod', 'on_hold') then 'active' else 'done' end)
         when s.k = 'finance' then (case when i.st = 'waiting_finance' then 'active' else 'skipped' end)
         else 'skipped' end,
    case when (s.k = 'finance' and i.st <> 'waiting_finance') or s.k = 'director' then 'condition_false' end,
    case when s.k = 'hod' or (s.k = 'finance' and i.st = 'waiting_finance') then i.at end,
    case when s.k = 'hod' and i.st in ('waiting_hod', 'on_hold') then i.at + interval '24 hours' end,
    case when s.k = 'hod' and i.st in ('waiting_hod', 'on_hold') then greatest(i.at + interval '8 hours', now() + interval '30 days') end,
    case when s.k = 'hod' and i.st not in ('waiting_hod', 'on_hold') then i.at + interval '1 hour' end
  from i cross join (values ('hod'), ('finance'), ('director')) s(k)`, [t.id]);
// keep the SLA scan out of the measurement: nothing due in the next 30 days
await c.query(`update app.wf_stage_state set due_at = now() + interval '30 days' where tenant_id = $1 and instance_id in (select id from i) and status = 'active'`, [t.id]);
await c.query(`
  insert into app.wf_line_state (tenant_id, instance_id, line_id, stage_key, pending_qty, held_qty, entered_at, updated_at)
  select $1::uuid, i.id, l.id, case when i.st = 'waiting_finance' then 'finance' else 'hod' end,
    case when i.st = 'on_hold' then 0 else 10 end, case when i.st = 'on_hold' then 10 else 0 end, i.at, i.at
  from i join l on l.document_id = i.document_id where i.st in ('waiting_hod', 'waiting_finance', 'on_hold')`, [t.id]);
await c.query(`
  insert into app.wf_action (tenant_id, instance_id, document_id, stage_key, action, actor_id, decisions, at)
  select $1::uuid, i.id, i.document_id, '_start', 'submit', $2::uuid, '[]'::jsonb, i.at from i
  union all select $1::uuid, i.id, i.document_id, 'hod', 'decide', $3::uuid, '[]'::jsonb, i.at + interval '1 hour' from i where i.st not in ('waiting_hod')`, [t.id, users.indenter, users.approver]);
// waiting_finance lines: approved at hod moved on — ledger has requested only (pending), consistent with pendingApproval = 10
await c.query('commit');

// one 100-line document waiting at HOD (detail benchmark)
await c.query('begin');
const big = await one(`insert into app.document (tenant_id, doc_type_id, number, status_key, location_node_id, total_amount, custom, form_version_id, line_form_version_id,
    is_locked, submitted_at, submitted_by, created_by)
  values ($1, $2, 'PERF/BIG-100', 'waiting_hod', (select id from app.location_node where tenant_id = $1 and code = 'PUNE'), 100 * 10 * 500,
    '{"purpose": "PERF", "priority": "Normal"}', $3, $4, true, now(), $5, $5) returning id`, [t.id, dt.id, dt.hv, dt.lv, users.indenter]);
await c.query(`insert into app.document_line (tenant_id, document_id, doc_type_id, line_no, item_id, uom_id, qty, amount, location_node_id, status_key, custom, created_by)
  select $1::uuid, $2, $3, ln, (select id from it offset (ln % ${items.length}) limit 1), (select uom from it offset (ln % ${items.length}) limit 1), 10, 5000,
    (select id from app.location_node where tenant_id = $1 and code = 'PUNE'), 'waiting_hod', jsonb_build_object('est_rate', '500', 'remarks', 'big ' || ln), $4
  from generate_series(1, 100) ln`, [t.id, big.id, dt.id, users.indenter]);
await c.query(`insert into app.line_event (tenant_id, line_id, document_id, event_type, qty, actor_id) select $1::uuid, id, document_id, 'requested', 10, $3 from app.document_line where document_id = $2`, [t.id, big.id, users.indenter]);
await c.query(`insert into app.line_qty_summary (line_id, tenant_id, document_id, requested, last_event_id)
  select line_id, $1, document_id, qty, id from app.line_event where document_id = $2`, [t.id, big.id]);
const bi = await one(`insert into app.wf_instance (tenant_id, document_id, workflow_version_id, status, started_by) values ($1, $2, $3, 'running', $4) returning id`, [t.id, big.id, wf.v, users.indenter]);
await c.query(`insert into app.wf_stage_state (tenant_id, instance_id, stage_key, status, skip_reason, entered_at, due_at)
  values ($1, $2, 'hod', 'active', null, now(), now() + interval '30 days'), ($1, $2, 'finance', 'skipped', 'condition_false', null, null), ($1, $2, 'director', 'skipped', 'condition_false', null, null)`, [t.id, bi.id]);
await c.query(`insert into app.wf_line_state (tenant_id, instance_id, line_id, stage_key, pending_qty) select $1::uuid, $2, id, 'hod', 10 from app.document_line where document_id = $3`, [t.id, bi.id, big.id]);
await c.query(`insert into app.wf_action (tenant_id, instance_id, document_id, stage_key, action, actor_id) values ($1, $2, $3, '_start', 'submit', $4)`, [t.id, bi.id, big.id, users.indenter]);
await c.query('commit');

console.log('ANALYZE …');
for (const tbl of ['document', 'document_line', 'line_event', 'line_qty_summary', 'wf_instance', 'wf_stage_state', 'wf_line_state', 'wf_action']) await c.query(`analyze app.${tbl}`);

// ledger consistency: summary = Σ events; pendingApproval = Σ wf_line_state (running)
const drift = await one(`
  with ev as (select line_id, sum(qty) filter (where event_type = 'requested') r, coalesce(sum(qty) filter (where event_type = 'approved'), 0) a,
                     coalesce(sum(qty) filter (where event_type = 'rejected'), 0) j,
                     coalesce(sum(qty) filter (where event_type = 'held'), 0) - coalesce(sum(qty) filter (where event_type = 'unheld'), 0) h
              from app.line_event where tenant_id = $1 group by line_id),
       wfq as (select s.line_id, sum(s.pending_qty + s.held_qty) q from app.wf_line_state s join app.wf_instance i on i.id = s.instance_id and i.status = 'running'
              where s.tenant_id = $1 group by s.line_id)
  select count(*) filter (where s.requested <> coalesce(ev.r, 0) or s.approved <> coalesce(ev.a, 0) or s.rejected <> coalesce(ev.j, 0) or s.held <> coalesce(ev.h, 0)) as summary_drift,
         count(*) filter (where s.requested - s.approved - s.rejected - s.cancelled <> coalesce(wfq.q, 0)) as workflow_drift,
         count(*) as lines
  from app.line_qty_summary s left join ev on ev.line_id = s.line_id left join wfq on wfq.line_id = s.line_id where s.tenant_id = $1`, [t.id]);
const counts = await one(`select count(*)::int as docs, (select count(*)::int from app.document_line where tenant_id = $1) as lines from app.document where tenant_id = $1`, [t.id]);
console.log(JSON.stringify({ ...counts, ...drift, bigDocId: big.id, seconds: Math.round((Date.now() - t0) / 1000) }));
await c.end();
if (Number(drift.summary_drift) || Number(drift.workflow_drift)) { console.error('LEDGER DRIFT'); process.exit(1); }
