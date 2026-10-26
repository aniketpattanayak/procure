import { sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import { fromUnits, QTY_SCALE, toUnits } from './qty';

/**
 * QA3-BUG-003: the Unit of Measure master's `decimals` (0–6) caps the decimal places of every quantity entered in that
 * unit (line qty, workflow decisions, receipts, issues, opening stock). The ledger keeps 4 decimals, so a unit with
 * 4–6 decimals is limited by the ledger only.
 */
export interface UomRule { code: string; name: string; decimals: number }

/** `decimals` of the given UoM records (unknown ids and units without a valid `decimals` are left out: no limit). */
export async function uomRules(tx: Tx, tenantId: string, uomIds: (string | null | undefined)[]): Promise<Map<string, UomRule>> {
  const ids = [...new Set(uomIds.filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)))];
  if (!ids.length) return new Map();
  const rows = await sql<{ id: string; code: string; name: string; decimals: string | null }>`
    select id, code::text as code, name, data->>'decimals' as decimals from app.master_record
     where tenant_id = ${tenantId} and id = any(${ids}::uuid[])`.execute(tx);
  const out = new Map<string, UomRule>();
  for (const r of rows.rows) {
    const d = r.decimals === null ? NaN : Number(r.decimals);
    if (Number.isInteger(d) && d >= 0 && d < QTY_SCALE) out.set(r.id, { code: r.code, name: r.name, decimals: d });
  }
  return out;
}

/** Item id → its unit's rule (items whose `uom` has no limit are left out). */
export async function itemUomRules(tx: Tx, tenantId: string, itemIds: (string | null | undefined)[]): Promise<Map<string, UomRule>> {
  const ids = [...new Set(itemIds.filter((v): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)))];
  if (!ids.length) return new Map();
  const rows = await sql<{ id: string; uom: string | null }>`
    select id, data->>'uom' as uom from app.master_record where tenant_id = ${tenantId} and id = any(${ids}::uuid[])`.execute(tx);
  const rules = await uomRules(tx, tenantId, rows.rows.map(r => r.uom));
  const out = new Map<string, UomRule>();
  for (const r of rows.rows) {
    const rule = r.uom ? rules.get(r.uom) : undefined;
    if (rule) out.set(r.id, rule);
  }
  return out;
}

/** True when `qty` has no more decimal places than the unit allows (unparseable values are left to other checks). */
export function fitsUom(qty: unknown, rule: UomRule | undefined): boolean {
  if (!rule || qty === null || qty === undefined || qty === '') return true;
  let u: bigint;
  try {
    u = toUnits(typeof qty === 'number' ? String(qty) : String(qty));
  } catch {
    return true;
  }
  return u % 10n ** BigInt(QTY_SCALE - rule.decimals) === 0n;
}

export function uomMessage(qty: unknown, rule: UomRule): string {
  let shown = String(qty);
  try {
    shown = fromUnits(toUnits(String(qty)));
  } catch { /* keep as given */ }
  const allows = rule.decimals === 0 ? 'whole numbers only' : `at most ${rule.decimals} decimal place${rule.decimals === 1 ? '' : 's'}`;
  return `Quantity ${shown} is not allowed: the unit "${rule.code}" (${rule.name}) takes ${allows}.`;
}
