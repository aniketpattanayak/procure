'use client';
import { Badge, Button, EmptyState, Skeleton, SkeletonGroup } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { FormInput, Lock, PencilRuler } from 'lucide-react';
import Link from 'next/link';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { fmtRelative } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { formsApi } from '@/engines/form-builder/api';

/** /config/forms: every form definition (masters, the user form, later transactions) with draft/published state. */
export function FormsPage() {
  const p = usePermissions();
  const list = useQuery({ queryKey: ['config-forms'], queryFn: formsApi.list });
  if (p.ready && !p.has('config.forms:action.view')) {
    return <PageBody><EmptyState icon={<Lock />} title={t('forms.noAccess')} /></PageBody>;
  }
  const rows = [...(list.data ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return (
    <PageBody>
      <PageHeader title={t('forms.title')} description={t('forms.description')}
        actions={p.has('config.masters:action.view') && <Button asChild variant="secondary"><Link href="/config/masters">{t('forms.manageMasters')}</Link></Button>} />
      {list.isLoading ? (
        <SkeletonGroup className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12" />)}</SkeletonGroup>
      ) : !rows.length ? (
        <EmptyState icon={<FormInput />} title={t('forms.empty')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <table className="w-full" data-testid="forms-table">
            <thead className="bg-subtle text-left text-sm text-fg-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t('forms.colName')}</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">{t('forms.colKind')}</th>
                <th className="px-4 py-2 font-medium">{t('forms.colVersion')}</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">{t('forms.colUpdated')}</th>
                <th className="px-4 py-2"><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(f => (
                <tr key={f.key} className="border-t border-border" data-testid={`form-row-${f.key}`}>
                  <td className="px-4 py-2.5">
                    <Link href={`/config/forms/${f.key}`} className="font-medium hover:text-accent hover:underline">{f.name}</Link>
                    <code className="ml-2 text-xs text-fg-subtle">{f.key}</code>
                  </td>
                  <td className="hidden px-4 py-2.5 sm:table-cell"><Badge>{t(`forms.kind.${f.kind}` as 'forms.kind.master')}</Badge></td>
                  <td className="px-4 py-2.5">
                    <span className="tabular-nums">{f.currentVersion ? `v${f.currentVersion}` : '—'}</span>
                    {f.hasDraft && <Badge tone="warning" className="ml-2">{t('forms.draft')}</Badge>}
                  </td>
                  <td className="hidden px-4 py-2.5 text-fg-muted md:table-cell">{fmtRelative(f.updatedAt)}</td>
                  <td className="px-2 py-2.5 text-right">
                    <Button asChild size="sm" variant="ghost"><Link href={`/config/forms/${f.key}`}><PencilRuler aria-hidden />{t('forms.open')}</Link></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageBody>
  );
}
