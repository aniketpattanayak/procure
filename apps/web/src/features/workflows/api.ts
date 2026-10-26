'use client';
import type {
  DocTypeSummary, FormDefinition, FormDetail, RenderableForm, SimulateResult, WorkflowDefinition, WorkflowDetail,
} from '@procure/schema';
import { useQuery } from '@tanstack/react-query';
import { http, isApiError } from '@/lib/api';
import { asArray } from '@/lib/types';
import { rolesApi } from '@/features/users/api';

/** GET /config/workflows row (contract: phase-3-api.md, Workflow). */
export interface WorkflowListRow { docTypeKey: string; name: string; publishedVersion: number | null; hasDraft: boolean; stageCount: number }
export interface WorkflowVersionRow { version: number; publishedAt: string; publishedBy?: string | null; publishedByName?: string | null; changeNote: string | null; id?: string }
export interface UserOption { id: string; name: string; email: string }

export const workflowsApi = {
  list: async () => asArray(await http.get<WorkflowListRow[] | { data: WorkflowListRow[] }>('/config/workflows')),
  get: (docType: string) => http.get<WorkflowDetail>(`/config/workflows/${docType}`),
  saveDraft: (docType: string, definition: WorkflowDefinition, version: number) => http.put<WorkflowDetail>(`/config/workflows/${docType}/draft`, { definition, version }),
  discardDraft: (docType: string) => http.del<WorkflowDetail>(`/config/workflows/${docType}/draft`),
  publish: (docType: string, version: number, changeNote?: string) => http.post<WorkflowDetail>(`/config/workflows/${docType}/publish`, { version, changeNote: changeNote || undefined }),
  versions: async (docType: string) => asArray(await http.get<WorkflowVersionRow[] | { data: WorkflowVersionRow[] }>(`/config/workflows/${docType}/versions`)),
  version: (docType: string, v: number) => http.get<WorkflowDefinition>(`/config/workflows/${docType}/versions/${v}`),
  simulate: (docType: string, body: { values: Record<string, unknown>; lines: Record<string, unknown>[]; useDraft: boolean }) =>
    http.post<SimulateResult>(`/config/workflows/${docType}/simulate`, body),
};

export const docTypesListApi = {
  list: async () => asArray(await http.get<DocTypeSummary[] | { data: DocTypeSummary[] }>('/doc-types')),
};

export function useDocTypes() {
  return useQuery({ queryKey: ['doc-types'], queryFn: docTypesListApi.list, staleTime: 30_000 });
}

export function useRoles() {
  return useQuery({ queryKey: ['roles'], queryFn: rolesApi.list, staleTime: 60_000 });
}

/** Active users for pickers (GET /users/options). The first 100 are cached so saved ids resolve to names. */
export function useUserOptions(q = '') {
  return useQuery({
    queryKey: ['user-options', q],
    queryFn: () => http.get<UserOption[]>('/users/options', { q: q.trim() || undefined, limit: q ? 30 : 100 }),
    staleTime: 60_000,
  });
}

/**
 * Definition of a document type's header or line form for the designer: the config draft (what the admin is
 * building) when readable, else the published renderable form. Null when the form doesn't exist.
 */
export async function loadFormDefinition(formKey: string): Promise<FormDefinition | null> {
  try {
    const d = await http.get<FormDetail>(`/config/forms/${formKey}`);
    return d.draft ?? d.published ?? null;
  } catch (e) {
    if (!isApiError(e) || (e.status !== 403 && e.status !== 404)) throw e;
  }
  try {
    const r = await http.get<RenderableForm>(`/forms/${formKey}/render`);
    return r.definition;
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
}

export function useFormDefinition(formKey: string | null | undefined) {
  return useQuery({ queryKey: ['wf-form-def', formKey], queryFn: () => loadFormDefinition(formKey!), enabled: !!formKey, staleTime: 60_000, retry: false });
}
