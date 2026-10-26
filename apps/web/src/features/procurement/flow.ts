'use client';
import { useMe } from '@/lib/permissions';

/** Flow switches from /auth/me settings (absent = registry default). */
export interface ProcurementFlow {
  indentEnabled: boolean;
  selectionEnabled: boolean;
  directPoAllowed: boolean;
  /** null when /auth/me doesn't carry it: the server enforces the cap. */
  maxOverApprovalPct: number | null;
  landedCostFormula: string;
}

export const DEFAULT_LANDED_FORMULA = 'rate * (1 + tax_pct / 100) + freight_per_unit';

export function readFlow(settings: Record<string, unknown> | undefined | null): ProcurementFlow {
  const s = settings ?? {};
  const bool = (k: string, d: boolean) => (typeof s[k] === 'boolean' ? (s[k] as boolean) : d);
  const raw = s['selection.max_over_approval_pct'];
  const pct = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  return {
    indentEnabled: bool('flow.indent.enabled', true),
    selectionEnabled: bool('flow.vendor_selection.enabled', true),
    directPoAllowed: bool('flow.po.direct_allowed', false),
    maxOverApprovalPct: Number.isFinite(pct) ? pct : null,
    landedCostFormula: typeof s['procurement.landed_cost_formula'] === 'string' ? (s['procurement.landed_cost_formula'] as string) : DEFAULT_LANDED_FORMULA,
  };
}

export function useProcurementFlow(): ProcurementFlow {
  return readFlow(useMe()?.settings as Record<string, unknown> | undefined);
}

export const PERM = {
  indentView: 'doc.indent:action.view',
  logQuote: 'doc.indent:action.log_quote',
  compare: 'doc.indent:action.compare',
  indentShortClose: 'doc.indent:action.short_close',
  selectionAdd: 'doc.vendor_selection:action.add',
  selectionSubmit: 'doc.vendor_selection:action.submit',
  overApprove: 'doc.vendor_selection:action.over_approve',
  poAdd: 'doc.po:action.add',
  followup: 'doc.po:action.followup',
  amend: 'doc.po:action.amend',
  poShortClose: 'doc.po:action.short_close',
  grnShortClose: 'doc.grn:action.short_close',
} as const;
