import type { Tx } from './db.service';

/**
 * Setting change guards (Phase 5): a module may veto a tenant-setting change it cannot honour (e.g. the stock module
 * refuses `stock.valuation` changes inside a financial year that already has stock movements → 409). Guards run in
 * the PATCH /config/settings transaction, after validation and before the write, only for keys whose value changes.
 */
export type SettingGuard = (tx: Tx, change: { tenantId: string; key: string; before: unknown; after: unknown }) => Promise<void>;

const GUARDS = new Map<string, SettingGuard[]>();

export function registerSettingGuard(key: string, guard: SettingGuard): void {
  GUARDS.set(key, [...(GUARDS.get(key) ?? []), guard]);
}

export async function runSettingGuards(tx: Tx, tenantId: string, key: string, before: unknown, after: unknown): Promise<void> {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  for (const g of GUARDS.get(key) ?? []) await g(tx, { tenantId, key, before, after });
}
