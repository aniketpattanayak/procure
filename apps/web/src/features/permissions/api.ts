import type { EffectivePermissions, MasterSummary, PermissionSetView, RegistryTab, RoleRow, ScopeEntry, UserRow } from '@procure/schema';
import { http } from '@/lib/api';

export interface RoleTabBody { actions: string[]; views: string[]; fieldAccess: { formKey: string; fieldKey: string; mode: 'hidden' | 'readonly' }[] }
export interface UserTabBody { allow: string[]; deny: string[]; fieldAccess: { formKey: string; fieldKey: string; mode: 'hidden' | 'readonly' | 'editable' }[] }

export type Subject = { kind: 'role'; id: string } | { kind: 'user'; id: string };
const base = (s: Subject) => `/${s.kind === 'role' ? 'roles' : 'users'}/${s.id}`;

export const permissionsApi = {
  registry: () => http.get<RegistryTab[]>('/permissions/registry'),
  get: (s: Subject) => http.get<PermissionSetView>(`${base(s)}/permissions`),
  saveRoleTab: (roleId: string, tabKey: string, body: RoleTabBody) =>
    http.put<PermissionSetView>(`/roles/${roleId}/permissions/tabs/${encodeURIComponent(tabKey)}`, body),
  saveUserTab: (userId: string, tabKey: string, body: UserTabBody) =>
    http.put<PermissionSetView>(`/users/${userId}/permissions/tabs/${encodeURIComponent(tabKey)}`, body),
  saveScope: (s: Subject, entries: ScopeEntry[]) => http.put<PermissionSetView>(`${base(s)}/scope`, { entries }),
  effective: (userId: string) => http.get<EffectivePermissions>(`/users/${userId}/effective-permissions`),
  setUserRoles: (userId: string, roleIds: string[]) => http.put<UserRow>(`/users/${userId}/roles`, { roleIds }),
};

export const roleAdminApi = {
  update: (id: string, body: { key: string; name: string; description?: string; version: number }) => http.put<RoleRow>(`/roles/${id}`, body),
  remove: (id: string) => http.del<void>(`/roles/${id}`),
};

export const mastersNavApi = {
  list: () => http.get<MasterSummary[]>('/masters'),
};

export const qk = {
  registry: ['permissions', 'registry'] as const,
  set: (s: Subject) => ['permissions', s.kind, s.id] as const,
  effective: (userId: string) => ['permissions', 'effective', userId] as const,
  masters: ['masters', 'nav'] as const,
};
