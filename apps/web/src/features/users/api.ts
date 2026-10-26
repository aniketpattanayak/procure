import type { Page, RoleRow, SessionRow, TemporaryPasswordResult, UserCreated, UserRow } from '@procure/schema';
import { http } from '@/lib/api';
import { asArray } from '@/lib/types';

export const usersApi = {
  list: (q: { cursor?: string | null; q?: string; view?: 'active' | 'inactive'; limit?: number }) =>
    http.get<Page<UserRow>>('/users', { cursor: q.cursor ?? undefined, q: q.q, view: q.view, limit: q.limit ?? 50 }),
  get: (id: string) => http.get<UserRow>(`/users/${id}`),
  create: (body: unknown) => http.post<UserCreated>('/users', body),
  update: (id: string, body: unknown) => http.put<UserRow>(`/users/${id}`, body),
  deactivate: (id: string) => http.post<UserRow>(`/users/${id}/deactivate`),
  activate: (id: string) => http.post<UserRow>(`/users/${id}/activate`),
  resetPassword: (id: string) => http.post<TemporaryPasswordResult>(`/users/${id}/reset-password`),
  unlock: (id: string) => http.post<UserRow>(`/users/${id}/unlock`),
  sessions: (id: string) => http.get<SessionRow[]>(`/users/${id}/sessions`),
  forceLogout: (id: string) => http.post<void>(`/users/${id}/force-logout`),
};

export const rolesApi = {
  list: async () => asArray(await http.get<RoleRow[] | Page<RoleRow>>('/roles')),
  create: (body: unknown) => http.post<RoleRow>('/roles', body),
};
