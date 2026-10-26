import { sql } from 'kysely';
import type { RawBuilder, SqlBool } from 'kysely';
import type { EngineSourceDef, SourceField } from '../../reports';
import { STOCK_FEATURE } from '../ledger/types';

/**
 * Report engine sources `stock_balance` and `stock_ledger` (contract "Reports sources"; ADR-0015). Fields are
 * allow-listed SQL over these aliases. Status rows are limited to the viewer's `stock:view.<status>` keys; value /
 * cost fields exist only for holders of `stock:action.view_value`. Data scope: tab `stock` on the node path.
 */
type FT = SourceField['type'];
const f = (id: string, label: string, type: FT, expr: RawBuilder<unknown>, path: string[], extra: Partial<SourceField> = {}): SourceField => ({
  id, label, type, expr, path, groupable: type !== 'number' && type !== 'currency', filterable: true, aggregatable: type === 'number' || type === 'currency', ...extra,
});
const STATUS_LABELS = { available: 'Available', quarantine: 'Quarantine / blocked', rejected: 'Rejected' };
const MOVEMENT_LABELS: Record<string, string> = {
  opening: 'Opening', receipt: 'Receipt', issue: 'Issue', return: 'Return', transfer_out: 'Transfer out', transfer_in: 'Transfer in', adjustment_in: 'Adjustment in',
  adjustment_out: 'Adjustment out', block: 'Block', unblock: 'Unblock', reject: 'Reject', rtv: 'Return to vendor', count_in: 'Count gain', count_out: 'Count loss', reversal: 'Reversal',
};

function held(perms: { keys: string[] } | null): string[] {
  const all = ['available', 'quarantine', 'rejected'];
  return perms === null ? all : all.filter(s => perms.keys.includes(`stock:view.${s}`));
}
const canValue = (perms: { keys: string[] } | null) => perms === null || perms.keys.includes('stock:action.view_value');

function common(tenantId: string): SourceField[] {
  return [
    f('item.code', 'Item code', 'text', sql`i.code::text`, ['Item'], { idExpr: sql`i.id` }),
    f('item.name', 'Item', 'lookup', sql`i.name`, ['Item'], { idExpr: sql`i.id` }),
    f('item.category', 'Item category', 'lookup', sql`(select c.name from app.master_record c where c.tenant_id = ${tenantId} and c.id::text = i.data->>'category')`, ['Item']),
    f('location.name', 'Location', 'lookup', sql`n.name`, ['Location'], { idExpr: sql`n.id`, locationPath: sql`n.path` }),
    f('location.code', 'Location code', 'text', sql`n.code::text`, ['Location'], { idExpr: sql`n.id`, locationPath: sql`n.path` }),
    f('location.top', 'Location (top level)', 'text', sql`(select a.name from app.location_node a where a.tenant_id = ${tenantId} and a.path = subpath(n.path, 0, 1))`, ['Location']),
    f('batch_no', 'Batch', 'text', sql`sb.batch_no`, ['Batch']),
    f('expiry_date', 'Expiry date', 'date', sql`sb.expiry_date`, ['Batch']),
  ];
}

export function stockBalanceSource(): EngineSourceDef {
  return {
    key: 'stock_balance',
    label: 'Stock balances',
    viewKey: 'stock:action.view',
    requiresFeature: STOCK_FEATURE,
    async build(ctx) {
      const statuses = held(ctx.perms);
      const fields: SourceField[] = [
        ...common(ctx.tenantId),
        f('status', 'Stock status', 'status', sql`b.stock_status`, ['Stock'], { labels: STATUS_LABELS, allowedValues: statuses }),
        f('qty', 'Quantity', 'number', sql`b.qty`, ['Stock']),
        f('reorder.min_qty', 'Re-order minimum', 'number', sql`(select r.min_qty from app.reorder_rule r where r.tenant_id = ${ctx.tenantId} and r.item_id = b.item_id and r.node_id = b.node_id and r.is_active)`, ['Re-order']),
        f('updated_at', 'Last movement at', 'datetime', sql`b.updated_at`, ['Stock']),
      ];
      if (canValue(ctx.perms)) {
        fields.push(f('value', 'Value', 'currency', sql`b.value`, ['Value']));
        fields.push(f('avg_cost', 'Average cost', 'currency', sql`ac.avg_cost`, ['Value'], { aggregatable: false }));
      }
      return {
        from: sql`app.stock_balance b
          join app.master_record i on i.id = b.item_id
          join app.location_node n on n.id = b.node_id
          left join app.stock_batch sb on sb.id = nullif(b.batch_key, '00000000-0000-0000-0000-000000000000'::uuid)
          left join app.item_avg_cost ac on ac.tenant_id = b.tenant_id and ac.item_id = b.item_id and ac.node_id = b.node_id`,
        where: [sql<SqlBool>`b.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`b.qty <> 0`, sql<SqlBool>`b.stock_status = any(${sql.val(statuses)}::text[])`],
        scope: { tabKey: 'stock', path: sql`n.path` },
        rowId: sql`(b.item_id::text || ':' || b.node_id::text || ':' || b.batch_key::text || ':' || b.stock_status)`,
        defaultSort: [{ field: 'item.code', dir: 'asc' }],
        link: sql`'/stock/items/' || b.item_id::text`,
        fields,
      };
    },
  };
}

export function stockLedgerSource(): EngineSourceDef {
  return {
    key: 'stock_ledger',
    label: 'Stock ledger (movements)',
    viewKey: 'stock:action.view',
    requiresFeature: STOCK_FEATURE,
    async build(ctx) {
      const statuses = held(ctx.perms);
      const fields: SourceField[] = [
        ...common(ctx.tenantId),
        f('at', 'Date', 'datetime', sql`m.at`, ['Movement']),
        f('movement_type', 'Movement type', 'status', sql`m.movement_type`, ['Movement'], { labels: MOVEMENT_LABELS }),
        f('status', 'Stock status', 'status', sql`m.stock_status`, ['Movement'], { labels: STATUS_LABELS, allowedValues: statuses }),
        f('qty_in', 'Qty in', 'number', sql`m.qty_in`, ['Movement']),
        f('qty_out', 'Qty out', 'number', sql`m.qty_out`, ['Movement']),
        f('net_qty', 'Net qty', 'number', sql`(m.qty_in - m.qty_out)`, ['Movement']),
        f('reason', 'Reason', 'text', sql`m.reason`, ['Movement']),
        f('document.number', 'Document no.', 'text', sql`d.number`, ['Document']),
        f('document.type', 'Document type', 'text', sql`dt.name`, ['Document']),
        f('actor', 'By', 'lookup', sql`u.name`, ['Movement'], { idExpr: sql`u.id` }),
      ];
      if (canValue(ctx.perms)) {
        fields.push(f('unit_cost', 'Unit cost', 'currency', sql`m.unit_cost`, ['Value'], { aggregatable: false }));
        fields.push(f('value', 'Value', 'currency', sql`m.value`, ['Value']));
      }
      return {
        from: sql`app.stock_movement m
          join app.master_record i on i.id = m.item_id
          join app.location_node n on n.id = m.node_id
          left join app.stock_batch sb on sb.id = m.batch_id
          left join app.document d on d.id = m.document_id
          left join app.doc_type dt on dt.id = d.doc_type_id
          left join app.tenant_user u on u.id = m.actor_id`,
        where: [sql<SqlBool>`m.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`m.stock_status = any(${sql.val(statuses)}::text[])`],
        scope: { tabKey: 'stock', path: sql`n.path` },
        rowId: sql`m.id`,
        dateField: 'at',
        defaultSort: [{ field: 'at', dir: 'desc' }],
        link: sql`case when d.id is null then null else '/docs/' || dt.key || '/' || d.id::text end`,
        fields,
      };
    },
  };
}
