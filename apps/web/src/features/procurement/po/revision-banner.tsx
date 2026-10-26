'use client';
import type { DocumentRow, RevisionRow } from '@procure/schema';
import { Button } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { t } from '@/i18n';
import { procApi, procKeys } from '../api';
import { revNoOf } from './revisions-panel';

/**
 * Revision state of a PO. `DocumentRow` may carry `revNo` (contract: "Rev 2" on the PO); when it doesn't, the
 * revisions list is the source: an `open` revision = amendment in progress / in approval, else the latest approved.
 */
export function usePoRevision(doc: DocumentRow): { current: number; open: RevisionRow | null } {
  const q = useQuery({ queryKey: procKeys.revisions(doc.id), queryFn: () => procApi.revisions(doc.id), enabled: !!doc.number, retry: false, staleTime: 15_000 });
  const rows = q.data ?? [];
  const open = rows.find(r => r.status === 'open') ?? null;
  const approved = rows.filter(r => r.status === 'approved').reduce((m, r) => Math.max(m, r.revNo), 0);
  return { current: Math.max(revNoOf(doc), approved), open };
}

/** "Rev 2 · being amended" strip on the PO detail and edit pages; quieter "Rev 2 is in force" once approved. */
export function RevisionBanner({ doc, editing, onOpenRevisions }: { doc: DocumentRow; editing?: boolean; onOpenRevisions?: () => void }) {
  const { current, open } = usePoRevision(doc);
  const amending = doc.statusKey === 'amending' || !!open;
  if (!amending && current === 0) return null;
  if (!amending) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted" data-testid="amend-banner" data-rev={current} data-state="settled">
        <History className="size-4" aria-hidden />
        <span>{t('po.rev.settled', { n: current })}</span>
        {onOpenRevisions && <Button variant="link" size="sm" onClick={onOpenRevisions}>{t('po.rev.see')}</Button>}
      </div>
    );
  }
  const next = open?.revNo ?? current + 1;
  const inApproval = doc.statusKey !== 'amending';
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-warning sm:flex-row sm:items-center" data-testid="amend-banner" data-rev={next} data-state={inApproval ? 'in_approval' : 'amending'}>
      <History className="hidden size-5 shrink-0 sm:block" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{inApproval ? t('po.amend.bannerApprovalTitle', { n: next }) : t('po.amend.bannerTitle', { n: next })}</p>
        <p className="text-sm">{inApproval ? t('po.amend.bannerApproval') : editing ? t('po.amend.bannerEdit') : t('po.amend.bannerView')}</p>
      </div>
      {onOpenRevisions && <Button variant="secondary" size="sm" onClick={onOpenRevisions} data-testid="amend-banner-revisions">{t('po.rev.see')}</Button>}
    </div>
  );
}
