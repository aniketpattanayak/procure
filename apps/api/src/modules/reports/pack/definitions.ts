import { DashboardWidget, ReportDefinition } from '@procure/schema';
import type { z } from 'zod';
import type { BuiltinReport } from '../builtins';

/**
 * Standard report pack (system reports): definitions over the generic sources (doc_line:indent, workflow_pending,
 * vendor_quote, purchase_lines, stock_balance, stock_ledger, stock_movement_summary, stock_consumption,
 * stock_reorder). Installed per tenant as kind 'builtin' (read-only, copy to customise); listed only when the
 * tenant has the source's feature and the viewer holds the source's view key (ReportsCatalogue.available).
 */
const def = (d: unknown) => ReportDefinition.parse(d);
const param = (key: string, label: string) => ({ key, label, required: false });
const OPEN_LINE = ['cancelled', 'rejected', 'closed'];
const ORDERED = { field: 'ordered_qty', op: 'gt', value: 0 };

export interface PackReport extends BuiltinReport { group: 'procurement' | 'stock' }

export const PACK_REPORTS: PackReport[] = [
  // ------------------------------------------------------------------ procurement
  {
    group: 'procurement', key: 'builtin_indent_ageing', name: 'Indent status & ageing',
    description: 'Open indent lines with their status, quantities so far and age since submission, bucketed (0–7, 8–15, 16–30, 31–60, over 60 days).',
    definition: def({
      source: { kind: 'doc_line', key: 'indent' },
      columns: [
        { field: 'age_bucket', label: 'Age' }, { field: 'number', label: 'Indent no.' }, { field: 'submitted_at', label: 'Submitted', format: 'date' },
        { field: 'age_days', label: 'Age (days)' }, { field: 'line.status', label: 'Status' }, { field: 'location.name', label: 'Location' },
        { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' },
        { field: 'qty.requested', label: 'Requested' }, { field: 'qty.approved', label: 'Approved' }, { field: 'qty.ordered', label: 'Ordered' },
        { field: 'qty.received', label: 'Received' }, { field: 'qty.pending_order', label: 'Pending order' },
      ],
      filters: [
        { field: 'line.status', op: 'not_in', value: OPEN_LINE },
        { field: 'submitted_at', op: 'not_empty' },
        { field: 'location.name', op: 'within_location', param: param('location', 'Location') },
        { field: 'age_bucket', op: 'eq', param: param('age', 'Age bucket') },
      ],
      groupBy: ['age_bucket'],
      sort: [{ field: 'age_days', dir: 'desc' }, { field: 'number', dir: 'asc' }],
    }),
  },
  {
    group: 'procurement', key: 'builtin_proc_pending_approvals', name: 'Pending procurement approvals by stage & approver',
    description: 'Indents, vendor selections and purchase orders waiting for a decision, per approver and stage, with the oldest wait.',
    definition: def({
      source: { kind: 'engine', key: 'workflow_pending' },
      columns: [
        { field: 'approver.name', label: 'Approver' }, { field: 'doc_type.name', label: 'Document type' }, { field: 'stage', label: 'Stage' },
        { field: 'number', label: 'Documents waiting', aggregate: 'count_distinct' }, { field: 'days_pending', label: 'Oldest (days)', aggregate: 'max' },
      ],
      filters: [
        { field: 'doc_type.module', op: 'in', value: ['indent', 'vendor_quotes', 'purchase'] },
        { field: 'overdue', op: 'eq', param: param('overdue', 'Overdue only') },
      ],
      groupBy: ['approver.name', 'doc_type.name', 'stage'],
      sort: [{ field: 'number', dir: 'desc' }],
      chart: { type: 'stacked_bar', x: 'approver.name', series: ['number'] },
    }),
  },
  {
    group: 'procurement', key: 'builtin_quote_comparison', name: 'Vendor quote comparison history',
    description: 'Every quote version per indent line with its rank among the current quotes and how far it is above the lowest.',
    definition: def({
      source: { kind: 'engine', key: 'vendor_quote' },
      columns: [
        { field: 'indent_number', label: 'Indent no.' }, { field: 'indent_line_no', label: 'Line' }, { field: 'item.code', label: 'Item code' },
        { field: 'item.name', label: 'Item' }, { field: 'vendor.name', label: 'Vendor' }, { field: 'version', label: 'Version' },
        { field: 'is_current', label: 'Current' }, { field: 'quoted_rate', label: 'Quoted rate', format: 'currency' },
        { field: 'lowest_rate', label: 'Lowest rate', format: 'currency' }, { field: 'vs_lowest_pct', label: '% above lowest', format: 'percent' },
        { field: 'rank', label: 'Rank' }, { field: 'lead_time_days', label: 'Lead time (days)' }, { field: 'valid_until', label: 'Valid until' },
        { field: 'logged_at', label: 'Logged at', format: 'datetime' },
      ],
      filters: [
        { field: 'item.name', op: 'eq', param: param('item', 'Item') },
        { field: 'vendor.name', op: 'eq', param: param('vendor', 'Vendor') },
        { field: 'is_current', op: 'eq', param: param('current', 'Current quotes only') },
      ],
      sort: [{ field: 'indent_number', dir: 'desc' }, { field: 'indent_line_no', dir: 'asc' }, { field: 'quoted_rate', dir: 'asc' }, { field: 'version', dir: 'desc' }],
      totals: false,
    }),
  },
  {
    group: 'procurement', key: 'builtin_rate_history', name: 'Rate history by item & vendor',
    description: 'Purchase order rates per item, vendor and month: average, lowest and highest rate and quantity ordered.',
    definition: def({
      source: { kind: 'engine', key: 'purchase_lines' },
      columns: [
        { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' }, { field: 'vendor.name', label: 'Vendor' },
        { field: 'po_date.month', label: 'Month' },
        { field: 'rate', label: 'Average rate', aggregate: 'avg', format: 'currency' }, { field: 'rate', label: 'Lowest rate', aggregate: 'min', format: 'currency' },
        { field: 'rate', label: 'Highest rate', aggregate: 'max', format: 'currency' }, { field: 'qty', label: 'Quantity', aggregate: 'sum' },
        { field: 'po_number', label: 'Orders', aggregate: 'count_distinct' },
      ],
      filters: [
        { field: 'po_status.key', op: 'not_in', value: ['draft', 'cancelled', 'rejected'] },
        { field: 'item.name', op: 'eq', param: param('item', 'Item') },
        { field: 'vendor.name', op: 'eq', param: param('vendor', 'Vendor') },
      ],
      groupBy: ['item.code', 'item.name', 'vendor.name', 'po_date.month'],
      sort: [{ field: 'item.code', dir: 'asc' }, { field: 'vendor.name', dir: 'asc' }, { field: 'po_date.month', dir: 'asc' }],
      chart: { type: 'line', x: 'po_date.month', series: ['rate'] },
      totals: false,
    }),
  },
  {
    group: 'procurement', key: 'builtin_po_pending_delivery', name: 'PO pending delivery',
    description: 'Ordered minus received per purchase order line, with the expected date and an overdue flag.',
    definition: def({
      source: { kind: 'engine', key: 'purchase_lines' },
      columns: [
        { field: 'po_number', label: 'PO no.' }, { field: 'po_date', label: 'PO date' }, { field: 'vendor.name', label: 'Vendor' },
        { field: 'location.name', label: 'Location' }, { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' },
        { field: 'expected_date', label: 'Expected' }, { field: 'ordered_qty', label: 'Ordered' }, { field: 'received_qty', label: 'Received' },
        { field: 'pending_qty', label: 'Pending' }, { field: 'pending_value', label: 'Pending value', format: 'currency' },
        { field: 'overdue', label: 'Overdue' }, { field: 'days_overdue', label: 'Days overdue' },
      ],
      filters: [
        ORDERED, { field: 'pending_qty', op: 'gt', value: 0 },
        { field: 'overdue', op: 'eq', param: param('overdue', 'Overdue only') },
        { field: 'vendor.name', op: 'eq', param: param('vendor', 'Vendor') },
        { field: 'location.name', op: 'within_location', param: param('location', 'Location') },
      ],
      sort: [{ field: 'expected_date', dir: 'asc' }, { field: 'po_number', dir: 'asc' }],
    }),
  },
  {
    group: 'procurement', key: 'builtin_po_vs_grn', name: 'PO vs GRN',
    description: 'Per purchase order line: ordered, received, accepted after QC, rejected, returned to vendor and pending, with the receipts against it.',
    definition: def({
      source: { kind: 'engine', key: 'purchase_lines' },
      columns: [
        { field: 'po_number', label: 'PO no.' }, { field: 'line_no', label: 'Line' }, { field: 'po_date', label: 'PO date' },
        { field: 'vendor.name', label: 'Vendor' }, { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' },
        { field: 'ordered_qty', label: 'Ordered' }, { field: 'received_qty', label: 'Received' }, { field: 'accepted_qty', label: 'Accepted' },
        { field: 'rejected_qty', label: 'Rejected' }, { field: 'returned_qty', label: 'Returned' }, { field: 'pending_qty', label: 'Pending' },
        { field: 'grn_count', label: 'GRNs' }, { field: 'last_receipt_date', label: 'Last receipt' },
      ],
      filters: [ORDERED, { field: 'vendor.name', op: 'eq', param: param('vendor', 'Vendor') }],
      sort: [{ field: 'po_date', dir: 'desc' }, { field: 'po_number', dir: 'desc' }, { field: 'line_no', dir: 'asc' }],
    }),
  },
  {
    group: 'procurement', key: 'builtin_vendor_performance', name: 'Vendor performance',
    description: 'Per vendor: orders, quantities, on-time delivery % (lines received by the expected date), rejection % (of quantity received) and average lead time.',
    definition: def({
      source: { kind: 'engine', key: 'purchase_lines' },
      columns: [
        { field: 'vendor.name', label: 'Vendor' }, { field: 'po_number', label: 'Orders', aggregate: 'count_distinct' },
        { field: 'line_no', label: 'Lines', aggregate: 'count' },
        { field: 'ordered_qty', label: 'Ordered', aggregate: 'sum' }, { field: 'received_qty', label: 'Received', aggregate: 'sum' },
        { field: 'rejected_qty', label: 'Rejected', aggregate: 'sum' },
        { field: 'on_time_pct', label: 'On-time %', aggregate: 'avg', format: 'percent' },
        { field: 'rejection_pct', label: 'Rejection %', aggregate: 'avg', format: 'percent' },
        { field: 'lead_time_days', label: 'Avg lead time (days)', aggregate: 'avg' },
      ],
      filters: [ORDERED, { field: 'location.name', op: 'within_location', param: param('location', 'Location') }],
      groupBy: ['vendor.name'],
      sort: [{ field: 'vendor.name', dir: 'asc' }],
      chart: { type: 'bar', x: 'vendor.name', series: ['on_time_pct', 'rejection_pct'] },
    }),
  },
  {
    group: 'procurement', key: 'builtin_purchase_value', name: 'Purchase value by vendor, item, location & month',
    description: 'Value ordered and received on approved purchase orders, by month, vendor, location and item (this financial year by default).',
    definition: def({
      source: { kind: 'engine', key: 'purchase_lines' },
      columns: [
        { field: 'po_date.month', label: 'Month' }, { field: 'vendor.name', label: 'Vendor' }, { field: 'location.name', label: 'Location' },
        { field: 'item.name', label: 'Item' },
        { field: 'ordered_value', label: 'Ordered value', aggregate: 'sum', format: 'currency' },
        { field: 'received_value', label: 'Received value', aggregate: 'sum', format: 'currency' },
        { field: 'ordered_qty', label: 'Ordered qty', aggregate: 'sum' },
      ],
      filters: [ORDERED, { field: 'vendor.name', op: 'eq', param: param('vendor', 'Vendor') }, { field: 'location.name', op: 'within_location', param: param('location', 'Location') }],
      groupBy: ['po_date.month', 'vendor.name', 'location.name', 'item.name'],
      sort: [{ field: 'po_date.month', dir: 'asc' }, { field: 'vendor.name', dir: 'asc' }],
      chart: { type: 'stacked_bar', x: 'po_date.month', series: ['ordered_value'] },
      datePreset: 'this_fy',
    }),
  },
  // ------------------------------------------------------------------ stock
  {
    group: 'stock', key: 'builtin_stock_summary', name: 'Stock summary by location',
    description: 'Quantity and value on hand per location, item and stock status.',
    definition: def({
      source: { kind: 'engine', key: 'stock_balance' },
      columns: [
        { field: 'location.name', label: 'Location' }, { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' },
        { field: 'status', label: 'Status' },
        { field: 'value', label: 'Value', aggregate: 'sum', format: 'currency' }, { field: 'qty', label: 'Quantity', aggregate: 'sum' },
      ],
      filters: [{ field: 'location.name', op: 'within_location', param: param('location', 'Location') }, { field: 'item.name', op: 'eq', param: param('item', 'Item') }],
      groupBy: ['location.name', 'item.code', 'item.name', 'status'],
      sort: [{ field: 'location.name', dir: 'asc' }, { field: 'item.code', dir: 'asc' }],
    }),
  },
  {
    group: 'stock', key: 'builtin_stock_ledger', name: 'Stock ledger',
    description: 'Every stock movement of an item (this month by default): document, movement type, quantities in and out and value.',
    definition: def({
      source: { kind: 'engine', key: 'stock_ledger' },
      columns: [
        { field: 'at', label: 'Date', format: 'datetime' }, { field: 'document.type', label: 'Document type' }, { field: 'document.number', label: 'Document no.' },
        { field: 'movement_type', label: 'Movement' }, { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' },
        { field: 'location.name', label: 'Location' }, { field: 'batch_no', label: 'Batch' }, { field: 'status', label: 'Status' },
        { field: 'qty_in', label: 'In' }, { field: 'qty_out', label: 'Out' }, { field: 'value', label: 'Value', format: 'currency' },
      ],
      filters: [
        { field: 'item.name', op: 'eq', param: param('item', 'Item') },
        { field: 'location.name', op: 'within_location', param: param('location', 'Location') },
        { field: 'movement_type', op: 'eq', param: param('movement', 'Movement type') },
      ],
      sort: [{ field: 'at', dir: 'desc' }],
      datePreset: 'this_month',
    }),
  },
  {
    group: 'stock', key: 'builtin_item_movement_summary', name: 'Item movement summary',
    description: 'Opening, in, out and closing quantity (and value) per item, location and status for a period (this month by default; any from–to range).',
    definition: def({
      source: { kind: 'engine', key: 'stock_movement_summary' },
      columns: [
        { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' }, { field: 'location.name', label: 'Location' }, { field: 'status', label: 'Status' },
        { field: 'opening_qty', label: 'Opening', aggregate: 'sum' }, { field: 'in_qty', label: 'In', aggregate: 'sum' },
        { field: 'out_qty', label: 'Out', aggregate: 'sum' }, { field: 'closing_qty', label: 'Closing', aggregate: 'sum' },
        { field: 'opening_value', label: 'Opening value', aggregate: 'sum', format: 'currency' },
        { field: 'closing_value', label: 'Closing value', aggregate: 'sum', format: 'currency' },
      ],
      filters: [{ field: 'item.name', op: 'eq', param: param('item', 'Item') }, { field: 'location.name', op: 'within_location', param: param('location', 'Location') }],
      groupBy: ['item.code', 'item.name', 'location.name', 'status'],
      sort: [{ field: 'item.code', dir: 'asc' }, { field: 'location.name', dir: 'asc' }],
      datePreset: 'this_month',
    }),
  },
  {
    group: 'stock', key: 'builtin_consumption', name: 'Consumption by department & location',
    description: 'Store issues net of returns per department, location and item (this financial year by default).',
    definition: def({
      source: { kind: 'engine', key: 'stock_consumption' },
      columns: [
        { field: 'department.name', label: 'Department' }, { field: 'location.name', label: 'Location' }, { field: 'item.code', label: 'Item code' },
        { field: 'item.name', label: 'Item' },
        { field: 'issued_qty', label: 'Issued', aggregate: 'sum' }, { field: 'returned_qty', label: 'Returned', aggregate: 'sum' },
        { field: 'consumed_qty', label: 'Consumed (net)', aggregate: 'sum' },
        { field: 'consumed_value', label: 'Consumed value', aggregate: 'sum', format: 'currency' },
      ],
      filters: [{ field: 'location.name', op: 'within_location', param: param('location', 'Location') }, { field: 'item.name', op: 'eq', param: param('item', 'Item') }],
      groupBy: ['department.name', 'location.name', 'item.code', 'item.name'],
      sort: [{ field: 'department.name', dir: 'asc' }, { field: 'location.name', dir: 'asc' }],
      chart: { type: 'bar', x: 'department.name', series: ['consumed_qty'] },
      datePreset: 'this_fy',
    }),
  },
  {
    group: 'stock', key: 'builtin_reorder', name: 'Re-order / below-minimum',
    description: 'Re-order rules with the available stock of the location (and its bins), the shortfall below minimum and the suggested order quantity.',
    definition: def({
      source: { kind: 'engine', key: 'stock_reorder' },
      columns: [
        { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' }, { field: 'location.name', label: 'Location' },
        { field: 'available_qty', label: 'Available' }, { field: 'min_qty', label: 'Minimum' }, { field: 'reorder_qty', label: 'Re-order qty' },
        { field: 'max_qty', label: 'Maximum' }, { field: 'shortfall_qty', label: 'Shortfall' }, { field: 'suggested_qty', label: 'Suggested order' },
        { field: 'below_min', label: 'Below minimum' }, { field: 'auto_indent', label: 'Auto indent' },
      ],
      filters: [{ field: 'below_min', op: 'eq', param: param('below_min', 'Below minimum only') }, { field: 'location.name', op: 'within_location', param: param('location', 'Location') }],
      sort: [{ field: 'shortfall_qty', dir: 'desc' }, { field: 'item.code', dir: 'asc' }],
      totals: false,
    }),
  },
  {
    group: 'stock', key: 'builtin_expiring_batches', name: 'Expiring batches',
    description: 'Batches in stock expiring within 90 days (change "Within days"), including already expired ones.',
    definition: def({
      source: { kind: 'engine', key: 'stock_balance' },
      columns: [
        { field: 'expiry_date', label: 'Expiry' }, { field: 'days_to_expiry', label: 'Days left' }, { field: 'expiry_bucket', label: 'Expiry window' },
        { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' }, { field: 'batch_no', label: 'Batch' },
        { field: 'location.name', label: 'Location' }, { field: 'status', label: 'Status' },
        { field: 'qty', label: 'Quantity' }, { field: 'value', label: 'Value', format: 'currency' },
      ],
      filters: [
        { field: 'expiry_date', op: 'not_empty' },
        { field: 'days_to_expiry', op: 'lte', value: 90, param: param('within_days', 'Within days') },
        { field: 'location.name', op: 'within_location', param: param('location', 'Location') },
      ],
      sort: [{ field: 'expiry_date', dir: 'asc' }, { field: 'item.code', dir: 'asc' }],
    }),
  },
  {
    group: 'stock', key: 'builtin_quarantine_rejected', name: 'Quarantine & rejected stock',
    description: 'Stock blocked in quarantine or rejected, per item, batch and location.',
    definition: def({
      source: { kind: 'engine', key: 'stock_balance' },
      columns: [
        { field: 'status', label: 'Status' }, { field: 'item.code', label: 'Item code' }, { field: 'item.name', label: 'Item' },
        { field: 'batch_no', label: 'Batch' }, { field: 'location.name', label: 'Location' }, { field: 'qty', label: 'Quantity' },
        { field: 'value', label: 'Value', format: 'currency' }, { field: 'updated_at', label: 'Since', format: 'datetime' },
      ],
      filters: [{ field: 'status', op: 'not_in', value: ['available'] }, { field: 'location.name', op: 'within_location', param: param('location', 'Location') }],
      groupBy: ['status'],
      sort: [{ field: 'item.code', dir: 'asc' }],
    }),
  },
];

// ------------------------------------------------------------------ dashboards

type Widget = Omit<z.input<typeof DashboardWidget>, 'reportId'> & { reportKey?: string };
export interface PackDashboard {
  key: string; name: string;
  /** Shown (and default for non-admin viewers / roles) when the viewer holds any of these keys … */
  requires: string[];
  /** … and the tenant has any of these plan features. */
  features: string[];
  widgets: Widget[];
}

export const PACK_DASHBOARDS: PackDashboard[] = [
  {
    key: 'procurement_overview', name: 'Procurement overview',
    requires: ['doc.indent:action.view', 'doc.po:action.view'], features: ['indent', 'purchase'],
    widgets: [
      { id: 'po_value', type: 'kpi', title: 'Ordered this month', reportKey: 'builtin_purchase_value', params: { datePreset: 'this_month' }, x: 0, y: 0, w: 3, h: 2 },
      { id: 'inbox', type: 'inbox_counts', title: 'Waiting for my approval', x: 3, y: 0, w: 3, h: 2 },
      { id: 'indents', type: 'doc_counts', title: 'Indents', docTypeKey: 'indent', x: 6, y: 0, w: 3, h: 2 },
      { id: 'pos', type: 'doc_counts', title: 'Purchase orders', docTypeKey: 'po', x: 9, y: 0, w: 3, h: 2 },
      { id: 'value_chart', type: 'chart', title: 'Purchase value by month', reportKey: 'builtin_purchase_value', x: 0, y: 2, w: 8, h: 4 },
      { id: 'vendor_perf', type: 'chart', title: 'Vendor on-time & rejection %', reportKey: 'builtin_vendor_performance', x: 8, y: 2, w: 4, h: 4 },
      { id: 'pending_delivery', type: 'table', title: 'PO pending delivery', reportKey: 'builtin_po_pending_delivery', params: { limit: 10 }, x: 0, y: 6, w: 6, h: 4 },
      { id: 'indent_ageing', type: 'table', title: 'Oldest open indents', reportKey: 'builtin_indent_ageing', params: { limit: 10 }, x: 6, y: 6, w: 6, h: 4 },
    ],
  },
  {
    key: 'store_overview', name: 'Store overview',
    requires: ['stock:action.view'], features: ['store'],
    widgets: [
      { id: 'stock_value', type: 'kpi', title: 'Stock on hand', reportKey: 'builtin_stock_summary', x: 0, y: 0, w: 3, h: 2 },
      { id: 'grns', type: 'doc_counts', title: 'Goods receipts', docTypeKey: 'grn', x: 3, y: 0, w: 3, h: 2 },
      { id: 'issues', type: 'doc_counts', title: 'Store issues', docTypeKey: 'store_issue', x: 6, y: 0, w: 3, h: 2 },
      { id: 'inbox', type: 'inbox_counts', title: 'Waiting for my approval', x: 9, y: 0, w: 3, h: 2 },
      { id: 'below_min', type: 'table', title: 'Below minimum', reportKey: 'builtin_reorder', params: { below_min: true, limit: 10 }, x: 0, y: 2, w: 6, h: 4 },
      { id: 'consumption', type: 'chart', title: 'Consumption by department', reportKey: 'builtin_consumption', x: 6, y: 2, w: 6, h: 4 },
      { id: 'expiring', type: 'table', title: 'Expiring batches', reportKey: 'builtin_expiring_batches', params: { limit: 10 }, x: 0, y: 6, w: 6, h: 4 },
      { id: 'quarantine', type: 'table', title: 'Quarantine & rejected', reportKey: 'builtin_quarantine_rejected', params: { limit: 10 }, x: 6, y: 6, w: 6, h: 4 },
    ],
  },
];
