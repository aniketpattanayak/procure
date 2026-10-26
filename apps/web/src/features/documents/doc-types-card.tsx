'use client';
import { Card, CardBody, CardHeader, Skeleton } from '@procure/ui';
import { FileText, Plus } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/i18n';
import { usePermissions } from '@/lib/permissions';
import { docTab, useDocTypes } from './api';

/** Dashboard: document types the user can open (replaces the Phase 1 plan-feature module list). */
export function DocTypesCard({ className }: { className?: string }) {
  const p = usePermissions();
  const types = useDocTypes();
  const list = (types.data ?? []).filter(d => d.isActive && p.can(docTab(d.key), 'view'));
  return (
    <Card className={className} data-testid="dashboard-doc-types">
      <CardHeader title={t('dashboard.modules')} description={t('docs.dashboard.hint')} />
      <CardBody>
        {types.isLoading ? (
          <div className="grid gap-2 sm:grid-cols-2">{[0, 1].map(i => <Skeleton key={i} className="h-11" />)}</div>
        ) : list.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {list.map(d => (
              <li key={d.key} className="flex items-center rounded border border-border hover:bg-subtle">
                <Link href={`/docs/${d.key}`} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5" data-testid={`dashboard-doc-${d.key}`}>
                  <FileText className="size-4 shrink-0 text-accent" aria-hidden />
                  <span className="truncate">{d.pluralName}</span>
                </Link>
                {p.can(docTab(d.key), 'add') && (
                  <Link href={`/docs/${d.key}/new`} className="mr-1.5 grid size-8 place-items-center rounded text-fg-muted hover:bg-muted hover:text-fg" aria-label={t('docs.list.new', { name: d.name })}>
                    <Plus className="size-4" aria-hidden />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-fg-muted">{t('dashboard.noModules')}</p>
        )}
      </CardBody>
    </Card>
  );
}
