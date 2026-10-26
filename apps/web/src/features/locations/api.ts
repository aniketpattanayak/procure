import type { LocationNode } from '@procure/schema';
import { http } from '@/lib/api';

export type LocationView = 'active' | 'inactive' | 'all';

export const locationsApi = {
  tree: (q: { view?: LocationView; scope?: 'all' | 'mine' } = {}) => http.get<LocationNode[]>('/locations/tree', q),
  list: (q: { parentId?: string; q?: string; view?: LocationView; scope?: 'all' | 'mine' } = {}) => http.get<LocationNode[]>('/locations', q),
  create: (body: { parentId: string | null; code: string; name: string; sortOrder?: number }) => http.post<LocationNode>('/locations', body),
  update: (id: string, body: { code?: string; name?: string; sortOrder?: number; version: number }) => http.put<LocationNode>(`/locations/${id}`, body),
  move: (id: string, body: { parentId: string | null; version: number }) => http.post<LocationNode>(`/locations/${id}/move`, body),
  deactivate: (id: string) => http.post<LocationNode>(`/locations/${id}/deactivate`),
  activate: (id: string) => http.post<LocationNode>(`/locations/${id}/activate`),
  remove: (id: string) => http.del<void>(`/locations/${id}`),
};

export const locationKeys = {
  all: ['locations'] as const,
  tree: (view: LocationView, scope: 'all' | 'mine' = 'all') => ['locations', 'tree', view, scope] as const,
  mine: ['locations', 'mine'] as const,
};
