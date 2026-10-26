/**
 * Pure permission compiler (ADR-0005). No I/O: the resolver loads the inputs, this turns them into the effective set.
 *
 *   visible   = registry entries whose plan feature is enabled and whose flow setting is on (tab and entry both)
 *   effective = visible ∩ ((∪ role allow ∪ user allow) − (role deny ∪ user deny))     — deny always wins
 *   admin     = every visible key
 *
 * Data scope: union of role + user scope rows. Rows with a tab_key form that tab's scope and, when present,
 * replace the global (tab_key NULL) rows for that tab — so a tab row can narrow or extend the default.
 * Field access: role rows merge most-restrictive (hidden > readonly); a user row overrides every role row for that
 * field ('editable' lifts the restriction). Tenant admins have no field restrictions and every node.
 */
import type { MyPermissions } from '@procure/schema';

export type PermKind = 'tab' | 'action' | 'view';
export type RegistrySource = 'platform' | 'master' | 'form' | 'workflow' | 'report';

export interface RegistryEntry {
  key: string;
  kind: PermKind;
  tabKey: string;
  label: string;
  description: string | null;
  group: string | null;
  requiresFeature: string | null;
  requiresSetting: string | null;
  sortOrder: number;
  source: RegistrySource;
}

export interface Grant { key: string; effect: 'allow' | 'deny'; roleId?: string | null; roleName?: string | null }
export interface FieldAccessRow { formKey: string; fieldKey: string; mode: 'hidden' | 'readonly' | 'editable'; roleId?: string | null }
export interface ScopeRow { allNodes: boolean; nodeId: string | null; includeDescendants: boolean; tabKey: string | null }
export interface ScopeNode { id: string; parentId: string | null; path: string; isActive: boolean }

/** Resolved scope for one tab (or the default '*'). */
export interface ScopeSet {
  all: boolean;
  /** Active node ids the user may act on (descendants included where granted). */
  nodeIds: string[];
  /** ltree paths whose whole subtree is in scope (grants with includeDescendants). */
  subtreePaths: string[];
  /** ltree paths of single nodes granted without descendants. */
  exactPaths: string[];
}

/**
 * What the resolver returns and AuthGuard attaches as `req.permissions`. A superset of the frozen `MyPermissions`;
 * `scopes` carries per-tab scope and ltree paths for `ScopeService` ('*' = default for tabs without own rows).
 */
export interface ResolvedPermissions extends MyPermissions {
  isTenantAdmin: boolean;
  scopes: Record<string, ScopeSet>;
}

export interface CompileInput {
  isTenantAdmin: boolean;
  /** Full registry (visible and hidden); `features`/`settings` decide visibility. */
  registry: RegistryEntry[];
  features: string[];
  /** Boolean flow settings (registry defaults merged with tenant values). */
  settings: Record<string, boolean>;
  roleGrants: Grant[];
  userGrants: Grant[];
  roleFieldAccess: FieldAccessRow[];
  userFieldAccess: FieldAccessRow[];
  scopeRows: ScopeRow[];
  /** Every node referenced by a scope row plus their descendants (active or not). */
  nodes: ScopeNode[];
  version: number;
}

export interface KeyExplanation { key: string; granted: boolean; sources: string[] }

export interface Visibility {
  visible: RegistryEntry[];
  /** Tab keys hidden by plan feature or flow setting. */
  hiddenTabs: string[];
  /** Keys hidden by plan feature (any kind). */
  hiddenByFeature: Set<string>;
  /** Keys hidden by a flow setting (and not by plan). */
  hiddenBySetting: Set<string>;
}

function passes(e: RegistryEntry, features: Set<string>, settings: Record<string, boolean>): 'ok' | 'feature' | 'setting' {
  if (e.requiresFeature && !features.has(e.requiresFeature)) return 'feature';
  if (e.requiresSetting && settings[e.requiresSetting] !== true) return 'setting';
  return 'ok';
}

/** Splits the registry into visible and hidden entries. An entry is visible only if its tab is visible too. */
export function computeVisibility(registry: RegistryEntry[], features: string[], settings: Record<string, boolean>): Visibility {
  const feats = new Set(features);
  const tabs = new Map(registry.filter(e => e.kind === 'tab').map(t => [t.key, passes(t, feats, settings)]));
  const visible: RegistryEntry[] = [];
  const hiddenByFeature = new Set<string>();
  const hiddenBySetting = new Set<string>();
  for (const e of registry) {
    const own = passes(e, feats, settings);
    const tab = tabs.get(e.tabKey) ?? 'feature'; // orphan entries (no tab row) are never visible
    const res = own === 'feature' || tab === 'feature' ? 'feature' : own === 'setting' || tab === 'setting' ? 'setting' : 'ok';
    if (res === 'ok') visible.push(e);
    else if (res === 'feature') hiddenByFeature.add(e.key);
    else hiddenBySetting.add(e.key);
  }
  const hiddenTabs = [...tabs.entries()].filter(([k]) => hiddenByFeature.has(k) || hiddenBySetting.has(k)).map(([k]) => k).sort();
  return { visible, hiddenTabs, hiddenByFeature, hiddenBySetting };
}

const viewKey = (tab: string) => `${tab}:action.view`;

/** Effective keys plus a per-key explanation (for /users/:id/effective-permissions). */
export function compileKeys(input: Pick<CompileInput, 'isTenantAdmin' | 'registry' | 'features' | 'settings' | 'roleGrants' | 'userGrants'>) {
  const vis = computeVisibility(input.registry, input.features, input.settings);
  const grantable = vis.visible.filter(e => e.kind !== 'tab');
  const sources = new Map<string, string[]>();
  const add = (k: string, s: string) => { const l = sources.get(k) ?? []; if (!l.includes(s)) l.push(s); sources.set(k, l); };
  const denied = new Set<string>();
  const allowed = new Set<string>();
  for (const g of input.roleGrants) {
    const label = `role:${g.roleName ?? g.roleId ?? '?'}`;
    if (g.effect === 'deny') { denied.add(g.key); add(g.key, `${label}:deny`); } else { allowed.add(g.key); add(g.key, label); }
  }
  for (const g of input.userGrants) {
    if (g.effect === 'deny') { denied.add(g.key); add(g.key, 'user:deny'); } else { allowed.add(g.key); add(g.key, 'user:allow'); }
  }
  const keys = new Set<string>();
  const explain: KeyExplanation[] = [];
  for (const e of grantable) {
    let granted: boolean;
    const src = [...(sources.get(e.key) ?? [])];
    if (input.isTenantAdmin) { granted = true; src.unshift('tenant_admin'); } else granted = allowed.has(e.key) && !denied.has(e.key);
    if (granted) keys.add(e.key);
    explain.push({ key: e.key, granted, sources: src });
  }
  // A tab is visible (and its key effective) iff its view action is held.
  for (const t of vis.visible.filter(e => e.kind === 'tab')) if (keys.has(viewKey(t.key))) keys.add(t.key);
  return { keys: [...keys].sort(), explain, visibility: vis };
}

/** Merges field access: roles most-restrictive, user rows override (including 'editable'). */
export function mergeFieldAccess(roleRows: FieldAccessRow[], userRows: FieldAccessRow[]): MyPermissions['fieldAccess'] {
  const merged = new Map<string, 'hidden' | 'readonly'>();
  const id = (r: FieldAccessRow) => `${r.formKey}\u0000${r.fieldKey}`;
  for (const r of roleRows) {
    if (r.mode === 'editable') continue; // not allowed on roles (DB check); ignore defensively
    const cur = merged.get(id(r));
    if (cur !== 'hidden') merged.set(id(r), r.mode);
  }
  const userIds = new Set<string>();
  for (const r of userRows) {
    userIds.add(id(r));
    if (r.mode === 'editable') merged.delete(id(r));
    else merged.set(id(r), r.mode);
  }
  const out: MyPermissions['fieldAccess'] = {};
  for (const [k, mode] of merged) {
    const [formKey, fieldKey] = k.split('\u0000') as [string, string];
    (out[formKey] ??= {})[fieldKey] = mode;
  }
  return out;
}

/** Expands scope rows to node ids and ltree paths. Inactive nodes are never in `nodeIds`. */
export function expandScope(rows: ScopeRow[], nodes: ScopeNode[]): ScopeSet {
  if (rows.some(r => r.allNodes)) return { all: true, nodeIds: [], subtreePaths: [], exactPaths: [] };
  const byId = new Map(nodes.map(n => [n.id, n]));
  const ids = new Set<string>();
  const subtree = new Set<string>();
  const exact = new Set<string>();
  for (const r of rows) {
    const n = r.nodeId ? byId.get(r.nodeId) : undefined;
    if (!n) continue;
    if (r.includeDescendants) {
      subtree.add(n.path);
      for (const d of nodes) if (d.isActive && (d.path === n.path || d.path.startsWith(`${n.path}.`))) ids.add(d.id);
    } else {
      exact.add(n.path);
      if (n.isActive) ids.add(n.id);
    }
  }
  // An exact path already covered by a subtree is redundant.
  const subs = [...subtree];
  const covered = (p: string) => subs.some(s => p === s || p.startsWith(`${s}.`));
  return {
    all: false,
    nodeIds: [...ids].sort(),
    subtreePaths: subs.filter(p => !subs.some(s => s !== p && p.startsWith(`${s}.`))).sort(),
    exactPaths: [...exact].filter(p => !covered(p)).sort(),
  };
}

/** Per-tab scopes: '*' from rows without tab, plus one entry per tab that has its own rows. */
export function compileScopes(isTenantAdmin: boolean, rows: ScopeRow[], nodes: ScopeNode[]): Record<string, ScopeSet> {
  if (isTenantAdmin) return { '*': { all: true, nodeIds: [], subtreePaths: [], exactPaths: [] } };
  const out: Record<string, ScopeSet> = { '*': expandScope(rows.filter(r => r.tabKey === null), nodes) };
  const tabs = new Set(rows.filter(r => r.tabKey !== null).map(r => r.tabKey!));
  for (const t of tabs) out[t] = expandScope(rows.filter(r => r.tabKey === t), nodes);
  return out;
}

export function compile(input: CompileInput): { perms: ResolvedPermissions; explain: KeyExplanation[]; visibility: Visibility } {
  const { keys, explain, visibility } = compileKeys(input);
  const scopes = compileScopes(input.isTenantAdmin, input.scopeRows, input.nodes);
  const def = scopes['*']!;
  return {
    perms: {
      keys,
      scope: { allNodes: def.all, nodeIds: def.nodeIds },
      fieldAccess: input.isTenantAdmin ? {} : mergeFieldAccess(input.roleFieldAccess, input.userFieldAccess),
      version: input.version,
      isTenantAdmin: input.isTenantAdmin,
      scopes,
    },
    explain,
    visibility,
  };
}
