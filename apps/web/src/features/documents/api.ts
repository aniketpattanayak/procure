'use client';
/**
 * Documents + workflow runtime client (docs/contracts/phase-3-api.md). One place for paths and query keys so lists,
 * detail, approval screen and inbox invalidate each other consistently.
 */
import type {
  AttachmentRow, CommentRow, DocListRow, DocTypeSummary, DocumentRow, InboxCounts, InboxItem, ItemListRow, Page,
  SavedViewRow, TimelineEntry, WorkflowActionInput,
} from '@procure/schema';
import { z } from 'zod';
import { SavedViewInput } from '@procure/schema';
import { useQuery } from '@tanstack/react-query';
import { api, http } from '@/lib/api';
import { asArray } from '@/lib/types';
import { usePermissions } from '@/lib/permissions';

export type ListView = 'document' | 'item';

/** List filters as they live in the URL and in saved views (`DocListQuery` minus paging). */
export interface DocListFilters {
  view: ListView;
  status?: string;          // single status view key; undefined = every status the caller holds
  q?: string;
  location?: string;        // node id; 'all' = explicitly all (overrides the top-bar location)
  from?: string;
  to?: string;
  item?: string;
  sort?: string;
  /** Active saved view: the server applies its columns (custom column values come back only for those). */
  savedView?: string;
}

export interface StatusCount { statusKey: string; label: string; count: number }
export interface DocWriteBody { values: Record<string, unknown>; lines: { id?: string; values: Record<string, unknown> }[] }
export interface UserOption { id: string; name: string; email: string }

function listQuery(f: DocListFilters, extra: Record<string, string | number | undefined> = {}) {
  return {
    view: f.view,
    status: f.status,
    q: f.q?.trim() || undefined,
    location: f.location && f.location !== 'all' ? f.location : undefined,
    from: f.from,
    to: f.to,
    item: f.item,
    sort: f.sort,
    savedView: f.savedView,
    ...extra,
  };
}

const enc = encodeURIComponent;

export const docsApi = {
  types: () => http.get<DocTypeSummary[]>('/doc-types'),
  list: (type: string, f: DocListFilters, cursor: string | null, limit = 50) =>
    http.get<Page<DocListRow | ItemListRow>>(`/docs/${enc(type)}`, listQuery(f, { cursor: cursor ?? undefined, limit })),
  counts: (type: string, f: DocListFilters) => http.get<StatusCount[]>(`/docs/${enc(type)}/counts`, listQuery({ ...f, status: undefined })),
  get: (type: string, id: string) => http.get<DocumentRow>(`/docs/${enc(type)}/${enc(id)}`),
  create: (type: string, body: DocWriteBody) => http.post<DocumentRow>(`/docs/${enc(type)}`, body),
  update: (type: string, id: string, body: DocWriteBody & { version: number }) => http.put<DocumentRow>(`/docs/${enc(type)}/${enc(id)}`, body),
  remove: (type: string, id: string) => http.del<void>(`/docs/${enc(type)}/${enc(id)}`),
  submit: (type: string, id: string, version: number) => http.post<DocumentRow>(`/docs/${enc(type)}/${enc(id)}/submit`, { version }),
  cancel: (type: string, id: string, body: { reason: string; lineIds?: string[] }) => http.post<DocumentRow>(`/docs/${enc(type)}/${enc(id)}/cancel`, body),
  close: (type: string, id: string, body: { reason: string; lineIds?: string[] }) => http.post<DocumentRow>(`/docs/${enc(type)}/${enc(id)}/close`, body),
  copy: (type: string, id: string) => http.post<DocumentRow>(`/docs/${enc(type)}/${enc(id)}/copy`),
  timeline: (type: string, id: string) => http.get<TimelineEntry[]>(`/docs/${enc(type)}/${enc(id)}/timeline`),
  comments: (type: string, id: string) => http.get<CommentRow[]>(`/docs/${enc(type)}/${enc(id)}/comments`),
  addComment: (type: string, id: string, body: { body: string; parentId?: string }) => http.post<CommentRow>(`/docs/${enc(type)}/${enc(id)}/comments`, body),
  editComment: (type: string, id: string, cid: string, body: { body: string }) => http.put<CommentRow>(`/docs/${enc(type)}/${enc(id)}/comments/${enc(cid)}`, body),
  deleteComment: (type: string, id: string, cid: string) => http.del<void>(`/docs/${enc(type)}/${enc(id)}/comments/${enc(cid)}`),
  attachments: (type: string, id: string) => http.get<AttachmentRow[]>(`/docs/${enc(type)}/${enc(id)}/attachments`),
  attach: (type: string, id: string, body: { fileId: string; note?: string }) => http.post<AttachmentRow>(`/docs/${enc(type)}/${enc(id)}/attachments`, body),
  detach: (type: string, id: string, attId: string) => http.del<void>(`/docs/${enc(type)}/${enc(id)}/attachments/${enc(attId)}`),
  /** Workflow runtime action. `If-Match` = document version; `Idempotency-Key` makes retries safe. */
  act: (type: string, id: string, body: WorkflowActionInput, opts: { version?: number; idempotencyKey: string }) =>
    api<DocumentRow>(`/docs/${enc(type)}/${enc(id)}/actions`, {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': opts.idempotencyKey, ...(opts.version !== undefined ? { 'If-Match': String(opts.version) } : {}) },
    }),
  userOptions: (q: string, signal?: AbortSignal) => http.get<UserOption[]>('/users/options', { q: q.trim() || undefined, limit: 20 }, signal),
};

export type SavedViewBody = z.input<typeof SavedViewInput>;
export const savedViewsApi = {
  list: async (scopeKey: string) => asArray(await http.get<SavedViewRow[] | Page<SavedViewRow>>('/saved-views', { scope: scopeKey })),
  create: (body: SavedViewBody) => http.post<SavedViewRow>('/saved-views', body),
  update: (id: string, body: SavedViewBody & { version: number }) => http.put<SavedViewRow>(`/saved-views/${enc(id)}`, body),
  remove: (id: string) => http.del<void>(`/saved-views/${enc(id)}`),
};

export const approvalsApi = {
  list: (q: { docType?: string; stage?: string; overdue?: boolean; cursor?: string | null; limit?: number }) =>
    http.get<Page<InboxItem>>('/approvals', { docType: q.docType, stage: q.stage, overdue: q.overdue ? true : undefined, cursor: q.cursor ?? undefined, limit: q.limit ?? 50 }),
  counts: () => http.get<InboxCounts>('/approvals/counts'),
};

export const docKeys = {
  types: ['doc-types'] as const,
  all: (type: string) => ['docs', type] as const,
  counts: (type: string, f: DocListFilters) => ['docs', type, 'counts', listQuery({ ...f, status: undefined })] as const,
  detail: (type: string, id: string) => ['docs', type, 'detail', id] as const,
  timeline: (type: string, id: string) => ['docs', type, 'detail', id, 'timeline'] as const,
  comments: (type: string, id: string) => ['docs', type, 'detail', id, 'comments'] as const,
  attachments: (type: string, id: string) => ['docs', type, 'detail', id, 'attachments'] as const,
  savedViews: (scope: string) => ['saved-views', scope] as const,
  inbox: ['approvals'] as const,
  inboxCounts: ['approvals', 'counts'] as const,
};

/** Tab key for a document type's permissions. */
export const docTab = (type: string) => `doc.${type}`;

/** GET /doc-types (types the caller can view), cached per permission version. */
export function useDocTypes(enabled = true) {
  const { version, ready } = usePermissions();
  return useQuery({ queryKey: [...docKeys.types, version], queryFn: docsApi.types, enabled: enabled && ready, staleTime: 5 * 60_000, retry: false });
}

export function useDocType(key: string) {
  const q = useDocTypes();
  return { ...q, docType: q.data?.find(d => d.key === key) ?? null };
}

/** Fresh idempotency key (one per user intent; reused for retries of that intent). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
