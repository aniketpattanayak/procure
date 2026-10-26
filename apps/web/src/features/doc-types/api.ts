import type { DocTypeSettings, DocTypeSummary } from '@procure/schema';
import { http } from '@/lib/api';
import { asArray } from '@/lib/types';

export interface DocTypeCreateBody {
  key: string; name: string; pluralName: string; description?: string; hasLines: boolean; itemLines: boolean;
  settings: Partial<DocTypeSettings>; numberPattern: string;
}
export interface DocTypeUpdateBody { name?: string; pluralName?: string; description?: string; settings?: DocTypeSettings; version: number }

export const docTypesApi = {
  list: async () => asArray(await http.get<DocTypeSummary[] | { data: DocTypeSummary[] }>('/doc-types')),
  create: (body: DocTypeCreateBody) => http.post<DocTypeSummary>('/config/doc-types', body),
  update: (key: string, body: DocTypeUpdateBody) => http.put<DocTypeSummary>(`/config/doc-types/${key}`, body),
  deactivate: (key: string) => http.post<DocTypeSummary>(`/config/doc-types/${key}/deactivate`),
  activate: (key: string) => http.post<DocTypeSummary>(`/config/doc-types/${key}/activate`),
};
