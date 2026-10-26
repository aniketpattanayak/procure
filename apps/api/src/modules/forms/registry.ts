import { perm } from '@procure/schema';
import type { Tx } from '../../core/db.service';

export const MASTER_ACTIONS: { name: string; label: (m: string, p: string) => string }[] = [
  { name: 'view', label: (_m, p) => `View ${p.toLowerCase()}` },
  { name: 'add', label: m => `Add ${m.toLowerCase()}` },
  { name: 'edit', label: m => `Edit ${m.toLowerCase()}` },
  { name: 'deactivate', label: () => 'Deactivate / activate' },
  { name: 'delete', label: m => `Delete ${m.toLowerCase()}` },
  { name: 'import', label: () => 'Import' },
  { name: 'export', label: () => 'Export' },
];
export const MASTER_VIEWS = [
  { name: 'active', label: 'Active' },
  { name: 'inactive', label: 'Inactive' },
];

/** Every registry key generated for a master (tab, actions, views). */
export function masterKeys(masterKey: string): string[] {
  const tab = perm.masterTab(masterKey);
  return [tab, ...MASTER_ACTIONS.map(a => perm.action(tab, a.name)), ...MASTER_VIEWS.map(v => perm.view(tab, v.name))];
}

/**
 * Writes (or refreshes labels of) the `app.permission_def` rows of one master (ADR-0005, source `master`).
 * Explicit tenant filters: also correct inside the platform-role provisioning transaction.
 */
export async function upsertMasterRegistry(
  tx: Tx, tenantId: string, m: { id: string; key: string; name: string; pluralName: string; sortOrder?: number },
) {
  const tab = perm.masterTab(m.key);
  const rows = [
    { key: tab, kind: 'tab' as const, label: m.pluralName, group_label: 'Masters', sort_order: m.sortOrder ?? 500 },
    ...MASTER_ACTIONS.map((a, i) => ({
      key: perm.action(tab, a.name), kind: 'action' as const, label: a.label(m.name, m.pluralName), group_label: null, sort_order: i + 1,
    })),
    ...MASTER_VIEWS.map((v, i) => ({ key: perm.view(tab, v.name), kind: 'view' as const, label: v.label, group_label: null, sort_order: i + 1 })),
  ];
  await tx.insertInto('app.permission_def').values(rows.map(r => ({
    tenant_id: tenantId, key: r.key, kind: r.kind, tab_key: tab, label: r.label, description: null, group_label: r.group_label,
    requires_feature: null, requires_setting: null, sort_order: r.sort_order, source: 'master' as const, source_id: m.id,
  }))).onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet(eb => ({
    label: eb.ref('excluded.label'), group_label: eb.ref('excluded.group_label'), source_id: eb.ref('excluded.source_id'),
  }))).execute();
}
