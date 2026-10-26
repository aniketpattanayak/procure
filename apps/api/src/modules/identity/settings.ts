import { SettingKey, SettingsRegistry, SettingValue } from '@procure/schema';
import type { Tx } from '../../core/db.service';

/**
 * Reads a tenant setting from app.tenant_setting (tx must carry tenant context), falling back
 * to the registry default when missing or invalid.
 */
export async function getTenantSetting<K extends SettingKey>(tx: Tx, key: K): Promise<SettingValue<K>> {
  const def = SettingsRegistry[key];
  const row = await tx.selectFrom('app.tenant_setting').select('value').where('key', '=', key).executeTakeFirst();
  if (!row) return def.default as SettingValue<K>;
  const parsed = def.schema.safeParse(row.value);
  return (parsed.success ? parsed.data : def.default) as SettingValue<K>;
}
