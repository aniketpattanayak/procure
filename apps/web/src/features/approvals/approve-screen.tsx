'use client';
import type { DocListRow, DocTypeSummary, DocumentLineRow, DocumentRow, TimelineEntry, WorkflowActionInput } from '@procure/schema';
import {
  Button, Card, cn, EmptyState, Input, Textarea, toast, useVirtualizer,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, Clock, Forward, Keyboard, Lock, Package, PauseCircle, Play, ShoppingCart, Undo2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageSkeleton } from '@/components/guards';
import { InlineAlert, PageBody } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { formatDecimal } from '@/engines/form-renderer/values';
import { docKeys, docsApi, newIdempotencyKey, useDocType } from '@/features/documents/api';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { lineItemLabel, lineUom } from '@/features/documents/lines-table';
import { decisionPrefill } from '@/features/documents/extensions';
import '@/features/documents/extensions-installed';
import { DocStatusBadge } from '@/features/documents/status';
import { dueText } from '@/features/documents/workflow-progress';
import { stockApi, stockKeys } from '@/features/stock/api';
import { t } from '@/i18n';
import { isApiError, type ApiError } from '@/lib/api';
import {
  initDraft, setQty, type Bucket, type LineDraft,
} from './decision-model';
import { ConfirmDecisionDialog, type ConfirmRow } from './confirm-dialog';
import { ForwardDialog, SendBackDialog, ShortcutsDialog } from './stage-dialogs';

const VIRTUAL_AFTER = 50;

type Stage = NonNullable<DocumentRow['workflow']>['stages'][number];

export function ApproveScreen({ type, id }: { type: string; id: string }) {
  const { docType, isLoading } = useDocType(type);
  const sp = useSearchParams();
  const doc = useQuery({ queryKey: docKeys.detail(type, id), queryFn: () => docsApi.get(type, id), retry: false });
  if (isLoading || doc.isLoading) return <PageBody><PageSkeleton rows={8} /></PageBody>;
  if (!docType || !doc.data) return <PageBody><EmptyState icon={<Lock />} title={t('docs.notFound')} description={t('docs.notFoundHint')} /></PageBody>;
  const stages = doc.data.workflow?.stages ?? [];
  const wanted = sp.get('stage');
  const stage = stages.find(s => s.key === wanted && s.canAct) ?? stages.find(s => s.status === 'active' && s.canAct) ?? null;
  const back = `/docs/${type}/${id}`;
  if (!stage) {
    return (
      <PageBody>
        <EmptyState icon={<CheckCircle2 />} title={t('approve.nothing.title')} description={t('approve.nothing.hint')}
          action={<Button asChild variant="secondary"><Link href={back}>{t('approve.backToDoc')}</Link></Button>} />
      </PageBody>
    );
  }
  return <Screen key={`${stage.key}`} docType={docType} doc={doc.data} stage={stage} />;
}

/** Granularity is not part of WorkflowRuntimeView yet; accept it when the server sends it (workflow or stage level). */
function granularityOf(doc: DocumentRow, stage: Stage): 'line' | 'document' {
  const wf = doc.workflow as unknown as { granularity?: string; stageGranularity?: Record<string, string> } | null;
  const g = (stage as unknown as { granularity?: string }).granularity ?? wf?.stageGranularity?.[stage.key] ?? wf?.granularity;
  return g === 'document' ? 'document' : 'line';
}
function editableFieldsOf(doc: DocumentRow, stage: Stage): string[] {
  const s = stage as unknown as { editableLineFields?: string[] };
  const wf = doc.workflow as unknown as { stageEditableFields?: Record<string, string[]> } | null;
  return s.editableLineFields ?? wf?.stageEditableFields?.[stage.key] ?? [];
}

function Screen({ docType, doc, stage }: { docType: DocTypeSummary; doc: DocumentRow; stage: Stage }) {
  const type = docType.key;
  const router = useRouter();
  const qc = useQueryClient();
  const { currency } = useTenantLocale();
  const actions = useMemo(() => doc.workflow?.stageActions?.[stage.key] ?? ['approve', 'reject', 'hold', 'send_back'], [doc.workflow, stage.key]);
  const allowed = new Set(doc.allowedActions);
  // The runtime view doesn't carry granularity yet: if the server says "send outcome", switch to document mode.
  const [forceDocument, setForceDocument] = useState(false);
  const [userGranularity, setUserGranularity] = useState<'line' | 'document' | null>(null);
  const serverGranularity = forceDocument ? 'document' : granularityOf(doc, stage);
  const granularity = userGranularity ?? serverGranularity;
  const editable = useMemo(() => editableFieldsOf(doc, stage), [doc, stage]);

  const lineById = useMemo(() => new Map(doc.lines.map(l => [l.id, l])), [doc.lines]);
  const pendingLines = useMemo(() => [...doc.lines].filter(l => dec.gt0(l.stages?.[stage.key]?.pending)).sort((a, b) => a.lineNo - b.lineNo), [doc.lines, stage.key]);
  const heldLines = useMemo(() => [...doc.lines].filter(l => dec.gt0(l.stages?.[stage.key]?.held)).sort((a, b) => a.lineNo - b.lineNo), [doc.lines, stage.key]);

  // Module prefill (extensions registry), e.g. a GRN gate rejects what the receiver counted as rejected.
  const firstDraft = useCallback((l: DocumentLineRow): LineDraft => {
    const p = l.stages[stage.key]!.pending;
    const d = initDraft(l.id, l.lineNo, p);
    const pre = decisionPrefill(doc, l, stage.key, p);
    return pre && dec.gt0(pre.reject) && dec.cmp(pre.reject, p) <= 0 ? { ...setQty(d, 'reject', dec.norm(pre.reject)), reason: pre.reason } : d;
  }, [doc, stage.key]);
  const [drafts, setDrafts] = useState<LineDraft[]>(() => pendingLines.map(firstDraft));
  // Re-sync when the document changes (after an action or a reload): keep a line's draft if its pending qty is unchanged.
  const lastVersion = useRef(doc.version);
  useEffect(() => {
    if (lastVersion.current === doc.version) return;
    lastVersion.current = doc.version;
    setQtys({});
    setDrafts(prev => {
      const old = new Map(prev.map(d => [d.lineId, d]));
      return pendingLines.map(l => {
        const p = l.stages[stage.key]!.pending;
        const o = old.get(l.id);
        return o && dec.cmp(o.pending, p) === 0 ? o : firstDraft(l);
      });
    });
  }, [doc.version, pendingLines, stage.key, firstDraft]);

  const [active, setActive] = useState(0);
  // One qty box per line, empty until typed. Lines with a qty get the action pressed in the top bar.
  const [qtys, setQtys] = useState<Record<string, string>>({});
  const onQty = useCallback((lineId: string, v: string) => setQtys(q => ({ ...q, [lineId]: v.replace(/[^\d.]/g, '') })), []);
  const canExceed = type === 'indent';
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'send_back' | 'forward' | 'help' | null>(null);
  const [bulkReason, setBulkReason] = useState('');
  const idemKey = useRef<string>(newIdempotencyKey());

  const update = useCallback((lineId: string, fn: (d: LineDraft) => LineDraft) => {
    setDrafts(ds => ds.map(d => (d.lineId === lineId ? fn(d) : d)));
  }, []);

  /** Totals across ALL lines (not just pending drafts) — approved/held/rejected/pendingApproval */
  const lineQtySummary = useMemo(() => {
    let approved = '0', held = '0', rejected = '0', pending = '0';
    for (const l of doc.lines) {
      approved = dec.add(approved, l.qty.approved);
      held = dec.add(held, l.qty.held);
      rejected = dec.add(rejected, l.qty.rejected);
      pending = dec.add(pending, l.qty.pendingApproval);
    }
    return { approved, held, rejected, pending };
  }, [doc.lines]);

  // ------------------------------------------------------------------ actions
  const refresh = useCallback(async (next?: DocumentRow) => {
    if (next) qc.setQueryData(docKeys.detail(type, doc.id), next);
    await qc.invalidateQueries({ queryKey: docKeys.detail(type, doc.id) });
    void qc.invalidateQueries({ queryKey: docKeys.all(type) });
    void qc.invalidateQueries({ queryKey: docKeys.inbox });
  }, [qc, type, doc.id]);

  const run = useCallback(async (label: string, body: WorkflowActionInput): Promise<DocumentRow | null> => {
    setBusy(label); setConflict(null);
    try {
      const next = await docsApi.act(type, doc.id, body, { version: doc.version, idempotencyKey: idemKey.current });
      idemKey.current = newIdempotencyKey();
      await refresh(next);
      return next;
    } catch (e) {
      const err = e as ApiError;
      if (!isApiError(e) || err.status !== 0) idemKey.current = newIdempotencyKey();
      if (isApiError(e) && e.status === 400 && body.action === 'decide' && /"outcome"/.test(e.message)) {
        setForceDocument(true);
        toast(t('approve.switchedToDocument'));
      } else if (isApiError(e) && e.status === 409) {
        setConflict(t('approve.conflict'));
        toast.error(t('approve.conflictToast'));
        await refresh();
      } else {
        toast.error(t('approve.failed'), isApiError(e) ? e.message : String(e));
      }
      return null;
    } finally { setBusy(null); }
  }, [type, doc.id, doc.version, refresh]);

  const afterAction = useCallback((next: DocumentRow) => {
    const stillHere = next.lines.some(l => dec.gt0(l.stages?.[stage.key]?.pending) || dec.gt0(l.stages?.[stage.key]?.held));
    if (!stillHere || !next.workflow?.stages.some(s => s.key === stage.key && s.canAct)) router.push(`/docs/${type}/${doc.id}`);
  }, [router, stage.key, type, doc.id]);

  /** Top-bar Approve / Hold / Reject: acts at once on every line with a qty typed (the rest stays pending). */
  const act = useCallback(async (b: Bucket) => {
    if (busy) return;
    const rows = drafts.filter(d => (qtys[d.lineId] ?? '').trim() !== '');
    if (!rows.length) { toast(t('approve.typeQtyFirst')); return; }
    for (const d of rows) {
      const v = qtys[d.lineId]!.trim();
      if (!isDecimal(v) || !dec.gt0(v)) { toast.error(t('approve.badQty', { n: d.lineNo })); return; }
      if ((b !== 'approve' || !canExceed) && dec.cmp(v, d.pending) > 0) { toast.error(t('approve.overPending', { n: d.lineNo, pending: fmtQty(d.pending) })); return; }
    }
    const reason = bulkReason.trim();
    if ((b === 'hold' || b === 'reject') && reason.length < 3) {
      toast.error(t('approve.reasonNeeded'));
      document.querySelector<HTMLInputElement>('[data-testid="decision-apply-all-reason"]')?.focus();
      return;
    }
    const decisions = rows.map(d => {
      const v = dec.norm(qtys[d.lineId]!.trim());
      return {
        lineId: d.lineId, approve: b === 'approve' ? v : '0', hold: b === 'hold' ? v : '0', reject: b === 'reject' ? v : '0',
        ...(reason ? { reason } : {}),
        ...(d.values && Object.keys(d.values).length ? { values: d.values } : {}),
      };
    });
    // Nothing is saved yet: the overview popup asks for confirmation first.
    setConfirm({
      kind: b, decisions, reason,
      rows: rows.map(d => {
        const l = lineById.get(d.lineId);
        return { key: d.lineId, doc: doc.number ?? '', item: l ? lineItemLabel(l) : `#${d.lineNo}`, uom: l ? lineUom(l) : '', pending: d.pending, qty: dec.norm(qtys[d.lineId]!.trim()) };
      }),
    });
  }, [busy, drafts, qtys, canExceed, bulkReason, lineById, doc.number]);

  const [confirm, setConfirm] = useState<{ kind: Bucket; reason: string; rows: ConfirmRow[]; decisions: Extract<WorkflowActionInput, { action: 'decide' }>['decisions'] } | null>(null);
  const send = useCallback(async () => {
    if (!confirm) return;
    const next = await run(`decide:${confirm.kind}`, { action: 'decide', stageKey: stage.key, decisions: confirm.decisions, ...(comment.trim() ? { comment: comment.trim() } : {}) });
    const n = confirm.rows.length; const b = confirm.kind;
    setConfirm(null);
    if (next) {
      setQtys({}); setBulkReason(''); setComment('');
      toast.success(t(b === 'approve' ? 'approve.didApprove' : b === 'hold' ? 'approve.didHold' : 'approve.didReject', { n }));
      afterAction(next);
    }
  }, [confirm, run, stage.key, comment, afterAction]);

  const unhold = useCallback(async (lineIds: string[]) => {
    const next = await run(`unhold:${lineIds.join(',')}`, { action: 'unhold', stageKey: stage.key, lineIds });
    if (next) toast.success(t('approve.unheld', { n: lineIds.length }));
  }, [run, stage.key]);

  // ------------------------------------------------------------------ keyboard (j/k move, e edit qty, ? help)
  const listRef = useRef<HTMLDivElement>(null);
  const virtual = drafts.length > VIRTUAL_AFTER;
  const virtualizer = useVirtualizer({ count: drafts.length, getScrollElement: () => listRef.current, estimateSize: () => 76, overscan: 8, enabled: virtual });
  const focusRow = useCallback((i: number) => {
    if (virtual) virtualizer.scrollToIndex(i, { align: 'auto' });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row-index="${i}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [virtual, virtualizer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || e.defaultPrevented || e.altKey || e.metaKey || (e.ctrlKey && e.key !== 'Enter')) return;
      if (document.querySelector('[role="dialog"]')) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (typing) { if (e.key === 'Escape') { el!.blur(); } return; }
      const d = drafts[active];
      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); setActive(i => { const n = Math.min(drafts.length - 1, i + 1); focusRow(n); return n; }); break;
        case 'k': case 'ArrowUp': e.preventDefault(); setActive(i => { const n = Math.max(0, i - 1); focusRow(n); return n; }); break;
        case 'e': if (d) { e.preventDefault(); document.querySelector<HTMLInputElement>(`[data-testid="decision-${d.lineNo}-qty"]`)?.select(); } break;
        case '?': e.preventDefault(); setDialog('help'); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, drafts, active, focusRow]);

  const priorStages = (doc.workflow?.stages ?? []).filter(s => s.status === 'done' && (doc.workflow!.stages.findIndex(x => x.key === s.key) < doc.workflow!.stages.findIndex(x => x.key === stage.key)));
  const canSendBack = actions.includes('send_back') && allowed.has('send_back');
  const canForward = actions.includes('forward') && allowed.has('forward');
  const due = dueText(stage.dueAt, stage.overdue);
  const total = doc.values.total_amount;

  const vItems = virtual ? virtualizer.getVirtualItems() : null;

  return (
    <PageBody className="pb-40 md:pb-32">
      <div data-testid="approve-screen" data-stage={stage.key} data-granularity={granularity}>
        <div className="mb-4">
          <Link href={`/docs/${type}/${doc.id}`} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('approve.backToDoc')}</Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold"><span className="tabular-nums" data-testid="doc-number">{doc.number}</span> <span className="font-normal text-fg-muted">· {stage.name}</span></h1>
            <DocStatusBadge statusKey={doc.statusKey} label={doc.statusLabel} docType={docType} />
          </div>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
            {doc.submittedBy && <span>{t('approve.submittedBy', { name: doc.submittedBy.name })}</span>}
            {total ? <span className="font-medium text-fg tabular-nums">{formatDecimal(total, 2, { currency })}</span> : null}
            {due && <span className={cn('inline-flex items-center gap-1', stage.overdue && 'font-medium text-danger')}><Clock className="size-3.5" aria-hidden />{due}</span>}
          </p>
        </div>

        {conflict && <InlineAlert tone="warning" className="mb-4" data-testid="approve-conflict">{conflict}</InlineAlert>}

        {/* Item Wise / Doc Wise toggle — always visible above the decision area */}
        <div className="mb-3 flex overflow-hidden rounded border border-border w-fit" role="group" aria-label="Granularity">
          <button type="button"
            onClick={() => setUserGranularity('line')}
            aria-pressed={granularity === 'line'}
            className={cn('px-4 py-1.5 text-sm font-semibold transition-colors', granularity === 'line' ? 'bg-accent text-white' : 'bg-surface text-fg-muted hover:bg-subtle')}
            data-testid="granularity-item-wise">
            Item Wise
          </button>
          <button type="button"
            onClick={() => setUserGranularity('document')}
            aria-pressed={granularity === 'document'}
            className={cn('border-l border-border px-4 py-1.5 text-sm font-semibold transition-colors', granularity === 'document' ? 'bg-accent text-white' : 'bg-surface text-fg-muted hover:bg-subtle')}
            data-testid="granularity-doc-wise">
            Doc Wise
          </button>
        </div>

        {/* Qty totals strip — always shown so user can see overall status at a glance */}
        <QtySummaryStrip approved={lineQtySummary.approved} held={lineQtySummary.held} rejected={lineQtySummary.rejected} pending={lineQtySummary.pending} />

        {granularity === 'document' ? (
          <DocumentDecision doc={doc} stage={stage} actions={actions} busy={!!busy} onDecide={async (o, reason) => {
            const next = await run('decide', { action: 'decide', stageKey: stage.key, decisions: [], outcome: o, ...(reason ? { comment: reason } : {}) });
            if (next) { toast.success(t('approve.docDone')); afterAction(next); }
          }} />
        ) : drafts.length === 0 ? (
          heldLines.length === 0 && <EmptyState icon={<CheckCircle2 />} title={t('approve.nothing.title')} description={t('approve.nothing.hint')} />
        ) : (
          <Card className="overflow-hidden">
            {/* Toolbar: select all, apply to selected/all, shortcuts, send back, forward */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5" data-testid="decision-apply-all">
              <span className="mr-1 text-sm text-fg-muted">{t('approve.typeQtyThen')}</span>
              <div className="flex gap-1">
                <QuickButton tone="approve" label={busy === 'decide:approve' ? '…' : t('approve.approve')} disabled={!!busy} onClick={() => void act('approve')} testId="decision-apply-all-approve" wide />
                {actions.includes('hold') && <QuickButton tone="hold" label={busy === 'decide:hold' ? '…' : t('approve.hold')} disabled={!!busy} onClick={() => void act('hold')} testId="decision-apply-all-hold" wide />}
                {actions.includes('reject') && <QuickButton tone="reject" label={busy === 'decide:reject' ? '…' : t('approve.reject')} disabled={!!busy} onClick={() => void act('reject')} testId="decision-apply-all-reject" wide />}
              </div>
              <Input value={bulkReason} onChange={e => setBulkReason(e.target.value)} placeholder={t('approve.reasonPlaceholder')} aria-label={t('approve.reasonPlaceholder')} className="h-8 w-full sm:w-64" data-testid="decision-apply-all-reason" />
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setDialog('help')} className="hidden md:inline-flex" aria-keyshortcuts="?" data-testid="decision-help-open"><Keyboard aria-hidden />{t('approve.shortcuts')}</Button>
                {canSendBack && <Button variant="secondary" size="sm" onClick={() => setDialog('send_back')} data-testid="send-back"><Undo2 aria-hidden />{t('approve.sendBack.button')}</Button>}
                {canForward && <Button variant="secondary" size="sm" onClick={() => setDialog('forward')} data-testid="forward"><Forward aria-hidden />{t('approve.forward.button')}</Button>}
              </div>
            </div>

            {/* Column header (wide screens) */}
            <div className="hidden grid-cols-[2.25rem_minmax(10rem,1fr)_7rem_10rem] items-center gap-x-3 border-b border-border bg-subtle px-3 py-2 text-sm font-medium text-fg-muted md:grid" aria-hidden>
              <span className="text-right">#</span><span>{t('docs.col.item')}</span><span className="text-right">{t('approve.pendingHere')}</span>
              <span className="text-right">{t('approve.qtyToAct')}</span>
            </div>

            <div ref={listRef} role="list" aria-label={t('approve.linesLabel')} className={cn(virtual && 'overflow-y-auto')} style={virtual ? { maxHeight: 'calc(100dvh - 22rem)', minHeight: 320 } : undefined}>
              {virtual ? (
                <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                  {vItems!.map(vi => {
                    const d = drafts[vi.index]!;
                    return (
                      <div key={d.lineId} ref={virtualizer.measureElement} data-index={vi.index} className="absolute inset-x-0" style={{ transform: `translateY(${vi.start}px)` }}>
                        <DecisionRow d={d} line={lineById.get(d.lineId)!} index={vi.index} active={vi.index === active} value={qtys[d.lineId] ?? ''} canExceed={canExceed}
                          editable={editable} onActivate={setActive} onUpdate={update} onQty={onQty} />
                      </div>
                    );
                  })}
                </div>
              ) : drafts.map((d, i) => (
                <DecisionRow key={d.lineId} d={d} line={lineById.get(d.lineId)!} index={i} active={i === active} value={qtys[d.lineId] ?? ''} canExceed={canExceed}
                  editable={editable} onActivate={setActive} onUpdate={update} onQty={onQty} />
              ))}
            </div>

            <div className="border-t border-border px-3 py-3">
              <label htmlFor="approve-comment" className="text-sm font-medium">{t('approve.comment')} <span className="font-normal text-fg-subtle">({t('common.optional')})</span></label>
              <Textarea id="approve-comment" rows={2} value={comment} onChange={e => setComment(e.target.value)} maxLength={2000} className="mt-1.5" data-testid="decision-comment" />
            </div>
          </Card>
        )}

        {heldLines.length > 0 && allowed.has('unhold') && (
          <UnholdPanel lines={heldLines} stageKey={stage.key} busy={busy} onUnhold={ids => void unhold(ids)} />
        )}
        {heldLines.length > 0 && granularity === 'line' && drafts.length === 0 && !allowed.has('unhold') && (
          <InlineAlert tone="info" className="mt-4">{t('approve.heldNoUnhold', { n: heldLines.length })}</InlineAlert>
        )}
      </div>

      {confirm && (
        <ConfirmDecisionDialog kind={confirm.kind} rows={confirm.rows} reason={confirm.reason} busy={!!busy}
          onCancel={() => setConfirm(null)} onConfirm={() => void send()} />
      )}
      {dialog === 'help' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === 'send_back' && (
        <SendBackDialog targets={priorStages.map(s => ({ key: s.key, name: s.name }))} onClose={() => setDialog(null)}
          onConfirm={async (toStage, reason) => {
            const next = await run('send_back', { action: 'send_back', stageKey: stage.key, toStage, reason });
            if (!next) throw new Error(t('approve.failed'));
            toast.success(t('approve.sentBack')); router.push(`/docs/${type}/${doc.id}`);
          }} />
      )}
      {dialog === 'forward' && (
        <ForwardDialog onClose={() => setDialog(null)}
          onConfirm={async (toUserId, reason) => {
            const next = await run('forward', { action: 'forward', stageKey: stage.key, toUserId, reason });
            if (!next) throw new Error(t('approve.failed'));
            toast.success(t('approve.forwarded'));
          }} />
      )}
    </PageBody>
  );
}

/** Compact banner showing total approved/held/rejected/pending across all doc lines. */
function QtySummaryStrip({ approved, held, rejected, pending }: { approved: string; held: string; rejected: string; pending: string }) {
  const hasAny = dec.gt0(approved) || dec.gt0(held) || dec.gt0(rejected) || dec.gt0(pending);
  if (!hasAny) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-x-5 gap-y-1.5 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm" data-testid="approve-qty-summary">
      {dec.gt0(approved) && (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
          <span className="text-fg-muted">Approved</span>
          <span className="font-semibold tabular-nums text-success">{fmtQty(approved)}</span>
        </span>
      )}
      {dec.gt0(held) && (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-warning-bar" aria-hidden />
          <span className="text-fg-muted">Held</span>
          <span className="font-semibold tabular-nums text-warning">{fmtQty(held)}</span>
        </span>
      )}
      {dec.gt0(rejected) && (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-danger" aria-hidden />
          <span className="text-fg-muted">Rejected</span>
          <span className="font-semibold tabular-nums text-danger">{fmtQty(rejected)}</span>
        </span>
      )}
      {dec.gt0(pending) && (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-fg-subtle" aria-hidden />
          <span className="text-fg-muted">Pending</span>
          <span className="font-semibold tabular-nums">{fmtQty(pending)}</span>
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ one line

const TONE = {
  approve: { on: 'bg-success text-white dark:text-bg border-success', off: 'border-success/40 text-success hover:bg-success-soft', bar: 'bg-success' },
  hold: { on: 'bg-warning-bar text-white dark:text-bg border-warning-bar', off: 'border-warning/40 text-warning hover:bg-warning-soft', bar: 'bg-warning-bar' },
  reject: { on: 'bg-danger text-white dark:text-bg border-danger', off: 'border-danger/40 text-danger hover:bg-danger-soft', bar: 'bg-danger' },
} as const;

function QuickButton({ tone, label, onClick, pressed, testId, wide, disabled, short }: { tone: Bucket; label: string; onClick: () => void; pressed?: boolean; testId: string; wide?: boolean; disabled?: boolean; short?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={pressed} disabled={disabled} data-testid={testId} title={label}
      className={cn(
        'inline-flex items-center justify-center rounded border font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40',
        wide ? 'h-8 px-3 text-sm' : 'h-11 flex-1 text-base md:h-8 md:w-8 md:flex-none md:text-sm',
        pressed ? TONE[tone].on : cn('bg-surface', TONE[tone].off),
      )}>
      {short ? <><span className="md:hidden">{label}</span><span className="hidden md:inline" aria-hidden>{short}</span></> : label}
    </button>
  );
}

// ------------------------------------------------------------------------------------------------ item context panel

type ContextSection = 'indent' | 'po' | 'inventory';

export function ItemContextPanel({ itemId, uom, indent = true }: { itemId: string; uom: string; indent?: boolean }) {
  const [open, setOpen] = useState<ContextSection | null>(null);

  const indents = useQuery({
    queryKey: ['item-ctx', 'indent', itemId],
    queryFn: () => docsApi.list('indent', { view: 'document', item: itemId }, null, 5),
    enabled: open === 'indent',
    staleTime: 60_000,
  });
  const pos = useQuery({
    queryKey: ['item-ctx', 'purchase_order', itemId],
    queryFn: () => docsApi.list('purchase_order', { view: 'document', item: itemId }, null, 5),
    enabled: open === 'po',
    staleTime: 60_000,
  });
  const inv = useQuery({
    queryKey: stockKeys.summary(itemId),
    queryFn: () => stockApi.summary(itemId),
    enabled: open === 'inventory',
    staleTime: 60_000,
  });

  const toggle = (s: ContextSection) => setOpen(o => o === s ? null : s);

  const SectionBtn = ({ id, icon, label }: { id: ContextSection; icon: React.ReactNode; label: string }) => (
    <button type="button" onClick={e => { e.stopPropagation(); toggle(id); }}
      className={cn('inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-medium transition-colors',
        open === id ? 'border-accent bg-accent text-white' : 'border-border bg-surface text-fg-muted hover:bg-subtle hover:text-fg')}
      aria-expanded={open === id}>
      {icon}{label}{open === id ? <ChevronUp className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
    </button>
  );

  const DocTable = ({ rows, loading }: { rows: DocListRow[] | undefined; loading: boolean }) => {
    if (loading) return <p className="py-3 text-center text-xs text-fg-muted">Loading…</p>;
    if (!rows?.length) return <p className="py-3 text-center text-xs text-fg-muted">No records found.</p>;
    return (
      <table className="w-full text-xs">
        <thead><tr className="border-b border-border bg-muted/60 text-left text-fg-muted">
          <th className="px-3 py-1.5 font-medium">#</th>
          <th className="px-3 py-1.5 font-medium">Number</th>
          <th className="px-3 py-1.5 font-medium">Date</th>
          <th className="px-3 py-1.5 font-medium">Status</th>
          <th className="px-3 py-1.5 font-medium">Location</th>
          <th className="px-3 py-1.5 font-medium text-right">Amount</th>
        </tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={r.id} className="hover:bg-muted/40">
              <td className="px-3 py-1.5 tabular-nums text-fg-muted">{i + 1}</td>
              <td className="px-3 py-1.5 font-medium text-fg">{r.number ?? '—'}</td>
              <td className="px-3 py-1.5 tabular-nums text-fg-muted whitespace-nowrap">{new Date(r.docDate).toLocaleDateString()}</td>
              <td className="px-3 py-1.5"><span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', r.statusKey === 'approved' || r.statusKey === 'completed' ? 'bg-success/15 text-success' : r.statusKey === 'rejected' || r.statusKey === 'cancelled' ? 'bg-danger/15 text-danger' : r.statusKey === 'hold' ? 'bg-warning/15 text-warning' : 'bg-muted text-fg-muted')}>{r.statusLabel}</span></td>
              <td className="px-3 py-1.5 text-fg-muted">{r.location.name}</td>
              <td className="px-3 py-1.5 tabular-nums text-right text-fg">{r.totalAmount ? fmtQty(r.totalAmount) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div className={cn('mt-2', indent && 'md:ml-[calc(2.25rem+0.75rem)]')}>
      <div className="flex flex-wrap gap-2">
        <SectionBtn id="indent" icon={<Package className="size-3" aria-hidden />} label="Last 5 Indents" />
        <SectionBtn id="po" icon={<ShoppingCart className="size-3" aria-hidden />} label="Last 5 POs" />
        <SectionBtn id="inventory" icon={<Package className="size-3" aria-hidden />} label="Inventory" />
      </div>

      {open === 'indent' && (
        <div className="mt-1.5 overflow-hidden rounded border border-border bg-subtle">
          <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-fg-muted">Last 5 Indents for this Item</div>
          <DocTable rows={indents.data?.data as DocListRow[] | undefined} loading={indents.isLoading} />
        </div>
      )}

      {open === 'po' && (
        <div className="mt-1.5 overflow-hidden rounded border border-border bg-subtle">
          <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-fg-muted">Last 5 Purchase Orders for this Item</div>
          <DocTable rows={pos.data?.data as DocListRow[] | undefined} loading={pos.isLoading} />
        </div>
      )}

      {open === 'inventory' && (
        <div className="mt-1.5 overflow-hidden rounded border border-border bg-subtle">
          <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-fg-muted">Inventory Summary</div>
          {inv.isLoading ? (
            <p className="py-3 text-center text-xs text-fg-muted">Loading…</p>
          ) : !inv.data ? (
            <p className="py-3 text-center text-xs text-fg-muted">No inventory data found.</p>
          ) : (
            <div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-xs sm:grid-cols-4">
                <div><p className="text-fg-muted">Available</p><p className="font-semibold text-success tabular-nums">{fmtQty(inv.data.totals.available)} {uom}</p></div>
                <div><p className="text-fg-muted">Quarantine</p><p className="font-semibold text-warning tabular-nums">{fmtQty(inv.data.totals.quarantine)} {uom}</p></div>
                <div><p className="text-fg-muted">Open PO Qty</p><p className="font-semibold tabular-nums text-fg">{fmtQty(inv.data.totals.openPoQty)} {uom}</p></div>
                <div><p className="text-fg-muted">Pending Issue</p><p className="font-semibold tabular-nums text-fg">{fmtQty(inv.data.totals.pendingIssueQty)} {uom}</p></div>
              </div>
              {inv.data.nodes.length > 0 && (
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-border bg-muted/60 text-left text-fg-muted">
                    <th className="px-3 py-1.5 font-medium">Location</th>
                    <th className="px-3 py-1.5 font-medium text-right text-success">Available</th>
                    <th className="px-3 py-1.5 font-medium text-right text-warning">Quarantine</th>
                    <th className="px-3 py-1.5 font-medium text-right">Open PO</th>
                    <th className="px-3 py-1.5 font-medium text-right">Pending Issue</th>
                    <th className="px-3 py-1.5 font-medium text-right">Avg Cost</th>
                  </tr></thead>
                  <tbody className="divide-y divide-border">
                    {inv.data.nodes.map(n => (
                      <tr key={n.node.id} className="hover:bg-muted/40">
                        <td className="px-3 py-1.5 font-medium text-fg">{n.node.name}</td>
                        <td className="px-3 py-1.5 tabular-nums text-right text-success">{fmtQty(n.available)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-right text-warning">{fmtQty(n.quarantine)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-right text-fg">{fmtQty(n.openPoQty)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-right text-fg">{fmtQty(n.pendingIssueQty)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-right text-fg-muted">{n.avgCost ? fmtQty(n.avgCost) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ decision row with history

const DecisionRow = memo(function DecisionRow({ d, line, index, active, value, canExceed, editable, onActivate, onUpdate, onQty }: {
  d: LineDraft; line: DocumentLineRow; index: number; active: boolean; value: string; canExceed: boolean; editable: string[];
  onActivate: (i: number) => void; onUpdate: (lineId: string, fn: (d: LineDraft) => LineDraft) => void; onQty: (lineId: string, v: string) => void;
}) {
  const uom = lineUom(line);
  const id = `dec-${d.lineNo}`;
  const typed = value.trim() !== '';
  const bad = typed && (!isDecimal(value) || !dec.gt0(value));
  const over = typed && !bad && dec.cmp(value, d.pending) > 0;
  const original = typeof line.values.qty === 'string' || typeof line.values.qty === 'number' ? String(line.values.qty) : null;
  const added = original && isDecimal(original) && dec.cmp(line.qty.requested, original) > 0 ? dec.sub(line.qty.requested, original) : null;


  return (
    <div role="listitem" data-row-index={index} data-testid={`decision-row-${d.lineNo}`} onClick={() => onActivate(index)}
      className={cn(
        'relative border-b border-border px-3 py-3 last:border-b-0 md:py-2',
        active ? 'bg-accent-soft/60 shadow-[inset_3px_0_0_rgb(var(--c-accent))]' : 'hover:bg-subtle',
      )}>
      <div className="grid grid-cols-[1fr_auto] items-start gap-x-3 gap-y-3 md:grid-cols-[2.25rem_minmax(10rem,1fr)_7rem_10rem] md:items-center">
        <span className="hidden text-right text-sm text-fg-subtle tabular-nums md:block">{d.lineNo}</span>
        <div className="min-w-0">
          <p className="truncate font-medium"><span className="mr-1.5 text-sm font-normal text-fg-subtle md:hidden">{d.lineNo}</span>{lineItemLabel(line)}</p>
          <p className="text-xs text-fg-subtle">
            {t('approve.requested', { qty: `${fmtQty(original && isDecimal(original) ? original : line.qty.requested)} ${uom}`.trim() })}
            {added && <span className="ml-1.5 font-medium text-accent" data-testid={`decision-${d.lineNo}-added`}>{t('approve.addedAtApproval', { qty: fmtQty(added) })}</span>}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums md:text-base" data-testid={`qty-pending-${d.lineNo}`} data-value={d.pending}>{fmtQty(d.pending)}</p>
          <p className="text-xs text-fg-subtle md:hidden">{uom || t('approve.pendingHere')}</p>
        </div>
        <div className="col-span-2 md:col-span-1">
          <label htmlFor={`${id}-qty`} className="mb-1 block text-xs font-medium text-fg-muted md:sr-only">{t('approve.qtyToAct')}</label>
          <Input
            id={`${id}-qty`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={value}
            onFocus={() => onActivate(index)}
            onChange={e => onQty(d.lineId, e.target.value)}
            aria-invalid={bad || undefined}
            aria-label={t('approve.qtyLabel', { what: t('approve.qtyToAct'), n: d.lineNo })}
            className={cn('h-11 text-right tabular-nums md:h-8', bad && 'border-danger')}
            data-testid={`decision-${d.lineNo}-qty`}
          />
          {over && <p className={cn('mt-1 text-right text-xs', canExceed ? 'text-accent' : 'text-danger')} data-testid={`decision-${d.lineNo}-over`}>
            {canExceed ? t('approve.overHint', { qty: fmtQty(dec.sub(value, d.pending)) }) : t('approve.overPendingShort', { pending: fmtQty(d.pending) })}
          </p>}
        </div>
      </div>

      {editable.length > 0 && (
        <div className="mt-2 space-y-2 md:ml-[calc(2.25rem+0.75rem)]">
          {editable.map(f => (
            <div key={f} className="flex items-center gap-2">
              <label htmlFor={`${id}-f-${f}`} className="w-28 shrink-0 text-xs font-medium text-fg-muted">{f}</label>
              <Input id={`${id}-f-${f}`} defaultValue={String(line.values[f] ?? '')} className="h-8 max-w-40"
                onChange={e => onUpdate(d.lineId, x => ({ ...x, values: { ...(x.values ?? {}), [f]: e.target.value } }))} data-testid={`decision-${d.lineNo}-field-${f}`} />
            </div>
          ))}
        </div>
      )}

      {/* Item context: last indents, POs, inventory */}
      {typeof line.values.item === 'string' && line.values.item && (
        <ItemContextPanel itemId={line.values.item} uom={lineUom(line)} />
      )}

      <LineHistory line={line} lineNo={d.lineNo} />
    </div>
  );
});

/** Per-line approval history (who decided what, qty, remarks), collapsed by default. */
export function LineHistory({ line, lineNo, indent = true }: { line: DocumentLineRow; lineNo: number; indent?: boolean }) {
  const [histOpen, setHistOpen] = useState(false);
  const lineHistory = useMemo(() => {
    const hist = (line as unknown as { history?: TimelineEntry[] }).history ?? [];
    return hist.filter(e => e.kind === 'workflow');
  }, [line]);
  return (
      <div className={cn('mt-2', indent && 'md:ml-[calc(2.25rem+0.75rem)]')}>
        <button type="button" onClick={e => { e.stopPropagation(); setHistOpen(v => !v); }}
          className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
          aria-expanded={histOpen} data-testid={`decision-${lineNo}-history-toggle`}>
          {histOpen ? <ChevronUp className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
          History
        </button>
        {histOpen && (
          <div className="mt-1.5 rounded border border-border bg-subtle overflow-hidden" data-testid={`decision-${lineNo}-history`}>
            <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-fg-muted border-b border-border bg-muted/40">
              History — {lineItemLabel(line)}
            </div>
            {lineHistory.length === 0 ? (
              <p className="py-3 text-center text-xs text-fg-muted">No history yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/60 text-left text-fg-muted">
                    <th className="px-3 py-1.5 font-medium">#</th>
                    <th className="px-3 py-1.5 font-medium">Date &amp; Time</th>
                    <th className="px-3 py-1.5 font-medium">Action By</th>
                    <th className="px-3 py-1.5 font-medium">Role</th>
                    <th className="px-3 py-1.5 font-medium">Action</th>
                    <th className="px-3 py-1.5 font-medium">Qty</th>
                    <th className="px-3 py-1.5 font-medium">Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lineHistory.map((entry, idx) => {
                    const ld = entry.lineDecisions?.find((x: { lineNo: number }) => x.lineNo === lineNo);
                    const actionQty = ld ? [
                      ld.approve && `${fmtQty(ld.approve)} ✓`,
                      ld.hold && `${fmtQty(ld.hold)} ⏸`,
                      ld.reject && `${fmtQty(ld.reject)} ✕`,
                    ].filter(Boolean).join(', ') : '—';
                    const actionLabel = ld?.approve && !ld?.reject && !ld?.hold ? 'Approved'
                      : ld?.hold && !ld?.approve && !ld?.reject ? 'On Hold'
                      : ld?.reject && !ld?.approve && !ld?.hold ? 'Rejected'
                      : entry.kind === 'workflow' ? 'Decision' : entry.kind;
                    const actionCls = ld?.approve && !ld?.reject && !ld?.hold ? 'text-success'
                      : ld?.hold && !ld?.reject ? 'text-warning'
                      : ld?.reject ? 'text-danger'
                      : 'text-fg-muted';
                    return (
                      <tr key={entry.id} className="hover:bg-muted/40">
                        <td className="px-3 py-1.5 tabular-nums text-fg-muted">{idx + 1}</td>
                        <td className="px-3 py-1.5 tabular-nums text-fg-muted whitespace-nowrap">{new Date(entry.at).toLocaleString()}</td>
                        <td className="px-3 py-1.5 font-medium text-fg">{entry.actor?.name ?? '—'}</td>
                        <td className="px-3 py-1.5 text-fg-muted">{(entry.actor as { role?: string } | undefined)?.role ?? '—'}</td>
                        <td className={cn('px-3 py-1.5 font-medium', actionCls)}>{actionLabel}</td>
                        <td className="px-3 py-1.5 tabular-nums text-fg">{actionQty}</td>
                        <td className="px-3 py-1.5 text-fg-muted italic max-w-[200px] truncate">{ld?.reason ?? entry.detail ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
  );
}

// ------------------------------------------------------------------------------------------------ held lines

function UnholdPanel({ lines, stageKey, busy, onUnhold }: { lines: DocumentLineRow[]; stageKey: string; busy: string | null; onUnhold: (ids: string[]) => void }) {
  return (
    <Card className="mt-4 overflow-hidden" data-testid="unhold-panel">
      <div className="flex items-center gap-2 border-b border-border bg-warning-soft/60 px-3 py-2.5">
        <PauseCircle className="size-4 text-warning" aria-hidden />
        <h2 className="flex-1 font-medium">{t('approve.held.title', { n: lines.length })}</h2>
        {lines.length > 1 && <Button variant="secondary" size="sm" onClick={() => onUnhold(lines.map(l => l.id))} loading={busy?.startsWith('unhold:') && busy.includes(',')} data-testid="unhold-all"><Play aria-hidden />{t('approve.held.releaseAll')}</Button>}
      </div>
      <ul className="divide-y divide-border">
        {lines.map(l => (
          <li key={l.id} className="flex items-center gap-3 px-3 py-2.5" data-testid={`held-row-${l.lineNo}`}>
            <span className="w-6 text-right text-sm text-fg-subtle tabular-nums">{l.lineNo}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{lineItemLabel(l)}</p>
              <p className="text-xs text-warning tabular-nums">{t('approve.held.qty', { qty: `${fmtQty(l.stages[stageKey]!.held)} ${lineUom(l)}`.trim() })}</p>
            </div>
            <Button variant="secondary" size="sm" className="h-10 md:h-8" onClick={() => onUnhold([l.id])} loading={busy === `unhold:${l.id}`} disabled={!!busy} data-testid={`unhold-${l.lineNo}`}>
              <Play aria-hidden />{t('approve.held.release')}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ document granularity

function DocumentDecision({ doc, stage, actions, busy, onDecide }: {
  doc: DocumentRow; stage: Stage; actions: readonly string[]; busy: boolean; onDecide: (o: 'approve' | 'hold' | 'reject', reason: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState<'approve' | 'hold' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const pending = doc.lines.filter(l => dec.gt0(l.stages?.[stage.key]?.pending));
  const needReason = choice === 'hold' || choice === 'reject';
  const ok = choice && (!needReason || reason.trim().length >= 3);
  const opts = ([['approve', CheckCircle2], ['hold', PauseCircle], ['reject', XCircle]] as const).filter(([k]) => k === 'approve' || actions.includes(k));
  return (
    <Card className="space-y-4 p-4 sm:p-5" data-testid="decision-document">
      <p className="text-fg-muted">{t('approve.doc.hint', { n: pending.length })}</p>
      <ul className="divide-y divide-border rounded border border-border text-sm">
        {pending.slice(0, 8).map(l => (
          <li key={l.id} className="flex gap-3 px-3 py-2"><span className="w-6 text-right text-fg-subtle tabular-nums">{l.lineNo}</span><span className="flex-1 truncate">{lineItemLabel(l)}</span><span className="tabular-nums">{fmtQty(l.stages[stage.key]!.pending)} {lineUom(l)}</span></li>
        ))}
        {pending.length > 8 && <li className="px-3 py-2 text-fg-subtle">{t('approve.doc.more', { n: pending.length - 8 })}</li>}
      </ul>
      <div role="radiogroup" aria-label={t('approve.doc.choose')} className="grid gap-2 sm:grid-cols-3">
        {opts.map(([k, Icon]) => (
          <button key={k} type="button" role="radio" aria-checked={choice === k} onClick={() => setChoice(k)} data-testid={`decision-doc-${k}`}
            className={cn('flex h-14 items-center justify-center gap-2 rounded-lg border-2 text-base font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              choice === k ? TONE[k].on : cn('bg-surface', TONE[k].off))}>
            <Icon className="size-5" aria-hidden />{t(`approve.${k}`)}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor="doc-reason" className="text-sm font-medium">{needReason ? t('common.reason') : t('approve.comment')}{!needReason && <span className="font-normal text-fg-subtle"> ({t('common.optional')})</span>}</label>
        <Textarea id="doc-reason" rows={2} value={reason} onChange={e => setReason(e.target.value)} className={cn('mt-1.5', tried && needReason && reason.trim().length < 3 && 'border-danger')} data-testid="decision-doc-reason" />
        {tried && needReason && reason.trim().length < 3 && <p role="alert" className="mt-1 text-xs font-medium text-danger">{t('validation.reasonMin')}</p>}
      </div>
      <div className="flex justify-end">
        <Button size="lg" loading={busy} disabled={!choice} onClick={() => { setTried(true); if (ok) void onDecide(choice!, reason.trim()); }} data-testid="decision-submit">
          {choice ? t(`approve.doc.submit.${choice}`) : t('approve.doc.pick')}
        </Button>
      </div>
    </Card>
  );
}
