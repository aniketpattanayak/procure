import type { SystemTypeSpec } from '../../procurement';
import { STOCK_FEATURE } from '../ledger/types';

/** Store document types (contract "Store documents"); all module feature `store`. */
export const STOCK_TRANSFER = 'stock_transfer';
export const STOCK_ADJUSTMENT = 'stock_adjustment';
export const STOCK_COUNT = 'stock_count';

const location = (label: string, extra: Record<string, unknown> = {}) => ({
  key: 'location', type: 'lookup', label, system: true, width: 4, source: { kind: 'location', activeOnly: true, withinScope: true }, display: ['code', 'name'], ...extra,
});
const hiddenMoney = [
  { key: 'rate', type: 'currency', label: 'Rate', system: true, hidden: true, min: 0 },
  { key: 'amount', type: 'formula', label: 'Amount', system: true, hidden: true, expr: 'qty * rate', resultType: 'number', precision: 2 },
];
const hiddenTotal = { key: 'total_amount', type: 'formula', label: 'Total amount', system: true, hidden: true, expr: 'SUM(lines.amount)', resultType: 'number', precision: 2 };
const batch = { key: 'batch', type: 'text', label: 'Batch', maxLength: 60, width: 2 };
const approveStage = (name: string) => ({
  key: 'approve', name, actions: ['approve', 'reject', 'hold', 'send_back'] as ('approve' | 'reject' | 'hold' | 'send_back')[],
  effects: { onApprove: [{ effect: 'post_stock' as const }] },
});

/** Transfer between two nodes: header `location` = from, `to_location`; approval posts paired transfer_out/in. */
export const TRANSFER_SPEC: SystemTypeSpec = {
  moduleKey: STOCK_FEATURE,
  tabSetting: null,
  create: {
    key: STOCK_TRANSFER, name: 'Stock Transfer', pluralName: 'Stock Transfers', description: 'Move stock between stores, bins and sites', hasLines: true, itemLines: true,
    numberPattern: 'STR/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'Transfer No.', icon: 'arrow-left-right', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'location', 'to_location', 'status'],
      itemColumns: ['number', 'line_no', 'item', 'batch', 'qty', 'status', 'pending_approval'],
    },
    headerDefinition: {
      fields: [
        location('From location', { required: true }),
        { key: 'to_location', type: 'lookup', label: 'To location', required: true, width: 4, source: { kind: 'location', activeOnly: true }, display: ['code', 'name'] },
        hiddenTotal,
        { key: 'remarks', type: 'textarea', label: 'Remarks', rows: 2, maxLength: 2000 },
      ],
    },
    lineDefinition: { fields: [...hiddenMoney, batch, { key: 'remarks', type: 'text', label: 'Remarks', maxLength: 500, width: 4 }] },
  } as SystemTypeSpec['create'],
  extraKeys: [],
  workflow: { granularity: 'line', stages: [approveStage('Transfer approval')] },
  workflowNote: 'Default stock transfer workflow',
};

/** Adjustment in/out per line (node, batch, direction, qty, rate for ins, reason); approval posts it. */
export const ADJUSTMENT_SPEC: SystemTypeSpec = {
  moduleKey: STOCK_FEATURE,
  tabSetting: null,
  create: {
    key: STOCK_ADJUSTMENT, name: 'Stock Adjustment', pluralName: 'Stock Adjustments', description: 'Write stock on or off with a reason', hasLines: true, itemLines: true,
    numberPattern: 'SADJ/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'Adjustment No.', icon: 'sliders-horizontal', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'location', 'status', 'total_amount'],
      itemColumns: ['number', 'line_no', 'item', 'direction', 'qty', 'rate', 'status', 'pending_approval'],
    },
    headerDefinition: {
      fields: [
        hiddenTotal,
        { key: 'remarks', type: 'textarea', label: 'Remarks', rows: 2, maxLength: 2000 },
      ],
    },
    lineDefinition: {
      fields: [
        location('Location', { help: 'Defaults to the document location' }),
        batch,
        { key: 'direction', type: 'select', label: 'Direction', required: true, width: 2, default: 'in', options: [{ value: 'in', label: 'In (+)' }, { value: 'out', label: 'Out (−)' }] },
        { key: 'rate', type: 'currency', label: 'Rate (for ins)', system: true, min: 0, width: 2, help: 'Empty = current average cost' },
        { key: 'amount', type: 'formula', label: 'Amount', system: true, hidden: true, expr: 'qty * rate', resultType: 'number', precision: 2 },
        { key: 'reason', type: 'text', label: 'Reason', required: true, maxLength: 500, width: 4 },
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [],
  workflow: { granularity: 'line', stages: [approveStage('Adjustment approval')] },
  workflowNote: 'Default stock adjustment workflow',
};

/** Physical count: lines from POST /stock/counts/snapshot (book qty frozen); approval posts the differences. */
export const COUNT_SPEC: SystemTypeSpec = {
  moduleKey: STOCK_FEATURE,
  tabSetting: null,
  create: {
    key: STOCK_COUNT, name: 'Stock Count', pluralName: 'Stock Counts', description: 'Physical stock verification', hasLines: true, itemLines: true,
    numberPattern: 'SCNT/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'Count No.', icon: 'clipboard-check', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'location', 'status'],
      itemColumns: ['number', 'line_no', 'item', 'batch', 'book_qty', 'counted_qty', 'difference', 'status'],
    },
    headerDefinition: { fields: [hiddenTotal, { key: 'remarks', type: 'textarea', label: 'Remarks', rows: 2, maxLength: 2000 }] },
    lineDefinition: {
      fields: [
        location('Location'),
        batch,
        { key: 'qty', type: 'decimal', label: 'Count line', system: true, required: true, hidden: true, precision: 3, min: 0, default: 1 },
        ...hiddenMoney,
        { key: 'book_qty', type: 'decimal', label: 'Book qty', readOnly: true, precision: 4, width: 2 },
        { key: 'counted_qty', type: 'decimal', label: 'Counted qty', precision: 4, min: 0, width: 2 },
        { key: 'difference', type: 'formula', label: 'Difference', expr: 'IF(counted_qty = NULL, NULL, counted_qty - book_qty)', resultType: 'number', precision: 4, width: 2 },
        { key: 'remarks', type: 'text', label: 'Remarks', maxLength: 500, width: 4 },
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [],
  workflow: { granularity: 'line', stages: [approveStage('Count approval')] },
  workflowNote: 'Default stock count workflow',
};

export const STORE_SPECS = [TRANSFER_SPEC, ADJUSTMENT_SPEC, COUNT_SPEC];
