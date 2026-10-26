import { RawBuilder, sql, SqlBool } from 'kysely';
import type { EngineSourceDef, SourceField } from '../../reports';
import { GRN_FEATURE } from '../common';
import { GRN, GRN_LINE } from './grn.types';

type FieldType = SourceField['type'];
const f = (id: string, label: string, type: FieldType, expr: RawBuilder<unknown>, path: string[], extra: Partial<SourceField> = {}): SourceField => ({
  id, label, type, expr, path, groupable: type !== 'number' && type !== 'currency', filterable: true, aggregatable: type === 'number' || type === 'currency', ...extra,
});

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', on_hold: 'On hold', partially_approved: 'Partially approved', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', closed: 'Closed',
};

/**
 * Report engine source `receipts` (contract "Reports sources", `engine:receipts`): one row per submitted GRN line
 * with its PO line, vendor, item, quantities (received / accepted / rejected at receipt / returned), value and the
 * on-time flag (GRN date ≤ the PO line's expected date). Aliases: l = GRN line, d = GRN, n = GRN location,
 * ln = receiving location, v = vendor, i = item, pl = PO line, p = PO, s = GRN line summary.
 */
export function receiptsSource(): EngineSourceDef {
  return {
    key: 'receipts',
    label: 'Goods receipts',
    viewKey: `doc.${GRN}:action.view`,
    requiresFeature: GRN_FEATURE,
    async build(ctx) {
      const expected = sql`nullif(pl.custom->>'expected_date', '')::date`;
      return {
        from: sql`app.document_line l
          join app.document d on d.id = l.document_id
          join app.doc_type t on t.id = d.doc_type_id
          join app.location_node n on n.id = d.location_node_id
          join app.location_node ln on ln.id = l.location_node_id
          left join app.master_record v on v.id = d.party_id
          left join app.master_record i on i.id = l.item_id
          left join app.master_record u on u.id = l.uom_id
          left join app.line_qty_summary s on s.line_id = l.id
          left join app.document_line pl on pl.tenant_id = l.tenant_id and pl.id::text = l.custom->>${GRN_LINE.poLine}
          left join app.document p on p.id = pl.document_id`,
        where: [
          sql<SqlBool>`l.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`t.key = ${GRN}`, sql<SqlBool>`not l.is_deleted`, sql<SqlBool>`not d.is_deleted`,
          sql<SqlBool>`d.number is not null`,
        ],
        scope: { tabKey: `doc.${GRN}`, path: sql`n.path` },
        rowId: sql`l.id`,
        dateField: 'grn_date',
        defaultSort: [{ field: 'grn_date', dir: 'desc' }],
        link: sql`'/docs/grn/' || d.id::text`,
        fields: [
          f('grn_number', 'GRN no.', 'text', sql`d.number`, ['GRN']),
          f('grn_date', 'GRN date', 'date', sql`d.doc_date`, ['GRN']),
          f('line_no', 'Line no.', 'number', sql`l.line_no`, ['GRN'], { aggregatable: false }),
          f('status', 'Line status', 'status', sql`l.status_key`, ['GRN'], { labels: STATUS_LABELS }),
          f('invoice_no', 'Invoice no.', 'text', sql`d.custom->>'invoice_no'`, ['GRN']),
          f('batch_no', 'Batch no.', 'text', sql`nullif(l.custom->>${GRN_LINE.batchNo}, '')`, ['GRN']),
          f('expiry_date', 'Expiry date', 'date', sql`nullif(l.custom->>${GRN_LINE.expiryDate}, '')::date`, ['GRN']),
          f('location', 'Location', 'lookup', sql`n.name`, ['GRN'], { idExpr: sql`n.id`, locationPath: sql`n.path` }),
          f('receiving_location', 'Receiving location', 'lookup', sql`ln.name`, ['GRN'], { idExpr: sql`ln.id`, locationPath: sql`ln.path` }),
          f('vendor.code', 'Vendor code', 'text', sql`v.code::text`, ['Vendor'], { idExpr: sql`v.id` }),
          f('vendor.name', 'Vendor', 'lookup', sql`v.name`, ['Vendor'], { idExpr: sql`v.id` }),
          f('item.code', 'Item code', 'text', sql`i.code::text`, ['Item'], { idExpr: sql`i.id` }),
          f('item.name', 'Item', 'lookup', sql`i.name`, ['Item'], { idExpr: sql`i.id` }),
          f('uom', 'Unit', 'text', sql`u.code::text`, ['Item']),
          f('po_number', 'PO no.', 'text', sql`p.number`, ['Purchase order']),
          f('po_date', 'PO date', 'date', sql`p.doc_date`, ['Purchase order']),
          f('po_qty', 'Ordered qty', 'number', sql`pl.qty`, ['Purchase order'], { aggregatable: false }),
          f('expected_date', 'Expected date', 'date', expected, ['Purchase order']),
          f('received_qty', 'Received qty', 'number', sql`l.qty`, ['Quantities']),
          f('accepted_qty', 'Accepted qty', 'number', sql`coalesce(s.accepted, 0)`, ['Quantities']),
          f('rejected_at_receipt', 'Rejected at receipt', 'number', sql`coalesce(s.rejected_at_receipt, 0)`, ['Quantities']),
          f('returned_qty', 'Returned to vendor', 'number', sql`coalesce(s.returned, 0)`, ['Quantities']),
          f('rate', 'Rate', 'currency', sql`l.rate`, ['Value'], { aggregatable: false }),
          f('amount', 'Value received', 'currency', sql`l.amount`, ['Value']),
          f('accepted_value', 'Value accepted', 'currency', sql`round(coalesce(s.accepted, 0) * coalesce(l.rate, 0), 2)`, ['Value']),
          f('on_time', 'On time', 'boolean', sql`(${expected} is null or d.doc_date <= ${expected})`, ['Delivery']),
          f('days_late', 'Days late', 'number', sql`greatest(d.doc_date - ${expected}, 0)`, ['Delivery']),
        ],
      };
    },
  };
}
