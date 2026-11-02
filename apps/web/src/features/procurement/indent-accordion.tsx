'use client';
import type { DocumentLineRow, DocumentRow } from '@procure/schema';
import { Button, cn, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, Scale } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { docKeys, docsApi } from '@/features/documents/api';
import { dec, fmtQty } from '@/features/documents/decimal';
import { lineItemLabel, lineUom } from '@/features/documents/lines-table';
import { t } from '@/i18n';
import { LineVendorLog } from './quotes/quote-panel';

const useDoc = (type: string, id: string) =>
  useQuery({ queryKey: docKeys.detail(type, id), queryFn: () => docsApi.get(type, id), staleTime: 15_000 });

/** Vendor log is for approved (or partly approved) qty, like the Vendor quotes tab. */
const vendorLogOk = (type: string, l: DocumentLineRow) =>
  type === 'indent' && !!l.values.item && dec.gt0(dec.add(l.qty.approved, l.qty.overApproved));

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Indents list, Documents view: the indent's items under its row; each approved item can open its vendor log. */
export function IndentAccordion({ type, docId }: { type: string; docId: string }) {
  const q = useDoc(type, docId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  if (q.isError || !q.data) return <InlineAlert>{(q.error as Error)?.message ?? t('docs.acc.loadFailed')}</InlineAlert>;
  const doc = q.data;
  const lines = [...doc.lines].sort((a, b) => a.lineNo - b.lineNo);
  const toggle = (id: string) => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const th = 'px-2 py-1.5 font-medium';
  const num = 'px-2 py-1.5 text-right tabular-nums';
  return (
    <div className="space-y-2" onClick={stop} data-testid={`indent-acc-${doc.number ?? doc.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{t('docs.acc.items', { n: lines.length })}</p>
        <Button asChild size="sm" variant="secondary"><Link href={`/docs/${type}/${doc.id}`} data-testid="indent-acc-view"><ExternalLink aria-hidden />{t('docs.acc.view')}</Link></Button>
      </div>
      <div className="overflow-x-auto rounded border border-border bg-surface">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-subtle text-xs text-fg-muted">
            <tr>
              <th className={cn(th, 'w-10 text-right')}>#</th>
              <th className={cn(th, 'text-left')}>{t('docs.col.item')}</th>
              <th className={cn(th, 'text-left')}>{t('docs.acc.uom')}</th>
              <th className={cn(th, 'text-right')}>{t('docs.qty.requested')}</th>
              <th className={cn(th, 'text-right')}>{t('docs.qty.approved')}</th>
              <th className={cn(th, 'text-right')}>{t('docs.qty.held')}</th>
              <th className={cn(th, 'text-right')}>{t('docs.qty.rejected')}</th>
              <th className={cn(th, 'text-right')}>{t('docs.qty.pending')}</th>
              <th className={cn(th, 'w-36 text-right')}>{t('docs.acc.vendorLog')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.map(l => {
              const on = open.has(l.id);
              const can = vendorLogOk(type, l);
              const orig = typeof l.values.qty === 'string' || typeof l.values.qty === 'number' ? String(l.values.qty) : l.qty.requested;
              return (
                <Fragment key={l.id}>
                  <tr className={cn(on && 'bg-accent-soft/40')}>
                    <td className="px-2 py-1.5 text-right tabular-nums text-fg-subtle">{l.lineNo}</td>
                    <td className="px-2 py-1.5">{lineItemLabel(l)}</td>
                    <td className="px-2 py-1.5 text-fg-muted">{lineUom(l)}</td>
                    <td className={num}>{fmtQty(orig)}</td>
                    <td className={cn(num, 'text-success')}>{fmtQty(l.qty.approved)}</td>
                    <td className={cn(num, 'text-warning')}>{fmtQty(l.qty.held)}</td>
                    <td className={cn(num, 'text-danger')}>{fmtQty(l.qty.rejected)}</td>
                    <td className={num}>{fmtQty(l.qty.pendingApproval)}</td>
                    <td className="px-2 py-1 text-right">
                      {can ? (
                        <Button size="sm" variant={on ? 'primary' : 'secondary'} onClick={() => toggle(l.id)} aria-expanded={on} data-testid={`indent-acc-vlog-${l.lineNo}`}>
                          {on ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}{t('docs.acc.vendorLog')}
                        </Button>
                      ) : <span className="text-xs text-fg-subtle">{t('docs.acc.notApproved')}</span>}
                    </td>
                  </tr>
                  {on && can && (
                    <tr>
                      <td colSpan={9} className="bg-subtle/60 px-3 py-3"><LineVendorLog doc={doc} line={l} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Indents list, Items view: that one item's vendor log under its row. */
export function ItemVendorLog({ type, docId, lineId }: { type: string; docId: string; lineId: string }) {
  const q = useDoc(type, docId);
  if (q.isLoading) return <Skeleton className="h-24 w-full" />;
  if (q.isError || !q.data) return <InlineAlert>{(q.error as Error)?.message ?? t('docs.acc.loadFailed')}</InlineAlert>;
  const doc: DocumentRow = q.data;
  const line = doc.lines.find(l => l.id === lineId);
  return (
    <div className="space-y-2" onClick={stop} data-testid={`item-acc-${doc.number ?? doc.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{line ? `${t('docs.acc.vendorLog')} · ${lineItemLabel(line)}` : t('docs.acc.vendorLog')}</p>
        <Button asChild size="sm" variant="secondary"><Link href={`/docs/${type}/${doc.id}`}><ExternalLink aria-hidden />{t('docs.acc.view')}</Link></Button>
      </div>
      {line && vendorLogOk(type, line) ? <LineVendorLog doc={doc} line={line} />
        : <p className="flex items-center gap-2 text-sm text-fg-muted"><Scale className="size-4" aria-hidden />{t('docs.acc.notApprovedLong')}</p>}
    </div>
  );
}
