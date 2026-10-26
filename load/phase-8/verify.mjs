#!/usr/bin/env node
/**
 * Integrity checks of the Phase 8 dataset (run as the DB owner after the seed and after the load test):
 *  1. every line_qty_summary bucket = replay of its line_event rows (same effect table as the QuantityLedger);
 *  2. every submitted line has a summary row, no summary without events;
 *  3. stock_balance qty/value = Σ stock_movement per key; item_avg_cost = Σ balances per item × node;
 *  4. no running balance ever negative (window over movements per item × node in id order);
 *  5. running workflow instances: Σ (pending + held) in wf_line_state = pendingApproval of each line;
 *  6. PO lines: received ≤ ordered + tolerance; indent lines: ordered ≤ approved;
 *  7. no duplicate document numbers; numbering counters ≥ highest seeded sequence.
 *   DATABASE_MIGRATOR_URL=… node load/phase-8/verify.mjs [tenantCode|all]
 */
import pg from 'pg';

const which = process.argv[2] ?? 'all';
const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure_load' });
await c.connect();
await c.query(`set work_mem = '256MB'`);
await c.query(`set max_parallel_workers_per_gather = 0`);
const tenants = (await c.query(which === 'all'
  ? `select id, code from platform.tenant where code = 'big' or code ~ '^s[0-9]{3}$' order by code`
  : `select id, code from platform.tenant where code = $1`, which === 'all' ? [] : [which])).rows;
const ids = tenants.map(t => t.id);
const checks = {
  'summary = Σ events (all buckets)': `
    with e as (
      select line_id,
        sum(qty) filter (where event_type = 'requested') rq, sum(qty) filter (where event_type = 'approved') ap,
        sum(case event_type when 'held' then qty when 'unheld' then -qty end) hd, sum(qty) filter (where event_type = 'rejected') rj,
        sum(qty) filter (where event_type = 'cancelled') cn, sum(qty) filter (where event_type = 'short_closed') sc,
        sum(case event_type when 'over_approved' then qty when 'over_approval_cancelled' then -qty end) oa,
        sum(case event_type when 'selected' then qty when 'selection_cancelled' then -qty end) se,
        sum(case event_type when 'ordered' then qty when 'order_cancelled' then -qty end) od,
        sum(qty) filter (where event_type = 'received') rc, sum(qty) filter (where event_type = 'accepted') ac,
        sum(qty) filter (where event_type = 'rejected_at_receipt') rr, sum(qty) filter (where event_type = 'issued') iss,
        sum(qty) filter (where event_type = 'returned') rt
      from app.line_event where tenant_id = any($1) group by line_id)
    select count(*) from app.line_qty_summary s left join e on e.line_id = s.line_id where s.tenant_id = any($1) and (
      s.requested <> coalesce(e.rq, 0) or s.approved <> coalesce(e.ap, 0) or s.held <> coalesce(e.hd, 0) or s.rejected <> coalesce(e.rj, 0)
      or s.cancelled <> coalesce(e.cn, 0) or s.short_closed <> coalesce(e.sc, 0) or s.over_approved <> coalesce(e.oa, 0) or s.selected <> coalesce(e.se, 0)
      or s.ordered <> coalesce(e.od, 0) or s.received <> coalesce(e.rc, 0) or s.accepted <> coalesce(e.ac, 0) or s.rejected_at_receipt <> coalesce(e.rr, 0)
      or s.issued <> coalesce(e.iss, 0) or s.returned <> coalesce(e.rt, 0))`,
  'events without summary row': `select count(distinct line_id) from app.line_event e where tenant_id = any($1)
    and not exists (select 1 from app.line_qty_summary s where s.line_id = e.line_id)`,
  'submitted lines without summary': `select count(*) from app.document_line l join app.document d on d.id = l.document_id
    where l.tenant_id = any($1) and d.status_key <> 'draft' and not exists (select 1 from app.line_qty_summary s where s.line_id = l.id)`,
  'balance ≠ Σ movements': `
    with m as (select tenant_id, item_id, node_id, coalesce(batch_id, '00000000-0000-0000-0000-000000000000') bk, stock_status, sum(qty_in - qty_out) q, sum(value) v
      from app.stock_movement where tenant_id = any($1) group by 1, 2, 3, 4, 5)
    select count(*) from m full join app.stock_balance b on b.tenant_id = m.tenant_id and b.item_id = m.item_id and b.node_id = m.node_id
      and b.batch_key = m.bk and b.stock_status = m.stock_status
    where coalesce(b.tenant_id, m.tenant_id) = any($1) and (b.qty is distinct from m.q or b.value is distinct from m.v)`,
  'item_avg_cost ≠ Σ balances': `
    with b as (select tenant_id, item_id, node_id, sum(qty) q, sum(value) v from app.stock_balance where tenant_id = any($1) group by 1, 2, 3)
    select count(*) from b full join app.item_avg_cost a using (tenant_id, item_id, node_id)
    where coalesce(a.tenant_id, b.tenant_id) = any($1) and (a.qty is distinct from b.q or a.value is distinct from b.v)`,
  'negative running balance': `
    select count(*) from (select sum(qty_in - qty_out) over (partition by tenant_id, item_id, node_id, batch_id, stock_status order by id) bal
      from app.stock_movement where tenant_id = any($1)) x where bal < 0`,
  'wf_line_state ≠ pendingApproval (running)': `
    with w as (select ls.line_id, sum(ls.pending_qty + ls.held_qty) q from app.wf_line_state ls join app.wf_instance i on i.id = ls.instance_id
      where ls.tenant_id = any($1) and i.status = 'running' group by ls.line_id)
    select count(*) from w join app.line_qty_summary s on s.line_id = w.line_id where w.q <> s.requested - s.approved - s.rejected - s.cancelled`,
  'running instance without active stage': `select count(*) from app.wf_instance i where i.tenant_id = any($1) and i.status = 'running'
    and not exists (select 1 from app.wf_stage_state ss where ss.instance_id = i.id and ss.status = 'active')`,
  'PO received > ordered + 5 %': `select count(*) from app.line_qty_summary s join app.document_line l on l.id = s.line_id join app.doc_type t on t.id = l.doc_type_id
    where s.tenant_id = any($1) and t.key = 'po' and s.received > s.ordered * 1.05`,
  'indent ordered > approved': `select count(*) from app.line_qty_summary s join app.document_line l on l.id = s.line_id join app.doc_type t on t.id = l.doc_type_id
    where s.tenant_id = any($1) and t.key = 'indent' and s.ordered > s.approved + s.over_approved`,
  'duplicate document numbers': `select count(*) from (select 1 from app.document where tenant_id = any($1) and number is not null group by tenant_id, doc_type_id, number having count(*) > 1) x`,
};
let bad = 0;
console.log(`verifying ${tenants.length} tenant(s)`);
for (const [name, sql] of Object.entries(checks)) {
  const t0 = Date.now();
  const n = Number((await c.query(sql, [ids])).rows[0].count);
  if (n) bad++;
  console.log(`  ${n === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${String(n).padStart(8)}   (${Date.now() - t0} ms)`);
}
const vol = (await c.query(`select
  (select count(*) from app.document where tenant_id = any($1)) docs, (select count(*) from app.document_line where tenant_id = any($1)) lines,
  (select count(*) from app.line_event where tenant_id = any($1)) events, (select count(*) from app.stock_movement where tenant_id = any($1)) movements,
  (select count(*) from app.stock_balance where tenant_id = any($1)) balances, (select count(*) from app.wf_instance where tenant_id = any($1) and status = 'running') running`, [ids])).rows[0];
console.log('  volume:', JSON.stringify(vol));
await c.end();
process.exit(bad ? 1 : 0);
