'use client';
/**
 * Client-side permission helpers (Phase 2). Stable exports used across features:
 *   usePermissions()  -> { has, hasAny, hasAll, canView, fieldMode, ... }
 *   <Can perm="admin.users:action.add">…</Can>   (React reserves `key`, so the prop is `perm`)
 *   <Can anyOf={[...]} fallback={…}>…</Can>
 *   useFieldAccess(formKey) -> (fieldKey) => 'editable' | 'readonly' | 'hidden'
 *   useMe() -> /auth/me extended with permissions, labels and settings
 *
 * The server is the source of truth (every route enforces keys); the UI only hides what the user can't use.
 * When /auth/me does not yet carry `permissions` (Phase 1 API), tenant admins are treated as holding
 * every key and everyone else holds none, which matches Phase 1 behaviour.
 */
import type { MeResponse, MyPermissions } from '@procure/schema';
import { perm } from '@procure/schema';
import { useMemo, type ReactNode } from 'react';
import { useSession } from './session';

export { perm };

/** /auth/me (MeResponse carries `permissions`, `labels` and `settings` since Phase 2). */
export function useMe(): MeResponse | null {
  return useSession().me;
}

export type FieldMode = 'editable' | 'readonly' | 'hidden';

export interface PermissionsApi {
  /** /auth/me has loaded for a tenant user. */
  ready: boolean;
  isTenantAdmin: boolean;
  /** False when the API has not sent `permissions` (Phase 1 fallback mode). */
  fromServer: boolean;
  keys: ReadonlySet<string>;
  has: (key: string) => boolean;
  hasAny: (...keys: string[]) => boolean;
  hasAll: (...keys: string[]) => boolean;
  /** `<tab>:action.view` */
  canView: (tabKey: string) => boolean;
  /** `<tab>:action.<action>` */
  can: (tabKey: string, action: string) => boolean;
  /** Status views the user may see on a tab, in the given order (first = default). */
  permittedViews: <T extends string>(tabKey: string, views: readonly T[]) => T[];
  fieldMode: (formKey: string, fieldKey: string) => FieldMode;
  scope: MyPermissions['scope'];
  version: number;
}

const EMPTY = new Set<string>();

export function usePermissions(): PermissionsApi {
  const { me, status } = useSession();
  const m = me;
  return useMemo<PermissionsApi>(() => {
    const p = m?.principal;
    const isTenant = p?.kind === 'tenant';
    const isTenantAdmin = isTenant && !!p.isTenantAdmin;
    const server = m?.permissions;
    const keys = server ? new Set(server.keys) : EMPTY;
    const has = (key: string) => (server ? keys.has(key) : isTenantAdmin);
    const fa = server?.fieldAccess ?? {};
    return {
      ready: status === 'ready' && isTenant,
      isTenantAdmin,
      fromServer: !!server,
      keys,
      has,
      hasAny: (...ks) => ks.some(has),
      hasAll: (...ks) => ks.every(has),
      canView: tab => has(perm.action(tab, 'view')),
      can: (tab, action) => has(perm.action(tab, action)),
      permittedViews: (tab, views) => views.filter(v => has(perm.view(tab, v))),
      fieldMode: (formKey, fieldKey) => fa[formKey]?.[fieldKey] ?? 'editable',
      scope: server?.scope ?? { allNodes: isTenantAdmin, nodeIds: [] },
      version: server?.version ?? 0,
    };
  }, [m, status]);
}

/** Field access for one form: `(fieldKey) => mode`. */
export function useFieldAccess(formKey: string) {
  const { fieldMode } = usePermissions();
  return (fieldKey: string) => fieldMode(formKey, fieldKey);
}

export interface CanProps {
  /** Single key that must be held. */
  perm?: string;
  /** Any of these keys. */
  anyOf?: string[];
  /** All of these keys. */
  allOf?: string[];
  /** Rendered when the check fails (default: nothing). */
  fallback?: ReactNode;
  children: ReactNode;
}

/** Renders children only when the current user holds the key(s). Hidden, not disabled. */
export function Can({ perm: k, anyOf, allOf, fallback = null, children }: CanProps) {
  const p = usePermissions();
  let ok = true;
  if (k) ok = ok && p.has(k);
  if (anyOf?.length) ok = ok && p.hasAny(...anyOf);
  if (allOf?.length) ok = ok && p.hasAll(...allOf);
  return <>{ok ? children : fallback}</>;
}
