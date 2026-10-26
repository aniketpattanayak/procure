import type { NumberingSeriesRow } from '@procure/schema';
import { http } from '@/lib/api';
import { asArray } from '@/lib/types';

export interface SeriesBody {
  docTypeKey: string; name: string; locationNodeId: string | null; pattern: string; reset: 'never' | 'fy' | 'month'; isActive: boolean;
}

export const numberingApi = {
  list: async (docType: string) => asArray(await http.get<NumberingSeriesRow[] | { data: NumberingSeriesRow[] }>('/config/numbering', { docType })),
  create: (body: SeriesBody) => http.post<NumberingSeriesRow>('/config/numbering', body),
  update: (id: string, body: SeriesBody & { version: number }) => http.put<NumberingSeriesRow>(`/config/numbering/${id}`, body),
  preview: (id: string, q: { locationId?: string | null; date?: string }) =>
    http.get<{ number: string }>(`/config/numbering/${id}/preview`, { locationId: q.locationId ?? undefined, date: q.date }),
};
