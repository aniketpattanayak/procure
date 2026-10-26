import type { AuditCheckRow, AuditRow, Page } from '@procure/schema';
import { http } from '@/lib/api';
import { asArray } from '@/lib/types';

export interface AuditFilters { entity?: string; entityId?: string; actorId?: string; action?: string; from?: string; to?: string }

export const auditApi = {
  list: (f: AuditFilters, cursor: string | null) => http.get<Page<AuditRow>>('/audit', { ...f, cursor: cursor ?? undefined, limit: 50 }),
  checks: async () => asArray(await http.get<AuditCheckRow[] | { data: AuditCheckRow[] }>('/audit/checks')),
  runCheck: () => http.post<AuditCheckRow>('/audit/checks'),
};
