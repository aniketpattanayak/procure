import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';

/**
 * Report engine source `po_followup` (Phase 7 catalogue hook, contract "Reports sources contributed"). Plain
 * descriptor in the shape of the reports module's `EngineSourceDef` (modules/reports/types.ts) so the reports agent
 * can `registerSource(poFollowupSource())` without this module importing reports. One row per follow-up; scope by the
 * PO's location under tab `doc.po`.
 */
export function poFollowupSource() {
  const f = (id: string, label: string, type: 'text' | 'number' | 'date' | 'datetime' | 'lookup', expr: ReturnType<typeof sql>, path: string[] = ['Follow-up'], extra: Record<string, unknown> = {}) => ({
    id, label, type, path, expr, groupable: type !== 'datetime', filterable: true, aggregatable: type === 'number', ...extra,
  });
  return {
    key: 'po_followup',
    label: 'PO follow-ups',
    viewKey: 'doc.po:action.view',
    requiresFeature: 'purchase',
    async build(ctx: { tx: Tx; tenantId: string }) {
      return {
        from: sql`app.po_followup pf
          join app.document d on d.id = pf.document_id
          join app.location_node loc on loc.id = d.location_node_id
          left join app.document_line dl on dl.id = pf.line_id
          left join app.master_record ven on ven.id = d.party_id
          left join app.master_record itm on itm.id = dl.item_id
          left join app.tenant_user cu on cu.id = pf.created_by`,
        where: [sql`pf.tenant_id = ${ctx.tenantId}`, sql`not d.is_deleted`],
        scope: { tabKey: 'doc.po', path: sql`loc.path` },
        rowId: sql`pf.id`,
        dateField: 'created_at',
        defaultSort: [{ field: 'created_at', dir: 'desc' as const }],
        link: sql`'/docs/po/' || d.id::text`,
        fields: [
          f('created_at', 'Logged at', 'datetime', sql`pf.created_at`),
          f('contact_mode', 'Contact mode', 'text', sql`pf.contact_mode`, ['Follow-up'], { labels: { call: 'Call', email: 'Email', whatsapp: 'WhatsApp', visit: 'Visit', other: 'Other' } }),
          f('contact_person', 'Contact person', 'text', sql`pf.contact_person`),
          f('promised_date', 'Promised date', 'date', sql`pf.promised_date`),
          f('revised_expected_date', 'Revised expected date', 'date', sql`pf.revised_expected_date`),
          f('reason', 'Reason', 'text', sql`pf.reason`),
          f('notes', 'Notes', 'text', sql`pf.notes`),
          f('logged_by', 'Logged by', 'lookup', sql`cu.name`, ['Follow-up'], { idExpr: sql`cu.id` }),
          f('po_number', 'PO number', 'text', sql`d.number`, ['Purchase order']),
          f('po_date', 'PO date', 'date', sql`d.doc_date`, ['Purchase order']),
          f('po_status', 'PO status', 'text', sql`d.status_key`, ['Purchase order']),
          f('expected_date', 'Current expected date', 'date', sql`nullif(d.custom->>'expected_date', '')::date`, ['Purchase order']),
          f('vendor', 'Vendor', 'lookup', sql`ven.name`, ['Vendor'], { idExpr: sql`ven.id` }),
          f('vendor_code', 'Vendor code', 'text', sql`ven.code`, ['Vendor']),
          f('location', 'Location', 'lookup', sql`loc.name`, ['Location'], { idExpr: sql`loc.id`, locationPath: sql`loc.path` }),
          f('line_no', 'Line no.', 'number', sql`dl.line_no`, ['Line'], { aggregatable: false }),
          f('item', 'Item', 'lookup', sql`itm.name`, ['Line'], { idExpr: sql`itm.id` }),
        ],
      };
    },
  };
}
