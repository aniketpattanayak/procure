import type {
  AuthResult, CatalogResponse, Entitlements, OverrideHistoryRow, Page, Plan, PlatformAuditRow, SubscriptionRecord, TemporaryPasswordResult,
  TenantCreated, TenantDetail, TenantListRow, TenantRecord, TenantUsageRow,
} from '@procure/schema';
import { http } from '@/lib/api';
import { asArray } from '@/lib/types';

export type { TenantDetail };

export const platformApi = {
  catalog: () => http.get<CatalogResponse>('/platform/catalog'),
  plans: async () => asArray(await http.get<Plan[] | Page<Plan>>('/platform/plans')),
  createPlan: (body: unknown) => http.post<Plan>('/platform/plans', body),
  updatePlan: (id: string, body: unknown) => http.put<Plan>(`/platform/plans/${id}`, body),

  tenants: (q: { cursor?: string | null; q?: string; status?: string }) =>
    http.get<Page<TenantListRow>>('/platform/tenants', { cursor: q.cursor ?? undefined, q: q.q, status: q.status, limit: 50 }),
  createTenant: (body: unknown) => http.post<TenantCreated>('/platform/tenants', body),
  tenant: (id: string) => http.get<TenantDetail>(`/platform/tenants/${id}`),
  updateTenant: (id: string, body: unknown) => http.put<TenantRecord>(`/platform/tenants/${id}`, body),
  changeStatus: (id: string, action: 'suspend' | 'reactivate' | 'archive', reason: string) =>
    http.post<TenantRecord>(`/platform/tenants/${id}/${action}`, { reason }),
  setOverride: (id: string, body: unknown) => http.put<Entitlements>(`/platform/tenants/${id}/overrides`, body),
  overrideHistory: async (id: string) => asArray(await http.get<OverrideHistoryRow[] | Page<OverrideHistoryRow>>(`/platform/tenants/${id}/overrides/history`)),
  changeSubscription: (id: string, body: unknown) => http.post<SubscriptionRecord>(`/platform/tenants/${id}/subscription`, body),
  subscriptions: async (id: string) => asArray(await http.get<SubscriptionRecord[] | Page<SubscriptionRecord>>(`/platform/tenants/${id}/subscriptions`)),
  resetAdminPassword: (id: string) => http.post<TemporaryPasswordResult>(`/platform/tenants/${id}/admin/reset-password`),
  impersonate: (id: string, reason: string) => http.post<AuthResult>(`/platform/tenants/${id}/impersonate`, { reason }),
  setDomainPermission: (id: string, allow: boolean) => http.post<TenantRecord>(`/platform/tenants/${id}/domain-permission`, { allow }),
  setLogoUrl: (id: string, logoUrl: string | null) => http.post<TenantRecord>(`/platform/tenants/${id}/logo`, { logoUrl }),

  usage: async () => asArray(await http.get<TenantUsageRow[] | Page<TenantUsageRow>>('/platform/usage')),
  audit: (q: { cursor?: string | null; q?: string; tenantId?: string }) =>
    http.get<Page<PlatformAuditRow>>('/platform/audit', { cursor: q.cursor ?? undefined, q: q.q, tenantId: q.tenantId, limit: 50 }),
};
