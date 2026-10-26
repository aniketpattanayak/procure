'use client';
import { Badge, Button, EmptyState, Skeleton, SkeletonGroup } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { FileStack, Workflow } from 'lucide-react';
import Link from 'next/link';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { usePermissions } from '@/lib/permissions';
import { workflowsApi } from './api';

/** /config/workflows: every document type with its approval workflow state. */
export function WorkflowsPage() {
  const p = usePermissions();
  const list = useQuery({ queryKey: ['wf-list'], queryFn: workflowsApi.list });
  const rows = [...(list.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <PageBody>
      <PageHeader title={t('wf.listTitle')} description={t('wf.listDescription')}
        actions={p.has('config.doc_types:action.view') && <Button asChild variant="secondary"><Link href="/config/doc-types"><FileStack aria-hidden />{t('wf.manageDocTypes')}</Link></Button>} />
      {list.isLoading ? (
        <SkeletonGroup className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-14" />)}</SkeletonGroup>
      ) : list.error ? (
        <EmptyState title={t('table.error')} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
      ) : !rows.length ? (
        <EmptyState icon={<Workflow />} title={t('wf.listEmpty')} description={t('wf.listEmptyHint')}
          action={p.has('config.doc_types:action.add') ? <Button asChild><Link href="/config/doc-types?new=1">{t('dt.new')}</Link></Button> : undefined} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <table className="w-full" data-testid="wf-table">
            <thead className="bg-subtle text-left text-sm text-fg-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t('wf.col.docType')}</th>
                <th className="px-4 py-2 font-medium">{t('wf.col.published')}</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">{t('wf.col.stages')}</th>
                <th className="px-4 py-2"><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.docTypeKey} className="border-t border-border" data-testid={`wf-row-${r.docTypeKey}`}>
                  <td className="px-4 py-2.5">
                    <Link href={`/config/workflows/${r.docTypeKey}`} className="font-medium hover:text-accent hover:underline">{r.name}</Link>
                    <code className="ml-2 text-xs text-fg-subtle">{r.docTypeKey}</code>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="tabular-nums">{r.publishedVersion ? `v${r.publishedVersion}` : <span className="text-fg-subtle">{t('wf.notPublished')}</span>}</span>
                    {r.hasDraft && <Badge tone="warning" className="ml-2" data-testid={`wf-draft-${r.docTypeKey}`}>{t('wf.draftBadge')}</Badge>}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right tabular-nums sm:table-cell">
                    {r.stageCount === 0 ? <span className="text-fg-subtle">{t('wf.autoApprove')}</span> : r.stageCount}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <Button asChild size="sm" variant="ghost"><Link href={`/config/workflows/${r.docTypeKey}`} data-testid={`wf-open-${r.docTypeKey}`}><Workflow aria-hidden />{t('wf.design')}</Link></Button>
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
