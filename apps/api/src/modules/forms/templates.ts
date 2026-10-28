import type { MasterSettings } from '@procure/schema';

/**
 * Template content (global templates, contract "Tenant provisioning"). The system forms/masters below are
 * engine-required and installed for every tenant; bundles (e.g. `standard`, stored as a `platform.global_template`
 * row of kind `bundle`) add starter roles, sample records and settings. Everything is data: the installer only
 * interprets this shape. Copies are independent of the template.
 */
export interface TemplateMaster {
  key: string;
  name: string;
  pluralName: string;
  description?: string;
  settings?: Partial<MasterSettings>;
  /** Field definitions (FormDefinition input; defaults are applied by the schema). */
  definition: unknown;
  records?: { code: string; name: string; data?: Record<string, unknown> }[];
}

export interface TemplateBundle {
  /** Masters to create (skipped when the key exists) and/or sample records to add to existing masters. */
  masters?: TemplateMaster[];
  records?: { master: string; rows: { code: string; name: string; data?: Record<string, unknown> }[] }[];
  /** Starter roles; grants are registry keys (unknown keys are skipped). */
  roles?: { key: string; name: string; description?: string; grants: string[] }[];
  /** Tenant settings to set when absent. */
  settings?: Record<string, unknown>;
}

const sys = { system: true };

/** Order matters: lookup targets first. */
export const SYSTEM_MASTERS: TemplateMaster[] = [
  {
    key: 'uom', name: 'Unit of Measure', pluralName: 'Units of Measure', description: 'Units used for items and quantities',
    settings: { defaultSort: 'code' },
    definition: {
      fields: [
        { key: 'decimals', type: 'number', label: 'Decimal places', min: 0, max: 6, default: 0, required: true, width: 4, ...sys },
      ],
    },
  },
  {
    key: 'payment_terms', name: 'Payment Term', pluralName: 'Payment Terms', description: 'Credit periods offered by vendors',
    definition: {
      fields: [
        { key: 'credit_days', type: 'number', label: 'Credit days', min: 0, max: 3650, required: true, width: 4, ...sys },
      ],
    },
  },
  {
    key: 'item', name: 'Item', pluralName: 'Items', description: 'Materials, consumables and services you buy and stock',
    settings: { codePattern: 'ITM-{SEQ:5}', codeLabel: 'Item code', nameLabel: 'Item name', listColumns: ['category', 'uom'] },
    definition: {
      fields: [
        { key: 'category', type: 'select', label: 'Category', options: [{ value: 'RM', label: 'Raw Material' }, { value: 'FG', label: 'Finished Goods' }, { value: 'consumable', label: 'Consumable' }], required: true, width: 4, ...sys },
        { key: 'uom', type: 'lookup', label: 'Unit of measure', source: { kind: 'master', masterKey: 'uom' }, required: true, width: 4, ...sys },
        { key: 'hsn_code', type: 'text', label: 'HSN / SAC code', maxLength: 10, width: 4, ...sys },
        { key: 'track_batch', type: 'toggle', label: 'Track batches', default: false, width: 4, ...sys },
        { key: 'track_expiry', type: 'toggle', label: 'Track expiry', default: false, width: 4, ...sys },
        { key: 'image', type: 'image', label: 'Image', maxSizeMb: 5, width: 4, ...sys },
      ],
    },
  },
  {
    key: 'vendor', name: 'Vendor', pluralName: 'Vendors', description: 'Suppliers you buy from',
    settings: { codePattern: 'VEN-{SEQ:4}', codeLabel: 'Vendor code', nameLabel: 'Vendor name', listColumns: ['gstin', 'phone'] },
    definition: {
      fields: [
        { key: 'gstin', type: 'gstin', label: 'GSTIN', width: 6, ...sys },
        { key: 'pan', type: 'pan', label: 'PAN', width: 6, ...sys },
        { key: 'email', type: 'email', label: 'Email', width: 6, ...sys },
        { key: 'phone', type: 'phone', label: 'Phone', width: 6, ...sys },
        { key: 'address', type: 'textarea', label: 'Address', rows: 3, ...sys },
        { key: 'state_code', type: 'text', label: 'State code', help: 'Two-digit GST state code, e.g. 27', minLength: 2, maxLength: 2, width: 4, ...sys },
        { key: 'payment_terms', type: 'lookup', label: 'Payment terms', source: { kind: 'master', masterKey: 'payment_terms' }, width: 8, ...sys },
      ],
    },
  },
  {
    key: 'terms', name: 'Terms & Conditions', pluralName: 'Terms & Conditions', description: 'Standard clauses printed on documents',
    definition: {
      fields: [
        { key: 'body', type: 'textarea', label: 'Text', rows: 8, required: true, ...sys },
        {
          key: 'applies_to', type: 'multiselect', label: 'Applies to',
          options: [{ value: 'po', label: 'Purchase order' }, { value: 'indent', label: 'Indent' }, { value: 'grn', label: 'Goods receipt' }],
          ...sys,
        },
      ],
    },
  },
];

/** The user form (kind `system`): system fields map to tenant_user columns; custom fields go to tenant_user.custom. */
export const USER_FORM = {
  key: 'user',
  name: 'User',
  definition: {
    fields: [
      { key: 'name', type: 'text', label: 'Name', required: true, maxLength: 120, width: 6, ...sys },
      { key: 'email', type: 'email', label: 'Email', required: true, width: 6, ...sys },
      { key: 'phone', type: 'phone', label: 'Phone', width: 6, ...sys },
      { key: 'reporting_manager', type: 'lookup', label: 'Reporting manager', source: { kind: 'user', activeOnly: true }, display: ['name'], width: 6, ...sys },
    ],
  },
};

/** Keys of the user form backed by tenant_user columns (not stored in `custom`). */
export const USER_SYSTEM_FIELDS = ['name', 'email', 'phone', 'reporting_manager'] as const;

const view = (m: string) => [`master.${m}`, `master.${m}:action.view`, `master.${m}:view.active`];
const manage = (m: string) => [
  ...view(m), `master.${m}:action.add`, `master.${m}:action.edit`, `master.${m}:action.deactivate`, `master.${m}:action.import`,
  `master.${m}:action.export`, `master.${m}:view.inactive`,
];

/** Bundle `standard`: starter roles with sensible grants and sample units of measure. */
export const STANDARD_BUNDLE: TemplateBundle = {
  records: [
    {
      master: 'uom',
      rows: [
        { code: 'NOS', name: 'Nos', data: { decimals: '0' } },
        { code: 'KG', name: 'Kg', data: { decimals: '3' } },
        { code: 'LTR', name: 'Litre', data: { decimals: '3' } },
        { code: 'MTR', name: 'Metre', data: { decimals: '2' } },
        { code: 'BOX', name: 'Box', data: { decimals: '0' } },
      ],
    },
  ],
  roles: [
    {
      key: 'requester', name: 'Requester', description: 'Raises requisitions; can look up items and units',
      grants: [...view('item'), ...view('uom')],
    },
    {
      key: 'buyer', name: 'Buyer', description: 'Maintains vendors and items, negotiates and buys',
      grants: [...manage('item'), ...manage('vendor'), ...manage('payment_terms'), ...view('terms'), ...view('uom')],
    },
    {
      key: 'approver', name: 'Approver', description: 'Reviews and approves; read access to masters',
      grants: [...view('item'), ...view('vendor'), ...view('uom'), ...view('payment_terms'), ...view('terms')],
    },
    {
      key: 'store_keeper', name: 'Store keeper', description: 'Receives and issues stock; maintains items and units',
      grants: [...manage('item'), ...manage('uom'), ...view('vendor')],
    },
  ],
  settings: {},
};

export const STANDARD_TEMPLATE_ROW = {
  kind: 'bundle',
  key: 'standard',
  name: 'Standard starter',
  description: 'Starter roles (Requester, Buyer, Approver, Store keeper) and sample units of measure.',
};
