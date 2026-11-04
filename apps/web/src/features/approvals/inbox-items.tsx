'use client';
import type { DocumentLineRow, DocumentRow, InboxItem } from '@procure/schema';
import { Button, Checkbox, cn, EmptyState, Input, Skeleton, toast } from '@procure/ui';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useCallback, useMemo, useState } from 'react';
import { docKeys, docsApi, newIdempotencyKey } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { lineItemLabel, lineUom } from '@/features/documents/lines-table';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { ItemContextPanel, LineHistory } from './approve-screen';
import { ConfirmDecisionDialog, type ConfirmRow, type DecisionKind } from './confirm-dialog';

interface ItemRow { key: string; i: InboxItem; doc: DocumentRow; line: DocumentLineRow; pending: string }

export function InboxItemsView({ rows }: { rows: InboxItem[] }) {
  const qc = useQueryClient();
  const details = useQueries({
    queries: rows.map(i => ({ queryKey: docKeys.detail(i.docTypeKey, i.documentId), queryFn: () => docsApi.get(i.docTypeKey, i.documentId), staleTime: 15_000 })),
  });
  const loading = details.some(d => d.isLoading);

  const items = useMemo(() => {
    const out: ItemRow[] = [];
    rows.forEach((i, idx) => {
      const doc = details[idx]?.data;
      if (!doc) return;
      for (const line of [...doc.lines].sort((a, b) => a.lineNo - b.lineNo)) {
        const pending = line.stages?.[i.stageKey]?.pending;
        if (dec.gt0(pending)) out.push({ key: `${i.documentId}:${i.stageKey}:${line.id}`, i, doc, line, pending: pending! });
      }
    });
    return out;
  }, [rows, details]);

  const [qtys, setQtys] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: DecisionKind; picked: ItemRow[]; rows: ConfirmRow[] } | null>(null);

  const typed = (k: string) => (qtys[k] ?? '').trim() !== '';
  const allOn = items.length > 0 && items.every(r => typed(r.key));
  const someOn = items.some(r => typed(r.key));
  const toggle = (r: ItemRow) => setQtys(q => {
    const n = { ...q };
    if (typed(r.key)) delete n[r.key]; else n[r.key] = r.pending;
    return n;
  });
  const toggleAll = () => setQtys(allOn ? {} : Object.fromEntries(items.map(r => [r.key, qtys[r.key]?.trim() ? qtys[r.key]! : r.pending])));

  const prepare = (kind: DecisionKind) => {
    const picked = items.filter(r => typed(r.key));
    if (!picked.length) { toast(t('approve.typeQtyFirst')); return; }
    for (const r of picked) {
      const v = qtys[r.key]!.trim();
      const ln = `${r.i.number ?? ''} #${r.line.lineNo}`;
      if (!isDecimal(v) || !dec.gt0(v)) { toast.error(t('approve.badQtyDoc', { line: ln })); return; }
      const canExceed = kind === 'approve' && r.i.docTypeKey === 'indent';
      if (!canExceed && dec.cmp(v, r.pending) > 0) { toast.error(t('approve.overPendingDoc', { line: ln, pending: fmtQty(r.pending) })); return; }
      if (kind !== 'approve' && (reasons[r.key] ?? '').trim().length < 3) {
        toast.error(t('approve.reasonNeeded'));
        document.querySelector<HTMLInputElement>(`[data-testid="inbox-item-reason-${r.key}"]`)?.focus();
        return;
      }
    }
    setConfirm({
      kind, picked,
      rows: picked.map(r => ({ key: r.key, doc: r.i.number ?? '', item: lineItemLabel(r.line), uom: lineUom(r.line), pending: r.pending, qty: dec.norm(qtys[r.key]!.trim()) })),
    });
  };

  const send = useCallback(async () => {
    if (!confirm) return;
    setBusy(true);
    const groups = new Map<string, ItemRow[]>();
    for (const r of confirm.picked) {
      const k = `${r.i.docTypeKey}|${r.i.documentId}|${r.i.stageKey}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    let okLines = 0;
    const failed: string[] = [];
    for (const g of groups.values()) {
      const { i, doc } = g[0]!;
      const decisions = g.map(r => {
        const v = dec.norm(qtys[r.key]!.trim());
        const rowReason = (reasons[r.key] ?? '').trim();
        return { lineId: r.line.id, approve: confirm.kind === 'approve' ? v : '0', hold: confirm.kind === 'hold' ? v : '0', reject: confirm.kind === 'reject' ? v : '0', ...(rowReason ? { reason: rowReason } : {}) };
      });
      try {
        await docsApi.act(i.docTypeKey, i.documentId, { action: 'decide', stageKey: i.stageKey, decisions }, { version: doc.version, idempotencyKey: newIdempotencyKey() });
        okLines += g.length;
      } catch (e) {
        failed.push(`${i.number ?? i.documentId}: ${isApiError(e) ? e.message : String(e)}`);
      }
      void qc.invalidateQueries({ queryKey: docKeys.detail(i.docTypeKey, i.documentId) });
      void qc.invalidateQueries({ queryKey: docKeys.all(i.docTypeKey) });
    }
    await qc.invalidateQueries({ queryKey: docKeys.inbox });
    setBusy(false);
    const kind = confirm.kind;
    setConfirm(null);
    if (okLines) {
      toast.success(t(kind === 'approve' ? 'approve.didApprove' : kind === 'hold' ? 'approve.didHold' : 'approve.didReject', { n: okLines }));
      setQtys({}); setReasons({});
    }
    if (failed.length) toast.error(t('approve.someFailed', { n: failed.length }), failed.join('\n'));
  }, [confirm, qtys, reasons, qc]);

  if (loading && !items.length) {
    return <div className="space-y-2 p-4" aria-busy="true">{[0, 1, 2, 3].map(k => <Skeleton key={k} className="h-9 w-full" />)}</div>;
  }
  if (!items.length) return <EmptyState icon={<Inbox />} title={t('inbox.items.empty')} />;

  return (
    <div data-testid="inbox-items">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="mr-1 text-sm text-fg-muted">{t('inbox.items.hint')}</span>
        <Button size="sm" variant="secondary" className="border-success/50 font-semibold text-success" disabled={busy} onClick={() => prepare('approve')} data-testid="inbox-items-approve">{t('approve.approve')}</Button>
        <Button size="sm" variant="secondary" className="border-warning/50 font-semibold text-warning" disabled={busy} onClick={() => prepare('hold')} data-testid="inbox-items-hold">{t('approve.hold')}</Button>
        <Button size="sm" variant="danger-outline" className="font-semibold" disabled={busy} onClick={() => prepare('reject')} data-testid="inbox-items-reject">{t('approve.reject')}</Button>
        <span className="ml-auto text-sm text-fg-muted tabular-nums">{t('inbox.items.count', { n: items.length })}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-subtle text-left text-xs text-fg-muted">
            <tr>
              <th className="w-10 px-3 py-2">
                <Checkbox checked={allOn ? true : someOn ? 'indeterminate' : false} onCheckedChange={toggleAll} aria-label={t('approve.selectAll')} data-testid="inbox-items-select-all" />
              </th>
              <th className="px-3 py-2 font-medium">{t('approve.confirm.doc')}</th>
              <th className="px-3 py-2 font-medium">{t('docs.col.location')}</th>
              <th className="px-3 py-2 font-medium">{t('docs.col.item')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('inbox.items.requested')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('approve.pendingHere')}</th>
              <th className="w-40 px-3 py-2 text-right font-medium">{t('approve.qtyToAct')}</th>
            </tr>
          </thead>
          <tbody className="[&>tr:nth-child(even)]:border-b [&>tr:nth-child(even)]:border-border">
            {items.map(r => {
              const v = qtys[r.key] ?? '';
              const on = typed(r.key);
              const bad = on && (!isDecimal(v.trim()) || !dec.gt0(v.trim()));
              const over = on && !bad && dec.cmp(v.trim(), r.pending) > 0;
              const uom = lineUom(r.line);
              const rowCls = on ? 'bg-accent-soft/40' : '';
              const rowReason = reasons[r.key] ?? '';
              return (
                <Fragment key={r.key}>
                <tr className={cn('border-b-0', rowCls)} data-testid={`inbox-item-${r.i.number ?? r.i.documentId}-${r.line.lineNo}`}>
                  <td className="px-3 py-2"><Checkbox checked={on} onCheckedChange={() => toggle(r)} aria-label={t('approve.selectLine', { n: r.line.lineNo })} /></td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Link href={`/docs/${r.i.docTypeKey}/${r.i.documentId}/approve?stage=${encodeURIComponent(r.i.stageKey)}`} className="font-medium tabular-nums hover:text-accent hover:underline">{r.i.number ?? t('docs.draft')}</Link>
                    <span className="block text-xs text-fg-subtle">{r.i.docTypeName} · {r.i.stageName}</span>
                  </td>
                  <td className="px-3 py-2 text-fg-muted">{r.i.location}</td>
                  <td className="px-3 py-2">{lineItemLabel(r.line)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{fmtQty(r.line.qty.requested)} {uom}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtQty(r.pending)}</td>
                  <td className="px-3 py-2">
                    <Input inputMode="decimal" autoComplete="off" placeholder="0" value={v}
                      onChange={e => { const x = e.target.value.replace(/[^\d.]/g, ''); setQtys(q => { const n = { ...q }; if (x) n[r.key] = x; else delete n[r.key]; return n; }); }}
                      aria-invalid={bad || undefined} aria-label={t('approve.qtyLabel', { what: t('approve.qtyToAct'), n: r.line.lineNo })}
                      className={cn('h-8 text-right tabular-nums', bad && 'border-danger')} />
                    {over && <p className={cn('mt-0.5 text-right text-xs', r.i.docTypeKey === 'indent' ? 'text-accent' : 'text-danger')}>
                      {r.i.docTypeKey === 'indent' ? t('approve.overHint', { qty: fmtQty(dec.sub(v.trim(), r.pending)) }) : t('approve.overPendingShort', { pending: fmtQty(r.pending) })}
                    </p>}
                  </td>
                </tr>
                {on && (
                  <tr className={rowCls}>
                    <td />
                    <td colSpan={6} className="px-3 pb-2 pt-0">
                      <Input
                        value={rowReason}
                        onChange={e => setReasons(rs => ({ ...rs, [r.key]: e.target.value }))}
                        placeholder={t('approve.reasonPlaceholder')}
                        aria-label={t('approve.reasonPlaceholder')}
                        className="h-8 w-full sm:w-80"
                        data-testid={`inbox-item-reason-${r.key}`}
                      />
                    </td>
                  </tr>
                )}
                <tr className={rowCls} data-testid={`inbox-item-details-${r.i.number ?? r.i.documentId}-${r.line.lineNo}`}>
                  <td />
                  <td colSpan={6} className="px-3 pb-3 pt-0">
                    {typeof r.line.values.item === 'string' && r.line.values.item && <ItemContextPanel itemId={r.line.values.item} uom={uom} indent={false} />}
                    <LineHistory docTypeKey={r.i.docTypeKey} docId={r.i.documentId} line={r.line} lineNo={r.line.lineNo} indent={false} />
                  </td>
                </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {confirm && (
        <ConfirmDecisionDialog kind={confirm.kind} rows={confirm.rows} reason={''} busy={busy}
          onCancel={() => setConfirm(null)} onConfirm={() => void send()} />
      )}
    </div>
  );
}
