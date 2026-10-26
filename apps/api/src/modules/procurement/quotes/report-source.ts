import { sql } from 'kysely';
import type { Expression, RawBuilder, SqlBool } from 'kysely';
import type { Tx } from '../../../core/db.service';

/**
 * Report engine source `vendor_quote` (Phase 7 catalogue hook, ADR-0015). Plain descriptor — structurally the
 * reports module's EngineSourceDef — so the reports agent can `registerSource(vendorQuoteSource())` without this
 * module importing the reports module. Every column is an allow-listed SQL expression over these aliases:
 *   q = app.vendor_quote, l = indent line, d = indent document, n = location, v = vendor, i = item, u = creator.
 */
type FieldType = 'text' | 'number' | 'currency' | 'date' | 'datetime' | 'boolean' | 'status' | 'lookup';
export interface VendorQuoteSourceField {
  id: string; label: string; type: FieldType; path: string[]; expr: RawBuilder<unknown>;
  groupable?: boolean; filterable?: boolean; aggregatable?: boolean; idExpr?: RawBuilder<unknown>; locationPath?: RawBuilder<unknown>;
}
export interface VendorQuoteSourceDef {
  key: string; label: string; viewKey: string | null; requiresFeature?: string;
  build(ctx: { tx: Tx; tenantId: string; userId: string | null }): Promise<{
    from: RawBuilder<unknown>; where: Expression<SqlBool>[]; scope?: { tabKey: string; path: RawBuilder<unknown> }; rowId: RawBuilder<unknown>;
    fields: VendorQuoteSourceField[]; dateField?: string; defaultSort?: { field: string; dir: 'asc' | 'desc' }[]; link?: RawBuilder<unknown>;
  }>;
}

const f = (id: string, label: string, type: FieldType, expr: RawBuilder<unknown>, path: string[], extra: Partial<VendorQuoteSourceField> = {}): VendorQuoteSourceField => ({
  id, label, type, expr, path, groupable: type !== 'number' && type !== 'currency', filterable: true, aggregatable: type === 'number' || type === 'currency', ...extra,
});

export function vendorQuoteSource(): VendorQuoteSourceDef {
  return {
    key: 'vendor_quote',
    label: 'Vendor quotes',
    viewKey: 'doc.indent:action.view',
    requiresFeature: 'vendor_quotes',
    async build(ctx) {
      return {
        from: sql`app.vendor_quote q
          join app.document_line l on l.id = q.indent_line_id
          join app.document d on d.id = l.document_id
          join app.location_node n on n.id = d.location_node_id
          join app.master_record v on v.id = q.vendor_id
          left join app.master_record i on i.id = q.item_id
          left join app.tenant_user u on u.id = q.created_by`,
        where: [sql<SqlBool>`q.tenant_id = ${ctx.tenantId}`, sql<SqlBool>`not d.is_deleted`],
        scope: { tabKey: 'doc.indent', path: sql`n.path` },
        rowId: sql`q.id`,
        dateField: 'logged_at',
        defaultSort: [{ field: 'logged_at', dir: 'desc' }],
        link: sql`'/docs/indent/' || d.id::text`,
        fields: [
          f('indent_number', 'Indent no.', 'text', sql`d.number`, ['Indent']),
          f('indent_line_no', 'Line no.', 'number', sql`l.line_no`, ['Indent'], { aggregatable: false }),
          f('location', 'Location', 'lookup', sql`n.name`, ['Indent'], { idExpr: sql`n.id`, locationPath: sql`n.path` }),
          f('item.code', 'Item code', 'text', sql`i.code`, ['Item'], { idExpr: sql`i.id` }),
          f('item.name', 'Item', 'lookup', sql`i.name`, ['Item'], { idExpr: sql`i.id` }),
          f('vendor.code', 'Vendor code', 'text', sql`v.code`, ['Vendor'], { idExpr: sql`v.id` }),
          f('vendor.name', 'Vendor', 'lookup', sql`v.name`, ['Vendor'], { idExpr: sql`v.id` }),
          f('version', 'Version', 'number', sql`q.version`, ['Quote'], { aggregatable: false }),
          f('is_current', 'Current', 'boolean', sql`q.is_current`, ['Quote']),
          f('quoted_rate', 'Quoted rate', 'currency', sql`q.quoted_rate`, ['Quote']),
          f('currency', 'Currency', 'text', sql`q.currency`, ['Quote']),
          f('moq', 'MOQ', 'number', sql`q.moq`, ['Quote']),
          f('lead_time_days', 'Lead time (days)', 'number', sql`q.lead_time_days`, ['Quote']),
          f('valid_until', 'Valid until', 'date', sql`q.valid_until`, ['Quote']),
          f('freight', 'Freight', 'currency', sql`q.freight`, ['Quote']),
          f('freight_basis', 'Freight basis', 'text', sql`q.freight_basis`, ['Quote']),
          f('tax_pct', 'Tax %', 'number', sql`q.tax_pct`, ['Quote']),
          f('has_slabs', 'Has slabs', 'boolean', sql`jsonb_array_length(q.slabs) > 0`, ['Quote']),
          f('logged_at', 'Logged at', 'datetime', sql`q.logged_at`, ['Quote']),
          f('created_by', 'Logged by', 'lookup', sql`u.name`, ['Quote'], { idExpr: sql`u.id` }),
        ],
      };
    },
  };
}
