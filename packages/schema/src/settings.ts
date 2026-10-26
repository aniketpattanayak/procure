import { z } from 'zod';

/**
 * Tenant settings registry: every setting key, its type and default.
 * Tenants store overrides in app.tenant_setting; anything absent uses the default here.
 * Adding a setting = adding an entry; no per-tenant code ever.
 */
export const SettingsRegistry = {
  'security.password_min_length': { schema: z.number().int().min(10).max(64), default: 10, label: 'Minimum password length' },
  'security.max_failed_logins': { schema: z.number().int().min(3).max(20), default: 5, label: 'Failed logins before lockout' },
  'security.lockout_minutes': { schema: z.number().int().min(1).max(1440), default: 15, label: 'Lockout duration (minutes)' },
  'security.session_days': { schema: z.number().int().min(1).max(90), default: 30, label: 'Refresh session lifetime (days)' },
  'labels.location_levels': { schema: z.array(z.string().min(1).max(40)), default: ['Location', 'Sub-location', 'Division'], label: 'Location level names' },
  'flow.indent.enabled': { schema: z.boolean(), default: true, label: 'Use indents' },
  'flow.vendor_selection.enabled': { schema: z.boolean(), default: true, label: 'Use vendor selection' },
  'flow.po.direct_allowed': { schema: z.boolean(), default: false, label: 'Allow PO without indent' },
  'flow.issue.without_indent': { schema: z.boolean(), default: true, label: 'Allow issue without requisition' },
  'selection.max_over_approval_pct': { schema: z.number().min(0).max(100), default: 0, label: 'Max over-approval %' },
  'grn.over_receipt_pct': { schema: z.number().min(0).max(100), default: 5, label: 'Over-receipt tolerance %' },
  'stock.valuation': { schema: z.enum(['wac', 'fifo']), default: 'wac', label: 'Stock valuation method' },
  'procurement.landed_cost_formula': { schema: z.string().min(1).max(500), default: 'rate * (1 + tax_pct / 100) + freight_per_unit', label: 'Landed cost per unit (formula)' },
  'procurement.quote_validity_days': { schema: z.number().int().min(1).max(365), default: 30, label: 'Default quote validity (days)' },
  'stock.allow_negative': { schema: z.boolean(), default: false, label: 'Allow negative stock' },
  // ---- Phase 5 (GRN agent): GRN spanning several POs of one vendor; RTV re-opens the PO line's pending receipt.
  'grn.multi_po': { schema: z.boolean(), default: false, label: 'Allow one GRN for several POs of a vendor' },
  'rtv.reopens_po': { schema: z.boolean(), default: true, label: 'Returns to vendor re-open the PO quantity' },
  'stock.cost_includes_tax': { schema: z.boolean(), default: false, label: 'Stock cost includes GST on receipts' },
  // ---- Phase 5 fix (QA5-BUG-010): FEFO skips expired batches; issuing an expired batch by name needs this switch.
  'stock.allow_expired_issue': { schema: z.boolean(), default: false, label: 'Allow issuing expired batches' },
  // ---- Phase 3 fix (QA3-BUG-004): segregation of duties on escalation / forward / no-actor assignments too.
  'workflow.block_self_approval': { schema: z.boolean(), default: true, label: 'Submitters cannot approve their own documents, even when assigned by escalation' },
} as const;

export type SettingKey = keyof typeof SettingsRegistry;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SettingsRegistry)[K]['schema']>;
