import { SettingKey, SettingsRegistry } from '@procure/schema';
import type { Tx } from '../../core/db.service';

/** Every registry setting with the tenant's value (invalid/missing → default). tx must carry tenant context. */
export async function loadSettings(tx: Tx): Promise<{ values: Record<string, unknown>; stored: Set<string> }> {
  const rows = await tx.selectFrom('app.tenant_setting').select(['key', 'value'])
    .where('key', 'in', Object.keys(SettingsRegistry)).execute();
  const values: Record<string, unknown> = {};
  const stored = new Set<string>();
  for (const k of Object.keys(SettingsRegistry) as SettingKey[]) values[k] = SettingsRegistry[k].default;
  for (const r of rows) {
    const def = SettingsRegistry[r.key as SettingKey];
    const parsed = def.schema.safeParse(r.value);
    if (parsed.success) { values[r.key] = parsed.data; stored.add(r.key); }
  }
  return { values, stored };
}

/** Boolean settings only (flow switches and any other on/off setting a registry entry may require). */
export function booleanSettings(values: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(values)) if (typeof v === 'boolean') out[k] = v;
  return out;
}

/** Level label for a node depth: depth n uses item n−1, deeper levels reuse the last. */
export function levelLabel(levels: string[], depth: number): string {
  if (!levels.length) return 'Location';
  return levels[Math.min(depth, levels.length) - 1] ?? levels[levels.length - 1]!;
}
