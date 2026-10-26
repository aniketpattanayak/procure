import type {
  FormDefinition, FormDefinitionIssue, FormDetail, FormSummary, FormVersionRow, MasterSummary,
} from '@procure/schema';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { http } from '@/lib/api';
import { asArray } from '@/lib/types';

export const formsApi = {
  list: async () => asArray(await http.get<FormSummary[] | { data: FormSummary[] }>('/config/forms')),
  get: (formKey: string) => http.get<FormDetail>(`/config/forms/${formKey}`),
  saveDraft: (formKey: string, definition: FormDefinition, version: number) => http.put<FormDetail>(`/config/forms/${formKey}/draft`, { definition, version }),
  discardDraft: (formKey: string) => http.del<FormDetail>(`/config/forms/${formKey}/draft`),
  publish: (formKey: string, version: number, changeNote?: string) => http.post<FormDetail>(`/config/forms/${formKey}/publish`, { version, changeNote: changeNote || undefined }),
  versions: (formKey: string) => http.get<FormVersionRow[]>(`/config/forms/${formKey}/versions`),
  version: (formKey: string, version: number) => http.get<FormDefinition>(`/config/forms/${formKey}/versions/${version}`),
  validate: (definition: FormDefinition, formKey?: string) => http.post<{ issues: FormDefinitionIssue[] }>('/config/forms/validate', { definition, formKey }),
};

export const mastersListApi = {
  list: () => http.get<MasterSummary[]>('/masters'),
};

export function useMastersList() {
  return useQuery({ queryKey: ['masters'], queryFn: mastersListApi.list, staleTime: 60_000 });
}

/** Published definitions of the masters that lookups in `def` point to (for pickers and formula attributes). */
export function useTargetForms(masterKeys: string[]) {
  const masters = useMastersList();
  const byKey = useMemo(() => new Map((masters.data ?? []).map(m => [m.key, m])), [masters.data]);
  const keys = [...new Set(masterKeys)].filter(k => byKey.has(k)).sort();
  const results = useQueries({
    queries: keys.map(k => ({
      queryKey: ['config-form', byKey.get(k)!.formKey],
      queryFn: () => formsApi.get(byKey.get(k)!.formKey),
      staleTime: 60_000,
    })),
  });
  const forms = useMemo(() => {
    const m = new Map<string, FormDefinition | null>();
    keys.forEach((k, i) => { const d = results[i]?.data; m.set(k, d?.published ?? d?.draft ?? null); });
    return m;
  }, [keys.join(','), results.map(r => r.dataUpdatedAt).join(',')]);
  return { masters, byKey, forms };
}
