'use client';
import { Card, CardBody, CardHeader, cn, Skeleton } from '@procure/ui';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { t } from '@/i18n';
import { usePermissions } from '@/lib/permissions';
import { useInboxCounts } from './use-inbox-counts';

/** Dashboard: approvals waiting for me, every count links into the filtered inbox. */
export function ApprovalsWidget({ className }: { className?: string }) {
  const p = usePermissions();
  const can = p.has('approvals:action.view');
  const counts = useInboxCounts(can);
  if (!can) return null;
  const c = counts.data;
  return (
    <Card className={className} data-testid="inbox-widget">
      <CardHeader title={t('inbox.widget.title')} actions={<Link href="/approvals" className="text-sm text-accent hover:underline">{t('inbox.widget.open')}</Link>} />
      <CardBody className="space-y-4">
        {counts.isLoading ? (
          <div className="space-y-2"><Skeleton className="h-10 w-24" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
        ) : counts.isError ? (
          <p className="text-fg-muted">{t('inbox.error')}</p>
        ) : (
          <>
            <div className="flex items-end gap-6">
              <Link href="/approvals" className="group" data-testid="inbox-widget-total">
                <span className="block text-3xl font-semibold leading-none tabular-nums group-hover:text-accent">{c?.total ?? 0}</span>
                <span className="text-sm text-fg-muted">{t('inbox.widget.waiting')}</span>
              </Link>
              <Link href="/approvals?overdue=1" className="group" data-testid="inbox-widget-overdue">
                <span className={cn('block text-3xl font-semibold leading-none tabular-nums', c?.overdue ? 'text-danger' : 'text-fg-subtle')}>{c?.overdue ?? 0}</span>
                <span className="text-sm text-fg-muted group-hover:text-fg">{t('inbox.widget.overdue')}</span>
              </Link>
            </div>
            {c && c.byType.length > 0 ? (
              <ul className="divide-y divide-border rounded border border-border">
                {c.byType.map(b => (
                  <li key={`${b.docTypeKey}:${b.stageKey}`}>
                    <Link href={`/approvals?docType=${encodeURIComponent(b.docTypeKey)}&stage=${encodeURIComponent(b.stageKey)}`} className="flex items-center gap-3 px-3 py-2 hover:bg-subtle" data-testid={`inbox-widget-${b.docTypeKey}-${b.stageKey}`}>
                      <span className="min-w-0 flex-1 truncate">{b.name} <span className="text-fg-muted">· {b.stageName}</span></span>
                      {b.overdue > 0 && <span className="rounded-full bg-danger-soft px-1.5 text-xs font-semibold text-danger tabular-nums">{b.overdue}</span>}
                      <span className="font-semibold tabular-nums">{b.count}</span>
                      <ChevronRight className="size-4 text-fg-subtle" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg-muted">{t('inbox.widget.clear')}</p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}
