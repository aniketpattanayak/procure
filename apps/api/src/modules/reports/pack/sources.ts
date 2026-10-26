import { RawBuilder, sql, SqlBool } from 'kysely';
import type { MyPermissions } from '@procure/schema';
import { asDate } from '../fields';
import type { EngineSourceDef, ResolvedSource, SourceContext, SourceField } from '../types';

/**
 * Standard report pack — computed engine sources and measures (ADR-0015). Generic SQL over the system tables of the
 * procurement / stores modules (system doc types `po`, `grn`, store issues and returns, the stock ledger and re-order
 * rules); nothing here is per tenant. Every value a viewer passes is a bound parameter (period dates come from the
 * compiler's validated run range).
 *
 *  - `purchase_lines`          one row per submitted PO line: ordered / received / rejected / returned / pending,
 *                              expected date, overdue, lead time, on-time and rejection ratios (weighted averages)
 *  - `stock_movement_summary`  item × location × status for a period: opening, in, out, closing (qty + value)
 *  - `stock_consumption`       store issues net of returns, by department / location / item
 *  - `stock_reorder`           re-order rules with the available stock of the rule's subtree, shortfall, suggestion
 *  - extensions: `vendor_quote` (rank on the line, lowest rate, % above lowest), `stock_balance` (days to expiry,
 *    expiry bucket)
 */

type FT = SourceField['type'];
const f = (id: string, label: string, type: FT, expr: RawBuilder<unknown>, path: string[], extra: Partial<SourceField> = {}): SourceField => ({
  id, label, type, expr, path, groupable: type !== 'number' && type !== 'currency' && type !== 'datetime', filterable: true,
  aggregatable: type === 'number' || type === 'currency', ...extra,
});

/** GRN line custom keys / doc type keys of the inventory module (system types; strings to avoid a module cycle). */
const GRN = 'grn';
const PO = 'po';
const GRN_PO_LINE = 'po_line';
const STORE_FEATURE = 'store';
const STOCK_STATUS = ['available', 'quarantine', 'rejected'];
const STOCK_STATUS_LABELS = { available: 'Available', quarantine: 'Quarantine / blocked', rejected: 'Rejected' };

const has = (perms: MyPermissions | null, key: string) => !perms || perms.keys.includes(key);
const stockHeld = (perms: MyPermissions | null) => STOCK_STATUS.filter(s => has(perms, `stock:view.${s}`));
const canValue = (perms: MyPermissions | null) => has(perms, 'stock:action.view_value');
/** Statuses of a doc type the viewer may see (null = all). `submitted` is shown as draft by the documents core. */
const docHeld = (perms: MyPermissions | null, type: string) => (perms ? perms.keys.filter(k => k.startsWith(`doc.${type}:view.`)).map(k => k.slice(`doc.${type}:view.`.length)) : null);
const today = (tz: string) => sql`(now() at time zone ${tz})::date`;
/** Start of a tenant-local day as an instant. */
const dayStart = (d: string, tz: string) => sql`((${d}::date)::timestamp at time zone ${tz})`;

type LocationFields = (t: { tenantId: string }, nodeId: RawBuilder<unknown>, loc: string, access: SourceField['access'], path?: string[], idPrefix?: string) => SourceField[];

export interface PackSourceDeps {
  register(def: EngineSourceDef): void;
  extend(key: string, ext: (ctx: SourceContext, built: Omit<ResolvedSource, 'source' | 'label' | 'viewKey'>) => SourceField[]): void;
  timezone(tenantId: string): Promise<string>;
  locationFields: LocationFields;
}

function itemFields(tenantId: string, alias = 'i'): SourceField[] {
  const i = sql.ref(alias);
  return [
    f('item.code', 'Item code', 'text', sql`${i}.code::text`, ['Item'], { idExpr: sql`${i}.id` }),
    f('item.name', 'Item', 'lookup', sql`${i}.name`, ['Item'], { idExpr: sql`${i}.id` }),
    f('item.category', 'Item category', 'lookup', sql`(select c.name from app.master_record c where c.tenant_id = ${tenantId} and c.id::text = ${i}.data->>'category')`, ['Item']),
  ];
}

// ------------------------------------------------------------------ purchase_lines

function purchaseLines(d: PackSourceDeps): EngineSourceDef {
  return {
    key: 'purchase_lines', label: 'Purchase order lines (delivery & vendor performance)', viewKey: `doc.${PO}:action.view`, requiresFeature: 'purchase',
    async build(ctx) {
      const tz = ctx.timezone ?? await d.timezone(ctx.tenantId);
      const held = docHeld(ctx.perms, PO);
      const status = sql`(case when d.status_key = 'submitted' then 'draft' else d.status_key end)`;
      const ordered = sql`coalesce(s.ordered, 0)`;
      const received = sql`coalesce(s.received, 0)`;
      const rejected = sql`coalesce(rc.rejected, 0)`;
      const pending = sql`greatest(${ordered} - ${received} - coalesce(s.short_closed, 0), 0)`;
      const unit = sql`(case when l.qty > 0 then coalesce(l.amount, 0) / l.qty else coalesce(l.rate, 0) end)`;
      const txt = (e: RawBuilder<unknown>) => sql`nullif(${e}, '')`;
      // follow-up revision (line, then header) → derived line expected date → header expected date
      const expected = asDate(sql`coalesce(${txt(sql`l.custom->>'__revised_expected_date'`)}, ${txt(sql`d.custom->>'__revised_expected_date'`)},
        ${txt(sql`l.custom->>'expected_date'`)}, ${txt(sql`d.custom->>'expected_date'`)})`);
      const delivered = sql`(${received} > 0)`;
      const onTime = sql`(${delivered} and (${expected} is null or rc.first_receipt <= ${expected}))`;
      const overdue = sql`(${pending} > 0 and ${expected} < ${today(tz)})`;
      const poDate: SourceField = f('po_date', 'PO date', 'date', sql`d.doc_date`, ['Purchase order']);
      return {
        from: sql`app.document_line l
          join app.document d on d.id = l.document_id
          join app.doc_type t on t.id = d.doc_type_id
          join app.location_node loc on loc.id = d.location_node_id
          left join app.master_record v on v.id = d.party_id
          left join app.master_record i on i.id = l.item_id
          left join app.master_record u on u.id = l.uom_id
          left join app.line_qty_summary s on s.line_id = l.id
          left join (
            select gl.custom->>${GRN_PO_LINE} as po_line, min(g.doc_date) as first_receipt, max(g.doc_date) as last_receipt,
                   count(distinct g.id) as grn_count, sum(coalesce(gs.rejected, 0) + coalesce(gs.rejected_at_receipt, 0)) as rejected
              from app.document_line gl
              join app.document g on g.id = gl.document_id
              join app.doc_type gt on gt.id = g.doc_type_id and gt.key = ${GRN}
              left join app.line_qty_summary gs on gs.line_id = gl.id
             where gl.tenant_id = ${ctx.tenantId} and not gl.is_deleted and not g.is_deleted and g.number is not null and g.status_key <> 'cancelled'
               and gl.custom ? ${GRN_PO_LINE}
             group by 1
          ) rc on rc.po_line = l.id::text`,
        where: [
          sql<SqlBool>`l.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`t.key = ${PO}`, sql<SqlBool>`not l.is_deleted`, sql<SqlBool>`not d.is_deleted`,
          sql<SqlBool>`d.number is not null`,
          held === null ? sql<SqlBool>`true` : held.length ? sql<SqlBool>`${status} = any(${sql.val(held)}::text[])` : sql<SqlBool>`false`,
        ],
        scope: { tabKey: `doc.${PO}`, path: sql`loc.path` },
        rowId: sql`l.id`,
        dateField: 'po_date',
        defaultSort: [{ field: 'po_date', dir: 'desc' }, { field: 'po_number', dir: 'desc' }, { field: 'line_no', dir: 'asc' }],
        link: sql`'/docs/po/' || d.id::text`,
        fields: [
          f('po_number', 'PO no.', 'text', sql`d.number`, ['Purchase order']),
          poDate,
          f('po_date.month', 'PO month', 'text', sql`to_char(d.doc_date, 'YYYY-MM')`, ['Purchase order']),
          f('po_date.year', 'PO year', 'text', sql`to_char(d.doc_date, 'YYYY')`, ['Purchase order']),
          f('po_status', 'PO status', 'text', sql`initcap(replace(${status}, '_', ' '))`, ['Purchase order']),
          f('po_status.key', 'PO status key', 'text', status, ['Purchase order'], held ? { allowedValues: held } : {}),
          f('line_no', 'Line no.', 'number', sql`l.line_no`, ['Purchase order'], { aggregatable: false }),
          ...d.locationFields(ctx, sql`d.location_node_id`, 'loc', undefined),
          f('vendor.code', 'Vendor code', 'text', sql`v.code::text`, ['Vendor'], { idExpr: sql`v.id` }),
          f('vendor.name', 'Vendor', 'lookup', sql`v.name`, ['Vendor'], { idExpr: sql`v.id` }),
          ...itemFields(ctx.tenantId),
          f('uom', 'Unit', 'text', sql`u.code::text`, ['Item']),
          f('rate', 'Rate', 'currency', sql`l.rate`, ['Value']),
          f('amount', 'Line amount', 'currency', sql`l.amount`, ['Value']),
          f('ordered_value', 'Ordered value', 'currency', sql`round(${ordered} * ${unit}, 2)`, ['Value']),
          f('received_value', 'Received value', 'currency', sql`round(${received} * ${unit}, 2)`, ['Value']),
          f('pending_value', 'Pending value', 'currency', sql`round(${pending} * ${unit}, 2)`, ['Value']),
          f('qty', 'Line qty', 'number', sql`l.qty`, ['Quantities']),
          f('ordered_qty', 'Ordered qty', 'number', ordered, ['Quantities']),
          f('received_qty', 'Received qty', 'number', received, ['Quantities']),
          f('rejected_qty', 'Rejected qty', 'number', rejected, ['Quantities']),
          f('accepted_qty', 'Accepted qty (after QC)', 'number', sql`greatest(${received} - ${rejected}, 0)`, ['Quantities']),
          f('returned_qty', 'Returned to vendor', 'number', sql`coalesce(s.returned, 0)`, ['Quantities']),
          f('short_closed_qty', 'Short-closed qty', 'number', sql`coalesce(s.short_closed, 0)`, ['Quantities']),
          f('pending_qty', 'Pending qty', 'number', pending, ['Quantities']),
          f('expected_date', 'Expected date', 'date', expected, ['Delivery']),
          f('first_receipt_date', 'First receipt', 'date', sql`rc.first_receipt`, ['Delivery']),
          f('last_receipt_date', 'Last receipt', 'date', sql`rc.last_receipt`, ['Delivery']),
          f('grn_count', 'GRNs', 'number', sql`coalesce(rc.grn_count, 0)`, ['Delivery']),
          f('overdue', 'Overdue', 'boolean', sql`coalesce(${overdue}, false)`, ['Delivery']),
          f('days_overdue', 'Days overdue', 'number', sql`(case when ${overdue} then ${today(tz)} - ${expected} else 0 end)`, ['Delivery']),
          f('lead_time_days', 'Lead time (days)', 'number', sql`(rc.first_receipt - d.doc_date)`, ['Delivery']),
          f('on_time', 'Delivered on time', 'boolean', sql`(case when ${delivered} then ${onTime} end)`, ['Delivery']),
          f('on_time_pct', 'On-time %', 'number', sql`(case when ${delivered} then (case when ${onTime} then 100 else 0 end) end)`, ['Delivery'], {
            ratio: { num: sql`(case when ${onTime} then 1 else 0 end)`, den: sql`(case when ${delivered} then 1 else 0 end)`, scale: 100 },
          }),
          f('rejection_pct', 'Rejection %', 'number', sql`round(${rejected} * 100 / nullif(${received}, 0), 2)`, ['Quantities'], {
            ratio: { num: rejected, den: received, scale: 100 },
          }),
          f('fill_pct', 'Received %', 'number', sql`round(${received} * 100 / nullif(${ordered}, 0), 2)`, ['Quantities'], {
            ratio: { num: received, den: ordered, scale: 100 },
          }),
        ],
      };
    },
  };
}

// ------------------------------------------------------------------ stock_movement_summary

function movementSummary(d: PackSourceDeps): EngineSourceDef {
  return {
    key: 'stock_movement_summary', label: 'Stock movement summary (period)', viewKey: 'stock:action.view', requiresFeature: STORE_FEATURE,
    async build(ctx) {
      const tz = ctx.timezone ?? await d.timezone(ctx.tenantId);
      const statuses = stockHeld(ctx.perms);
      // No range: everything up to now (opening 0). The range comes from the compiler (validated dates).
      const from = ctx.range ? dayStart(ctx.range.from, tz) : sql`'-infinity'::timestamptz`;
      const toNext = ctx.range ? sql`(((${ctx.range.to}::date) + 1)::timestamp at time zone ${tz})` : sql`'infinity'::timestamptz`;
      const fields: SourceField[] = [
        ...itemFields(ctx.tenantId),
        ...d.locationFields(ctx, sql`n.id`, 'n', undefined),
        f('status', 'Stock status', 'status', sql`ms.stock_status`, ['Stock'], { labels: STOCK_STATUS_LABELS, allowedValues: statuses }),
        f('opening_qty', 'Opening qty', 'number', sql`ms.opening_qty`, ['Quantities']),
        f('in_qty', 'Qty in', 'number', sql`ms.in_qty`, ['Quantities']),
        f('out_qty', 'Qty out', 'number', sql`ms.out_qty`, ['Quantities']),
        f('closing_qty', 'Closing qty', 'number', sql`ms.closing_qty`, ['Quantities']),
      ];
      if (canValue(ctx.perms)) {
        fields.push(
          f('opening_value', 'Opening value', 'currency', sql`ms.opening_value`, ['Value']),
          f('in_value', 'Value in', 'currency', sql`ms.in_value`, ['Value']),
          f('out_value', 'Value out', 'currency', sql`ms.out_value`, ['Value']),
          f('closing_value', 'Closing value', 'currency', sql`ms.closing_value`, ['Value']),
        );
      }
      return {
        from: sql`(
            select m.item_id, m.node_id, m.stock_status,
              sum(case when m.at < ${from} then m.qty_in - m.qty_out else 0 end) as opening_qty,
              sum(case when m.at >= ${from} then m.qty_in else 0 end) as in_qty,
              sum(case when m.at >= ${from} then m.qty_out else 0 end) as out_qty,
              sum(m.qty_in - m.qty_out) as closing_qty,
              sum(case when m.at < ${from} then m.value else 0 end) as opening_value,
              sum(case when m.at >= ${from} and m.value > 0 then m.value else 0 end) as in_value,
              sum(case when m.at >= ${from} and m.value < 0 then -m.value else 0 end) as out_value,
              sum(m.value) as closing_value
            from app.stock_movement m
            where m.tenant_id = ${ctx.tenantId} and m.at < ${toNext}
            group by 1, 2, 3
          ) ms
          join app.master_record i on i.id = ms.item_id
          join app.location_node n on n.id = ms.node_id`,
        where: [
          sql<SqlBool>`ms.stock_status = any(${sql.val(statuses)}::text[])`,
          sql<SqlBool>`(ms.opening_qty <> 0 or ms.in_qty <> 0 or ms.out_qty <> 0 or ms.closing_qty <> 0)`,
        ],
        scope: { tabKey: 'stock', path: sql`n.path` },
        rowId: sql`(ms.item_id::text || ':' || ms.node_id::text || ':' || ms.stock_status)`,
        consumesDateRange: true,
        defaultSort: [{ field: 'item.code', dir: 'asc' }, { field: 'location.name', dir: 'asc' }],
        link: sql`'/stock/items/' || ms.item_id::text`,
        fields,
      };
    },
  };
}

// ------------------------------------------------------------------ stock_consumption

function consumption(d: PackSourceDeps): EngineSourceDef {
  return {
    key: 'stock_consumption', label: 'Consumption (issues net of returns)', viewKey: 'stock:action.view', requiresFeature: STORE_FEATURE,
    async build(ctx) {
      const tz = ctx.timezone ?? await d.timezone(ctx.tenantId);
      const statuses = stockHeld(ctx.perms);
      const at: SourceField = f('at', 'Date', 'datetime', sql`m.at`, ['Movement']);
      const local = sql`(m.at at time zone ${tz})`;
      const fields: SourceField[] = [
        ...itemFields(ctx.tenantId),
        ...d.locationFields(ctx, sql`dl.id`, 'dl', undefined),
        ...d.locationFields(ctx, sql`n.id`, 'n', undefined, ['Store'], 'store'),
        f('department.name', 'Department', 'lookup', sql`coalesce(dep.name, '(No department)')`, ['Department'], { idExpr: sql`dep.id` }),
        f('department.code', 'Department code', 'text', sql`dep.code::text`, ['Department']),
        at,
        f('at.month', 'Month', 'text', sql`to_char(${local}, 'YYYY-MM')`, ['Movement']),
        f('document.number', 'Document no.', 'text', sql`d.number`, ['Movement']),
        f('document.type', 'Document type', 'text', sql`dt.name`, ['Movement']),
        f('movement_type', 'Movement', 'status', sql`m.movement_type`, ['Movement'], { labels: { issue: 'Issue', return: 'Return' } }),
        f('issued_qty', 'Issued qty', 'number', sql`m.qty_out`, ['Quantities']),
        f('returned_qty', 'Returned qty', 'number', sql`m.qty_in`, ['Quantities']),
        f('consumed_qty', 'Consumed qty (net)', 'number', sql`(m.qty_out - m.qty_in)`, ['Quantities']),
      ];
      if (canValue(ctx.perms)) fields.push(f('consumed_value', 'Consumed value (net)', 'currency', sql`(-m.value)`, ['Value']));
      return {
        from: sql`app.stock_movement m
          join app.master_record i on i.id = m.item_id
          join app.location_node n on n.id = m.node_id
          left join app.document d on d.id = m.document_id
          left join app.doc_type dt on dt.id = d.doc_type_id
          left join app.location_node dl on dl.id = coalesce(d.location_node_id, m.node_id)
          left join app.master_record dep on dep.tenant_id = m.tenant_id and dep.id::text = d.custom->>'department'`,
        where: [
          sql<SqlBool>`m.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`m.movement_type in ('issue', 'return')`,
          sql<SqlBool>`m.stock_status = any(${sql.val(statuses)}::text[])`,
        ],
        scope: { tabKey: 'stock', path: sql`n.path` },
        rowId: sql`m.id`, dateField: 'at',
        defaultSort: [{ field: 'at', dir: 'desc' }],
        link: sql`case when d.id is null then null else '/docs/' || dt.key || '/' || d.id::text end`,
        fields,
      };
    },
  };
}

// ------------------------------------------------------------------ stock_reorder

function reorder(d: PackSourceDeps): EngineSourceDef {
  return {
    key: 'stock_reorder', label: 'Re-order levels', viewKey: 'stock:action.view', requiresFeature: STORE_FEATURE,
    async build(ctx) {
      const seesAvailable = stockHeld(ctx.perms).includes('available');
      // Same rule as the stock module's re-order check: a rule on a node covers the node's subtree.
      const avail = sql`coalesce(av.qty, 0)`;
      const below = sql`(${avail} < r.min_qty)`;
      const suggested = sql`(case when ${below} then greatest(
        case when r.max_qty is not null and r.max_qty - ${avail} > 0 then r.max_qty - ${avail} else r.reorder_qty end, r.min_qty - ${avail}) else 0 end)`;
      return {
        from: sql`app.reorder_rule r
          join app.master_record i on i.id = r.item_id
          join app.location_node n on n.id = r.node_id
          left join lateral (
            select sum(b.qty) as qty from app.stock_balance b join app.location_node bn on bn.id = b.node_id
             where b.tenant_id = r.tenant_id and b.item_id = r.item_id and b.stock_status = 'available' and bn.path <@ n.path
          ) av on true`,
        where: [sql<SqlBool>`r.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`r.is_active`, seesAvailable ? sql<SqlBool>`true` : sql<SqlBool>`false`],
        scope: { tabKey: 'stock', path: sql`n.path` },
        rowId: sql`r.id`,
        defaultSort: [{ field: 'shortfall_qty', dir: 'desc' }, { field: 'item.code', dir: 'asc' }],
        link: sql`'/stock/items/' || r.item_id::text`,
        fields: [
          ...itemFields(ctx.tenantId),
          ...d.locationFields(ctx, sql`n.id`, 'n', undefined),
          f('available_qty', 'Available qty', 'number', avail, ['Re-order']),
          f('min_qty', 'Minimum', 'number', sql`r.min_qty`, ['Re-order']),
          f('reorder_qty', 'Re-order qty', 'number', sql`r.reorder_qty`, ['Re-order']),
          f('max_qty', 'Maximum', 'number', sql`r.max_qty`, ['Re-order']),
          f('below_min', 'Below minimum', 'boolean', below, ['Re-order']),
          f('shortfall_qty', 'Shortfall', 'number', sql`greatest(r.min_qty - ${avail}, 0)`, ['Re-order']),
          f('suggested_qty', 'Suggested order qty', 'number', suggested, ['Re-order']),
          f('auto_indent', 'Auto indent', 'boolean', sql`r.auto_indent`, ['Re-order']),
          f('last_alert_at', 'Last alert', 'datetime', sql`r.last_alert_at`, ['Re-order']),
        ],
      };
    },
  };
}

// ------------------------------------------------------------------ extensions

export const EXPIRY_BUCKETS: Record<string, string> = {
  a_expired: 'Expired', b_0_30: 'Within 30 days', c_31_60: '31–60 days', d_61_90: '61–90 days', e_over_90: 'Over 90 days',
};

export function installPackSources(d: PackSourceDeps): void {
  d.register(purchaseLines(d));
  d.register(movementSummary(d));
  d.register(consumption(d));
  d.register(reorder(d));

  // vendor_quote (aliases q = quote, l = indent line): rank among the line's current quotes, lowest rate, % above it.
  d.extend('vendor_quote', () => {
    const lowest = sql`(select min(q2.quoted_rate) from app.vendor_quote q2 where q2.tenant_id = q.tenant_id and q2.indent_line_id = q.indent_line_id and q2.is_current)`;
    return [
      f('rank', 'Rank on line (1 = lowest)', 'number', sql`(select count(*) + 1 from app.vendor_quote q2 where q2.tenant_id = q.tenant_id
        and q2.indent_line_id = q.indent_line_id and q2.is_current and q2.quoted_rate < q.quoted_rate)`, ['Comparison'], { aggregatable: false }),
      f('lowest_rate', 'Lowest current rate', 'currency', lowest, ['Comparison'], { aggregatable: false }),
      f('vs_lowest_pct', '% above lowest', 'number', sql`round((q.quoted_rate - ${lowest}) * 100 / nullif(${lowest}, 0), 2)`, ['Comparison']),
      f('is_lowest', 'Lowest', 'boolean', sql`(q.quoted_rate <= ${lowest})`, ['Comparison']),
    ];
  });

  // stock_balance (sb = batch): days to expiry and an expiry bucket, in the tenant calendar.
  d.extend('stock_balance', ctx => {
    const days = sql`(sb.expiry_date - ${today(ctx.timezone ?? 'Asia/Kolkata')})`;
    return [
      f('days_to_expiry', 'Days to expiry', 'number', days, ['Batch'], { aggregatable: false }),
      f('expiry_bucket', 'Expiry', 'status', sql`(case when sb.expiry_date is null then null when ${days} < 0 then 'a_expired' when ${days} <= 30 then 'b_0_30'
        when ${days} <= 60 then 'c_31_60' when ${days} <= 90 then 'd_61_90' else 'e_over_90' end)`, ['Batch'], { labels: EXPIRY_BUCKETS }),
    ];
  });
}
