import type { SystemTypeSpec } from '../installer/system-type';

export const PO = 'po';
export const PURCHASE_FEATURE = 'purchase';
export const PO_SETTING_DIRECT = 'flow.po.direct_allowed';
export const AMENDING = 'amending';

/** Reserved keys in `document.custom` (never form fields; kept by the documents pipeline across saves). */
export const RESERVED = {
  /** T&C snapshot taken on approval: [{ code, name, body }] (read by the Templates PDF context as values.terms_snapshot). */
  terms: 'terms_snapshot',
  /** Open amendment bookkeeping (see revisions/). */
  amend: '__amendment',
  /** Expected date revised by a follow-up (wins over the schedule). */
  revisedExpected: '__revised_expected_date',
} as const;
/** Line custom keys owned by the PO module. */
export const LINE_RESERVED = { revisedExpected: '__revised_expected_date' } as const;

/** Header fields maintained by the GST engine on every save (read-only on the form). */
export const TOTAL_FIELDS = {
  taxable: 'taxable_amount', cgst: 'cgst_amount', sgst: 'sgst_amount', igst: 'igst_amount', cess: 'cess_amount', tax: 'tax_amount', grand: 'grand_total',
} as const;

const money = (key: string, label: string, extra: Record<string, unknown> = {}) => ({ key, type: 'currency', label, min: 0, width: 3, ...extra });
const ro = (key: string, label: string) => money(key, label, { readOnly: true, min: undefined });

/** Purchase order: system type of module `purchase` (contract "Provisioning"). */
export const PO_SPEC: SystemTypeSpec = {
  moduleKey: PURCHASE_FEATURE,
  tabSetting: null,
  create: {
    key: PO, name: 'Purchase Order', pluralName: 'Purchase Orders', description: 'Orders placed on vendors', hasLines: true, itemLines: true,
    numberPattern: 'PO/{FYS}/{SEQ:5}',
    settings: {
      numberLabel: 'PO No.', icon: 'shopping-cart', allowLineCancel: true, editableStatuses: ['draft', AMENDING],
      documentColumns: ['number', 'doc_date', 'party', 'location', 'status', 'grand_total'],
      itemColumns: ['number', 'line_no', 'item', 'qty', 'rate', 'status', 'pending_approval', 'expected_date'],
    },
    headerDefinition: {
      fields: [
        {
          key: 'party', type: 'lookup', label: 'Vendor', system: true, required: true, width: 6, source: { kind: 'master', masterKey: 'vendor' },
          display: ['code', 'name'], autofill: [{ from: 'payment_terms', to: 'payment_terms', overwrite: 'if_empty' }],
        },
        { key: 'currency', type: 'text', label: 'Currency', maxLength: 3, width: 2, help: 'Defaults to the vendor currency, else the company currency' },
        { key: 'payment_terms', type: 'lookup', label: 'Payment terms', width: 4, source: { kind: 'master', masterKey: 'payment_terms' }, display: ['code', 'name'] },
        { key: 'terms', type: 'multilookup', label: 'Terms & conditions', width: 12, source: { kind: 'master', masterKey: 'terms' }, display: ['code', 'name'] },
        { key: 'expected_date', type: 'date', label: 'Expected delivery', width: 3, readOnly: true, help: 'Earliest open schedule date, unless a follow-up revised it' },
        money('freight', 'Freight'),
        money('other_charges', 'Other charges'),
        money('discount_amount', 'Discount (before tax)'),
        { key: 'total_amount', type: 'formula', label: 'Net amount', system: true, width: 3, expr: 'SUM(lines.amount)', resultType: 'number', precision: 2 },
        ro('taxable_amount', 'Taxable value'),
        ro('cgst_amount', 'CGST'),
        ro('sgst_amount', 'SGST'),
        ro('igst_amount', 'IGST'),
        ro('cess_amount', 'Cess'),
        ro('tax_amount', 'Total tax'),
        ro('grand_total', 'Grand total'),
      ],
    },
    lineDefinition: {
      fields: [
        {
          key: 'item', type: 'lookup', label: 'Item', system: true, required: true, width: 4, source: { kind: 'master', masterKey: 'item' }, display: ['code', 'name'],
          autofill: [{ from: 'uom', to: 'uom', overwrite: 'if_empty' }, { from: 'tax_code', to: 'tax_code', overwrite: 'if_empty' }],
        },
        { key: 'rate', type: 'currency', label: 'Rate', system: true, required: true, min: 0, width: 2 },
        { key: 'discount_pct', type: 'percentage', label: 'Discount %', min: 0, max: 100, width: 2 },
        { key: 'tax_code', type: 'lookup', label: 'Tax code', width: 2, source: { kind: 'master', masterKey: 'tax_code' }, display: ['code'] },
        { key: 'amount', type: 'formula', label: 'Amount', system: true, width: 2, expr: 'qty * rate * (1 - discount_pct / 100)', resultType: 'number', precision: 2 },
        { key: 'required_date', type: 'date', label: 'Required date', system: true, hidden: true },
        { key: 'expected_date', type: 'date', label: 'Expected date', width: 2, readOnly: true },
        { key: 'source_line', type: 'text', label: 'Source line', hidden: true, readOnly: true, maxLength: 36 },
      ],
    },
  } as SystemTypeSpec['create'],
  extraKeys: [
    { name: 'followup', label: 'Log vendor follow-ups', requiresFeature: PURCHASE_FEATURE },
    { name: 'amend', label: 'Amend approved orders', requiresFeature: PURCHASE_FEATURE },
    { name: 'short_close', label: 'Short-close remaining quantity', requiresFeature: PURCHASE_FEATURE },
    { name: 'create_direct', label: 'Create orders without an indent', requiresFeature: PURCHASE_FEATURE, requiresSetting: PO_SETTING_DIRECT },
  ],
  workflow: {
    granularity: 'line',
    stages: [{ key: 'approve', name: 'PO approval', actions: ['approve', 'partial', 'reject', 'hold', 'send_back'] }],
  },
  workflowNote: 'Default purchase order workflow',
};
