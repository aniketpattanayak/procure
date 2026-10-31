import type { SystemTypeSpec } from '../../procurement';
import { GRN_FEATURE } from '../common';

export const GRN = 'grn';
export const RTV = 'rtv';

/** Line keys of the GRN line form the module reads / maintains. */
export const GRN_LINE = {
  poLine: 'po_line', accepted: 'accepted_qty', rejected: 'rejected_qty', rejectReason: 'reject_reason', batchNo: 'batch_no',
  mfgDate: 'mfg_date', expiryDate: 'expiry_date', requiresQc: 'requires_qc',
} as const;
/** Header keys of the GRN header form the module reads / maintains. */
export const GRN_HEADER = { po: 'po' } as const;
export const RTV_LINE = { grnLine: 'grn_line', batchNo: 'batch_no', fromStatus: 'from_status', reason: 'reason' } as const;
/** Reserved `document.custom` key: the workflow action that created a draft RTV (return_to_vendor idempotency). */
export const RTV_SOURCE_ACTION = '__source_action';

const text = (key: string, label: string, width = 3, extra: Record<string, unknown> = {}) => ({ key, type: 'text', label, maxLength: 100, width, ...extra });
const hiddenRef = (key: string, label: string) => ({ key, type: 'text', label, hidden: true, readOnly: true, maxLength: 36 });

/** Quality stage runs when any line's item (or a master linked from the item, e.g. its category) has `requires_qc`. */
export const QC_CONDITION = 'COUNTIF(lines.requires_qc = TRUE) > 0';

/**
 * Goods receipt note: receipts against approved PO lines, verified line by line through the tenant's chain. The
 * default chain (tenant-editable) is gate → store (posts stock) → quality (when requires_qc; reject blocks the stock
 * and routes to disposition) → disposition (approve keeps it blocked for rework, reject returns it to the vendor).
 */
export const GRN_SPEC: SystemTypeSpec = {
  moduleKey: GRN_FEATURE,
  tabSetting: null,
  create: {
    key: GRN, name: 'Goods Receipt', pluralName: 'Goods Receipts', description: 'Material received against purchase orders', hasLines: true, itemLines: true,
    numberPattern: 'GRN/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'GRN No.', icon: 'package-check', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'party', 'location', 'status', 'invoice_no'],
      itemColumns: ['number', 'line_no', 'item', 'qty', 'accepted_qty', 'rejected_qty', 'status', 'pending_approval'],
    },
    headerDefinition: {
      fields: [
        { key: 'party', type: 'lookup', label: 'Vendor', system: true, required: true, width: 6, source: { kind: 'master', masterKey: 'vendor' }, display: ['code', 'name'] },
        hiddenRef(GRN_HEADER.po, 'Purchase order'),
        text('invoice_no', 'Invoice no.'),
        { key: 'invoice_date', type: 'date', label: 'Invoice date', width: 3 },
        { key: 'invoice_amount', type: 'currency', label: 'Invoice amount', min: 0, width: 3 },
        text('challan_no', 'Challan no.'),
        text('vehicle_no', 'Vehicle no.'),
        text('gate_entry_no', 'Gate entry no.'),
        { key: 'photos', type: 'files', label: 'Photos', maxFiles: 20 },
        { key: 'total_amount', type: 'formula', label: 'Value received', system: true, width: 3, expr: 'SUM(lines.amount)', resultType: 'number', precision: 2 },
      ],
    },
    lineDefinition: {
      fields: [
        { key: 'item', type: 'lookup', label: 'Item', system: true, required: true, width: 4, source: { kind: 'master', masterKey: 'item' }, display: ['code', 'name'], autofill: [{ from: 'uom', to: 'uom', overwrite: 'if_empty' }] },
        { key: 'location', type: 'lookup', label: 'Receiving location', system: true, width: 3, source: { kind: 'location', activeOnly: true, withinScope: true }, display: ['code', 'name'] },
        { key: 'qty', type: 'decimal', label: 'Received qty', system: true, required: true, precision: 3, min: 0, width: 2 },
        { key: GRN_LINE.accepted, type: 'decimal', label: 'Accepted qty', precision: 3, min: 0, width: 2, readOnly: true },
        { key: GRN_LINE.rejected, type: 'decimal', label: 'Rejected qty', precision: 3, min: 0, width: 2, readOnly: true },
        text(GRN_LINE.rejectReason, 'Reject reason', 4, { maxLength: 500 }),
        text(GRN_LINE.batchNo, 'Batch no.', 2, { maxLength: 60 }),
        { key: GRN_LINE.mfgDate, type: 'date', label: 'Mfg. date', width: 2 },
        { key: GRN_LINE.expiryDate, type: 'date', label: 'Expiry date', width: 2 },
        { key: 'rate', type: 'currency', label: 'PO rate', system: true, min: 0, width: 2, readOnly: true },
        { key: 'amount', type: 'formula', label: 'Amount', system: true, width: 2, expr: 'qty * rate', resultType: 'number', precision: 2 },
        { key: 'photos', type: 'files', label: 'Photos', maxFiles: 10 },
        hiddenRef(GRN_LINE.poLine, 'PO line'),
        { key: GRN_LINE.requiresQc, type: 'checkbox', label: 'Needs quality check', hidden: true, readOnly: true },
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [],
  workflow: {
    granularity: 'line',
    stages: [
      { key: 'gate', name: 'Gate entry check', actions: ['approve', 'partial', 'reject', 'hold', 'send_back'] },
      { key: 'store', name: 'Store verification', actions: ['approve', 'partial', 'reject', 'hold', 'send_back'], effects: { onApprove: [{ effect: 'post_stock', stockStatus: 'available' }] } },
      {
        // HOD reviews after store verification — rejection puts entire GRN on hold; stock remains posted but blocked
        key: 'hod_approval', name: 'HOD Approval', actions: ['approve', 'reject'],
        effects: { onReject: [{ effect: 'block_stock' }, { effect: 'set_status', status: 'on_hold' }] },
      },
      {
        // Second sequential approver after HOD — role to be assigned by tenant admin
        key: 'approver2', name: 'Approver 2', actions: ['approve', 'reject'],
        effects: { onReject: [{ effect: 'block_stock' }, { effect: 'set_status', status: 'on_hold' }] },
      },
      {
        // Third sequential approver — role to be assigned by tenant admin
        key: 'approver3', name: 'Approver 3', actions: ['approve', 'reject'],
        effects: { onReject: [{ effect: 'block_stock' }, { effect: 'set_status', status: 'on_hold' }] },
      },
      {
        key: 'quality', name: 'Quality check', when: QC_CONDITION, actions: ['approve', 'partial', 'reject', 'hold'],
        effects: { onReject: [{ effect: 'block_stock' }, { effect: 'route_to', stage: 'disposition' }] },
      },
      {
        // Receives only quantity routed by the quality stage (the condition keeps normal flow out of it).
        key: 'disposition', name: 'Store disposition', statusLabel: 'Waiting for disposition', when: 'FALSE', actions: ['approve', 'partial', 'reject'],
        effects: { onReject: [{ effect: 'return_to_vendor' }] },
      },
    ],
  },
  workflowNote: 'Default GRN verification chain',
};

/** Return to vendor (debit note): lines reference GRN lines; approval moves the stock out and re-opens the PO. */
export const RTV_SPEC: SystemTypeSpec = {
  moduleKey: GRN_FEATURE,
  tabSetting: null,
  create: {
    key: RTV, name: 'Return to Vendor', pluralName: 'Returns to Vendor', description: 'Material returned to vendors (debit notes)', hasLines: true, itemLines: true,
    numberPattern: 'RTV/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'RTV No.', icon: 'undo-2', allowLineCancel: true,
      documentColumns: ['number', 'doc_date', 'party', 'location', 'status', 'total_amount'],
      itemColumns: ['number', 'line_no', 'item', 'qty', 'rate', 'status', 'pending_approval'],
    },
    headerDefinition: {
      fields: [
        { key: 'party', type: 'lookup', label: 'Vendor', system: true, required: true, width: 6, source: { kind: 'master', masterKey: 'vendor' }, display: ['code', 'name'] },
        hiddenRef('grn', 'GRN'),
        { key: 'reason', type: 'textarea', label: 'Reason', rows: 2, maxLength: 1000 },
        { key: 'total_amount', type: 'formula', label: 'Debit amount', system: true, width: 3, expr: 'SUM(lines.amount)', resultType: 'number', precision: 2 },
      ],
    },
    lineDefinition: {
      fields: [
        { key: 'location', type: 'lookup', label: 'From location', system: true, width: 3, source: { kind: 'location', activeOnly: true, withinScope: true }, display: ['code', 'name'] },
        { key: 'rate', type: 'currency', label: 'Rate', system: true, min: 0, width: 2 },
        { key: 'amount', type: 'formula', label: 'Amount', system: true, width: 2, expr: 'qty * rate', resultType: 'number', precision: 2 },
        text(RTV_LINE.batchNo, 'Batch no.', 2, { maxLength: 60 }),
        {
          key: RTV_LINE.fromStatus, type: 'select', label: 'Return from', width: 2, default: 'quarantine',
          options: [{ value: 'available', label: 'Available' }, { value: 'quarantine', label: 'Quarantine' }, { value: 'rejected', label: 'Rejected' }],
        },
        text(RTV_LINE.reason, 'Reason', 4, { maxLength: 500 }),
        hiddenRef(RTV_LINE.grnLine, 'GRN line'),
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [],
  workflow: {
    granularity: 'line',
    stages: [{ key: 'approve', name: 'Return approval', actions: ['approve', 'partial', 'reject', 'hold', 'send_back'], effects: { onApprove: [{ effect: 'post_stock', stockStatus: 'available' }] } }],
  },
  workflowNote: 'Default return-to-vendor workflow',
};
