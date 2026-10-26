import type { EffectivePermissions, PermissionSetView, RegistryTab } from '@procure/schema';
import { perm } from '@procure/schema';
import type { RoleTabBody, UserTabBody } from './api';

/** Registry keys may come as full keys (`tab:action.x`) or bare names (`x`); normalise to full keys. */
export const actionKey = (tab: RegistryTab, k: string) => (k.includes(':') ? k : perm.action(tab.key, k));
export const viewKey = (tab: RegistryTab, k: string) => (k.includes(':') ? k : perm.view(tab.key, k));
export const fieldId = (formKey: string, fieldKey: string) => `${formKey}|${fieldKey}`;

export function tabKeys(tab: RegistryTab): string[] {
  return [...tab.actions.map(a => actionKey(tab, a.key)), ...tab.views.map(v => viewKey(tab, v.key))];
}

export type RoleFieldMode = 'readonly' | 'hidden';
export type UserFieldMode = 'readonly' | 'hidden' | 'editable';

export interface RoleDraft { kind: 'role'; granted: Set<string>; fields: Map<string, RoleFieldMode> }
export interface UserDraft { kind: 'user'; overrides: Map<string, 'allow' | 'deny'>; fields: Map<string, UserFieldMode> }
export type Draft = RoleDraft | UserDraft;

function tabFieldIds(tab: RegistryTab) {
  const ids = new Set<string>();
  for (const f of tab.forms) for (const fl of f.fields) ids.add(fieldId(f.formKey, fl.key));
  return ids;
}

export function draftFromSet(kind: 'role' | 'user', tab: RegistryTab, set: PermissionSetView | undefined): Draft {
  const keys = new Set(tabKeys(tab));
  const fids = tabFieldIds(tab);
  const fa = (set?.fieldAccess ?? []).filter(f => fids.has(fieldId(f.formKey, f.fieldKey)));
  if (kind === 'role') {
    return {
      kind,
      granted: new Set((set?.grants ?? []).filter(g => g.effect === 'allow' && keys.has(g.key)).map(g => g.key)),
      fields: new Map(fa.filter(f => f.mode !== 'editable').map(f => [fieldId(f.formKey, f.fieldKey), f.mode as RoleFieldMode])),
    };
  }
  return {
    kind,
    overrides: new Map((set?.grants ?? []).filter(g => keys.has(g.key)).map(g => [g.key, g.effect])),
    fields: new Map(fa.map(f => [fieldId(f.formKey, f.fieldKey), f.mode])),
  };
}

export function draftsEqual(a: Draft, b: Draft): boolean {
  const mapEq = <V,>(x: Map<string, V>, y: Map<string, V>) => x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
  if (a.kind === 'role' && b.kind === 'role') return a.granted.size === b.granted.size && [...a.granted].every(k => b.granted.has(k)) && mapEq(a.fields, b.fields);
  if (a.kind === 'user' && b.kind === 'user') return mapEq(a.overrides, b.overrides) && mapEq(a.fields, b.fields);
  return false;
}

export function roleBody(tab: RegistryTab, d: RoleDraft): RoleTabBody {
  const views = new Set(tab.views.map(v => viewKey(tab, v.key)));
  return {
    actions: [...d.granted].filter(k => !views.has(k)),
    views: [...d.granted].filter(k => views.has(k)),
    fieldAccess: [...d.fields].map(([id, mode]) => { const [formKey, fieldKey] = id.split('|') as [string, string]; return { formKey, fieldKey, mode }; }),
  };
}

export function userBody(d: UserDraft): UserTabBody {
  return {
    allow: [...d.overrides].filter(([, e]) => e === 'allow').map(([k]) => k),
    deny: [...d.overrides].filter(([, e]) => e === 'deny').map(([k]) => k),
    fieldAccess: [...d.fields].map(([id, mode]) => { const [formKey, fieldKey] = id.split('|') as [string, string]; return { formKey, fieldKey, mode }; }),
  };
}

/** Role names that grant a key, from EffectivePermissions sources ('role:<name>'). */
export function roleSources(eff: EffectivePermissions | undefined, key: string): string[] {
  const row = eff?.keys.find(k => k.key === key);
  return (row?.sources ?? []).filter(s => s.startsWith('role:')).map(s => s.slice(5));
}

/** What the user ends up with for a key given the draft override and the inherited role grants. */
export function effectiveFor(inherited: boolean, override: 'allow' | 'deny' | undefined, isTenantAdmin: boolean): boolean {
  if (isTenantAdmin) return true;
  if (override === 'deny') return false;
  if (override === 'allow') return true;
  return inherited;
}

/** Granted-key count per tab for the tab list. */
export function countsFor(tabs: RegistryTab[], granted: (key: string) => boolean): Map<string, { granted: number; total: number }> {
  const out = new Map<string, { granted: number; total: number }>();
  for (const tab of tabs) {
    const keys = tabKeys(tab);
    out.set(tab.key, { granted: keys.filter(granted).length, total: keys.length });
  }
  return out;
}
