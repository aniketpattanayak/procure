'use client';
import type { RenderableForm } from '@procure/schema';
import { Skeleton } from '@procure/ui';
import dynamic from 'next/dynamic';
import { useMemo, type RefObject } from 'react';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import type { FormRendererHandle } from '@/engines/form-renderer/form-renderer';
import { useRenderableForm } from '@/engines/form-renderer/render-api';
import { errorsFromProblem, type ErrorMap } from '@/engines/form-renderer/validation';

const FormRenderer = dynamic(() => import('@/engines/form-renderer/form-renderer').then(m => m.FormRenderer), {
  ssr: false,
  loading: () => <div className="space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-9" /></div>,
});

/** The tenant's `user` form minus its system fields (name, email, phone, reporting manager are edited natively). */
export function useUserCustomForm(): { form: RenderableForm | null; loading: boolean } {
  const q = useRenderableForm('user');
  const form = useMemo<RenderableForm | null>(() => {
    if (!q.data) return null;
    const fields = q.data.definition.fields.filter(f => !('system' in f && f.system));
    // Keep layout only if some data field survives.
    const hasData = fields.some(f => !['tab', 'section', 'divider', 'help'].includes(f.type) && !f.removed);
    return hasData ? { ...q.data, definition: { ...q.data.definition, fields } } : null;
  }, [q.data]);
  return { form, loading: q.isLoading };
}

/** Server errors for `custom.<field>` paths, keyed by field for the renderer. */
export function customErrorsFrom(e: unknown): ErrorMap {
  if (!isApiError(e)) return {};
  const map = errorsFromProblem(e.errors.filter(x => x.path.startsWith('custom.')).map(x => ({ ...x, path: x.path.slice(7) })));
  if (e.code === 'FIELD_READ_ONLY' && typeof e.meta.field === 'string') map[e.meta.field.replace(/^custom\./, '')] = e.message;
  return map;
}

export function UserCustomFields({ form, value, onChange, errors, handleRef }: {
  form: RenderableForm;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  errors?: ErrorMap;
  handleRef: RefObject<FormRendererHandle | null>;
}) {
  return (
    <section aria-labelledby="user-custom-heading" className="space-y-3 border-t border-border pt-4" data-testid="user-custom-fields">
      <h3 id="user-custom-heading" className="text-sm font-semibold">{t('users.customFields')}</h3>
      <FormRenderer ref={handleRef} form={form} value={value} onChange={onChange} errors={errors} idPrefix="uc" />
    </section>
  );
}
