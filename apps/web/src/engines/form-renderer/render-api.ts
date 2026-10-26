'use client';
import type { RenderableForm } from '@procure/schema';
import { useQuery } from '@tanstack/react-query';
import { http } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

export const renderApi = {
  get: (formKey: string, versionId?: string | null) => http.get<RenderableForm>(`/forms/${formKey}/render`, { versionId: versionId ?? undefined }),
};

/** GET /forms/:formKey/render (cached per permission version, since hidden/read-only fields depend on it). */
export function useRenderableForm(formKey: string | null | undefined, versionId?: string | null, enabled = true) {
  const { version } = usePermissions();
  return useQuery({
    queryKey: ['form-render', formKey, versionId ?? 'current', version],
    queryFn: () => renderApi.get(formKey!, versionId),
    enabled: !!formKey && enabled,
    staleTime: 5 * 60_000,
  });
}
