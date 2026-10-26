'use client';
/**
 * Stock / store panels injected into the generic document screens (grn, rtv, issue_request, store_issue, store_return,
 * stock_transfer, stock_adjustment, stock_count, po) through features/documents/extensions. No per-tenant logic:
 * everything is gated by permissions, features and settings from /auth/me.
 */
import type { DocumentLineRow, DocumentRow } from '@procure/schema';
import { Badge, Button, EmptyState, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, History, PackageCheck, PackageMinus, PackagePlus, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { docKeys, docsApi } from '@/features/documents/api';
import { dec, fmtQty } from '@/features/documents/decimal';
import { registerDecisionPrefill, registerDocExtension, registerDocListAction, registerDocTab, type DocListActionProps } from '@/features/documents/extensions';
import { QtyCell } from '@/features/documents/status';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { STOCK_PERM, stockApi } from './api';
import { movementLabel } from './labels';
import { SnapshotDialog } from './snapshot-dialog';

const STOCK_DOCS = ['grn', 'rtv', 'store_issue', 'store_return', 'stock_transfer', 'stock_adjustment', 'stock_count'] as const;
const RECEIVABLE_PO = new Set(['approved', 'partially_approved', 'partially_received', 'received']);

/* ------------------------------------------------------------------ movements tab (every stock document) */

function MovementsPanel({ doc }: { doc: DocumentRow }) {
  const q = useQuery({ queryKey: [...docKeys.detail(doc.docTypeKey, doc.id), 'stock-movements', doc.version], queryFn: () => stockApi.ledger({ document: doc.id }, null, 500), retry: false });
  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  if (q.isError) return <InlineAlert>{isApiError(q.error) ? q.error.message : t('stock.loadFailed')}</InlineAlert>;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <EmptyState icon={<History />} title={t('stock.mvTab.empty')} description={t('stock.mvTab.emptyHint')} />;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[40rem] text-sm" data-testid="doc-stock-movements">
          <caption className="sr-only">{t('stock.mvTab.title')}</caption>
          <thead className="bg-subtle text-left text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.date')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.movement')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.item')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.location')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('stock.col.status')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.col.in')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.col.out')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('stock.col.balance')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(r => (
              <tr key={r.id} data-testid={`doc-mv-${r.movementType}-${r.lineNo ?? 0}`}>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-fg-muted">{fmtDateTime(r.at)}</td>
                <td className="px-3 py-2"><Badge tone="neutral">{movementLabel(r.movementType)}</Badge></td>
                <td className="px-3 py-2">{r.item.name}{r.lineNo ? <span className="text-fg-subtle"> · {t('stock.lineN', { n: r.lineNo })}</span> : null}</td>
                <td className="px-3 py-2">{r.node.name}{r.batchNo ? <span className="text-fg-subtle"> · {r.batchNo}</span> : null}</td>
                <td className="px-3 py-2">{t(`stock.status.${r.status}`)}</td>
                <td className="px-3 py-2 text-right"><QtyCell value={r.qtyIn} tone="success" /></td>
                <td className="px-3 py-2 text-right"><QtyCell value={r.qtyOut} tone="danger" /></td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtQty(r.balanceAfter)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button asChild variant="ghost" size="sm"><Link href={`/stock/ledger?document=${doc.id}`}><History aria-hidden />{t('stock.mvTab.openLedger')}</Link></Button>
    </div>
  );
}

const STOCK_DOC_SET = new Set<string>(STOCK_DOCS);
// Component-style tab: hidden unless the viewer holds stock view (gate fed by the tenant layout via setDocExtensionGate).
registerDocTab({
  key: 'stock-movements',
  order: 40,
  label: () => t('stock.mvTab.title'),
  visible: g => STOCK_DOC_SET.has(g.docType.key) && !!g.doc.number && g.has(STOCK_PERM.view),
  Component: ({ doc }) => <MovementsPanel doc={doc} />,
});

/* ------------------------------------------------------------------ links used as header actions */

function LinkAction({ href, perm, icon, label, testId, show = true }: { href: string; perm: string; icon: React.ReactNode; label: string; testId: string; show?: boolean }) {
  const p = usePermissions();
  if (!show || !p.has(perm)) return null;
  return <Button asChild variant="secondary"><Link href={href} data-testid={testId}>{icon}{label}</Link></Button>;
}

/* ------------------------------------------------------------------ GRN */

/** Ordered / received / pending of the PO line a GRN line receives against (from the PO document). */
function usePo(poId: unknown) {
  const id = typeof poId === 'string' ? poId : '';
  const p = usePermissions();
  return useQuery({ queryKey: docKeys.detail('po', id), queryFn: () => docsApi.get('po', id), enabled: !!id && p.has('doc.po:action.view'), staleTime: 30_000, retry: false });
}

function PoQty({ doc, line, k }: { doc: DocumentRow; line: DocumentLineRow; k: 'ordered' | 'received' | 'pendingReceipt' }) {
  const po = usePo(doc.values.po);
  const ref = typeof line.values.po_line === 'string' ? line.values.po_line : '';
  const pl = po.data?.lines.find(l => l.id === ref);
  if (!pl) return <span className="text-fg-subtle">—</span>;
  const v = k === 'ordered' ? (dec.gt0(pl.qty.ordered) ? pl.qty.ordered : pl.qty.approved) : pl.qty[k];
  return <QtyCell value={v} tone={k === 'pendingReceipt' && dec.gt0(v) ? 'warning' : undefined} testId={`grn-po-${k}-${line.lineNo}`} />;
}

registerDocExtension('grn', {
  actions: ctx => (
    <LinkAction href={`/stock/rtv?grn=${ctx.doc.id}`} perm={STOCK_PERM.rtvAdd} icon={<Undo2 aria-hidden />} label={t('rtv.action')} testId="grn-return-vendor"
      show={!!ctx.doc.number && ctx.doc.lines.some(l => dec.gt0(l.qty.accepted))} />
  ),
  lineColumns: ctx => [
    { key: 'po_ordered', label: t('grn.ordered'), align: 'right', cell: l => <PoQty doc={ctx.doc} line={l} k="ordered" /> },
    { key: 'po_received', label: t('grn.receivedPo'), align: 'right', cell: l => <PoQty doc={ctx.doc} line={l} k="received" /> },
    { key: 'po_pending', label: t('grn.pending'), align: 'right', cell: l => <PoQty doc={ctx.doc} line={l} k="pendingReceipt" /> },
    ...(ctx.doc.number ? [
      { key: 'accepted', label: t('grn.acceptedQty'), align: 'right' as const, cell: (l: DocumentLineRow) => <QtyCell value={l.qty.accepted} tone="success" testId={`grn-accepted-${l.lineNo}`} /> },
      { key: 'rejected_receipt', label: t('grn.rejectedAtReceipt'), align: 'right' as const, cell: (l: DocumentLineRow) => <QtyCell value={l.qty.rejectedAtReceipt} tone="danger" testId={`grn-rejected-${l.lineNo}`} /> },
      { key: 'returned', label: t('grn.returned'), align: 'right' as const, cell: (l: DocumentLineRow) => <QtyCell value={l.qty.returned} testId={`grn-returned-${l.lineNo}`} /> },
    ] : []),
  ],
  itemColumns: () => [
    { id: 'accepted', label: t('grn.acceptedQty'), width: 100, align: 'right', cell: r => <QtyCell value={r.qty.accepted} tone="success" /> },
    { id: 'rejected_receipt', label: t('grn.rejectedAtReceipt'), width: 110, align: 'right', cell: r => <QtyCell value={r.qty.rejectedAtReceipt} tone="danger" /> },
  ],
});

// First verification decision on a GRN line (whatever the tenant's first stage is): pre-fill the reject bucket with the
// receiver's rejected count and its reason. Later stages start from the default (approve all pending).
registerDecisionPrefill('grn', (_doc, line, _stage, pending) => {
  const rej = line.values.rejected_qty;
  if (!dec.gt0(rej) || dec.gt0(line.qty.approved) || dec.gt0(line.qty.rejected) || dec.cmp(pending, line.qty.requested) !== 0) return null;
  const reason = typeof line.values.reject_reason === 'string' && line.values.reject_reason.trim() ? line.values.reject_reason.trim() : t('grn.prefillReason');
  return { reject: dec.cmp(rej, pending) <= 0 ? String(rej) : pending, reason };
});

registerDocListAction('grn', {
  key: 'grn-receive', Component: ({ docType }: DocListActionProps) => (
    <LinkAction href="/stock/receive" perm={`doc.${docType.key}:action.add`} icon={<PackageCheck aria-hidden />} label={t('grn.receive.title')} testId="grn-receive-link" />
  ),
});

/* ------------------------------------------------------------------ PO: receive */

registerDocExtension('po', {
  actions: ctx => (
    <LinkAction href={`/stock/receive?po=${ctx.doc.id}`} perm={STOCK_PERM.grnAdd} icon={<PackageCheck aria-hidden />} label={t('grn.receiveAction')} testId="po-receive"
      show={!!ctx.doc.number && RECEIVABLE_PO.has(ctx.doc.statusKey)} />
  ),
});

/* ------------------------------------------------------------------ RTV */

registerDocListAction('rtv', {
  key: 'rtv-from-grn', Component: () => <LinkAction href="/stock/rtv" perm={STOCK_PERM.rtvAdd} icon={<Undo2 aria-hidden />} label={t('rtv.title')} testId="rtv-from-grn-link" />,
});

/* ------------------------------------------------------------------ issue request / store issue / store return */

registerDocExtension('issue_request', {
  actions: ctx => (
    <LinkAction href={`/stock/issue?request=${ctx.doc.id}`} perm={STOCK_PERM.issueAdd} icon={<PackageMinus aria-hidden />} label={t('issue.action')} testId="request-issue"
      show={!!ctx.doc.number && ctx.doc.lines.some(l => dec.gt0(dec.sub(dec.sub(l.qty.approved, l.qty.issued), l.qty.shortClosed)))} />
  ),
  lineColumns: ctx => (ctx.doc.number ? [
    { key: 'issued', label: t('issue.issued'), align: 'right', cell: l => <QtyCell value={l.qty.issued} tone="success" testId={`qty-issued-${l.lineNo}`} /> },
    { key: 'pending_issue', label: t('issue.pending'), align: 'right', cell: l => <QtyCell value={dec.max0(dec.sub(dec.sub(l.qty.approved, l.qty.issued), l.qty.shortClosed))} tone="warning" testId={`qty-pending-issue-${l.lineNo}`} /> },
  ] : []),
  itemColumns: () => [{ id: 'issued', label: t('issue.issued'), width: 96, align: 'right', cell: r => <QtyCell value={r.qty.issued} tone="success" /> }],
});

function IssueListAction() {
  return <LinkAction href="/stock/issue" perm={STOCK_PERM.issueAdd} icon={<PackageMinus aria-hidden />} label={t('issue.title')} testId="issue-against-requests-link" />;
}
registerDocListAction('store_issue', { key: 'issue-from-requests', Component: IssueListAction });

registerDocExtension('store_issue', {
  actions: ctx => (
    <LinkAction href={`/stock/return?issue=${ctx.doc.id}`} perm={STOCK_PERM.returnAdd} icon={<PackagePlus aria-hidden />} label={t('return.action')} testId="issue-return"
      show={!!ctx.doc.number && ctx.doc.lines.some(l => dec.gt0(dec.sub(l.qty.approved, l.qty.returned)))} />
  ),
  lineColumns: ctx => (ctx.doc.number ? [{ key: 'returned', label: t('return.returned'), align: 'right', cell: l => <QtyCell value={l.qty.returned} testId={`qty-returned-${l.lineNo}`} /> }] : []),
});

registerDocListAction('store_return', {
  key: 'return-from-issues', Component: () => <LinkAction href="/stock/return" perm={STOCK_PERM.returnAdd} icon={<PackagePlus aria-hidden />} label={t('return.title')} testId="return-from-issues-link" />,
});

/* ------------------------------------------------------------------ stock count */

function CountSnapshotAction() {
  const p = usePermissions();
  const [open, setOpen] = useState(false);
  if (!p.has(STOCK_PERM.countAdd)) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="count-snapshot-link"><ClipboardCheck aria-hidden />{t('stock.count.start')}</Button>
      {open && <SnapshotDialog onClose={() => setOpen(false)} />}
    </>
  );
}
registerDocListAction('stock_count', { key: 'count-snapshot', Component: CountSnapshotAction });

registerDocExtension('stock_count', {
  actions: ctx => <Button asChild variant={ctx.doc.allowedActions.includes('edit') ? 'primary' : 'secondary'}><Link href={`/stock/count/${ctx.doc.id}`} data-testid="count-sheet-link"><ClipboardCheck aria-hidden />{t('stock.count.openSheet')}</Link></Button>,
});
