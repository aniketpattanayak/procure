import type { ImportReport, MasterSummary, Page, RecordDeleteBlocked, RecordRow } from '@procure/schema';
import { downloadAuthed, postMultipart } from '@/components/file-upload/transport';
import { api, http } from '@/lib/api';

export type RecordView = 'active' | 'inactive' | 'all';

export interface RecordListParams { cursor?: string | null; q?: string; view?: RecordView; sort?: string; limit?: number }

export const mastersApi = {
  list: () => http.get<MasterSummary[]>('/masters'),
  create: (body: unknown) => http.post<MasterSummary>('/config/masters', body),
  update: (key: string, body: unknown) => http.put<MasterSummary>(`/config/masters/${key}`, body),
  deactivateMaster: (key: string) => http.post<MasterSummary>(`/config/masters/${key}/deactivate`),
  activateMaster: (key: string) => http.post<MasterSummary>(`/config/masters/${key}/activate`),

  records: (key: string, p: RecordListParams) =>
    http.get<Page<RecordRow>>(`/masters/${key}/records`, { cursor: p.cursor ?? undefined, q: p.q || undefined, view: p.view, sort: p.sort, limit: p.limit ?? 50 }),
  record: (key: string, id: string) => http.get<RecordRow>(`/masters/${key}/records/${id}`),
  createRecord: (key: string, body: unknown) => http.post<RecordRow>(`/masters/${key}/records`, body),
  updateRecord: (key: string, id: string, body: unknown) => http.put<RecordRow>(`/masters/${key}/records/${id}`, body),
  deactivate: (key: string, id: string) => http.post<RecordRow>(`/masters/${key}/records/${id}/deactivate`),
  activate: (key: string, id: string) => http.post<RecordRow>(`/masters/${key}/records/${id}/activate`),
  remove: (key: string, id: string, reason: string) => api<void>(`/masters/${key}/records/${id}`, { method: 'DELETE', body: { reason } }),
  usage: (key: string, id: string) => http.get<RecordDeleteBlocked['usedBy']>(`/masters/${key}/records/${id}/usage`),

  template: (key: string) => downloadAuthed(`/masters/${key}/template.xlsx`, `${key}-template.xlsx`),
  export: (key: string, format: 'csv' | 'xlsx', view: RecordView) => downloadAuthed(`/masters/${key}/export?format=${format}&view=${view}`, `${key}.${format}`),
  import: (key: string, file: File, opts: { dryRun: boolean; mode: 'create' | 'upsert' }) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return postMultipart<ImportReport>(`/masters/${key}/import?dryRun=${opts.dryRun}&mode=${opts.mode}`, fd);
  },
};
