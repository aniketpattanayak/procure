'use client';
import type { DocTypeSummary, DocumentLineRow, DocumentRow, WorkflowActionInput } from '@procure/schema';
import {
  Button, Card, Checkbox, cn, EmptyState, Input, Textarea, toast, useVirtualizer,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, CircleSlash, Clock, Forward, Keyboard, Lock, PauseCircle, Play, Undo2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { PageSkeleton } from '@/components/guards';
import { InlineAlert, PageBody } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { formatDecimal } from '@/engines/form-renderer/values';
import { docKeys, docsApi, newIdempotencyKey, useDocType } from '@/features/documents/api';
import { dec, fmtQty } from '@/features/documents/decimal';
import { lineItemLabel, lineUom } from '@/features/documents/lines-table';
import { decisionPrefill } from '@/features/documents/extensions';
import '@/features/documents/extensions-installed';
import { DocStatusBadge } from '@/features/documents/status';
import { dueText } from '@/features/documents/workflow-progress';
import { t } from '@/i18n';
import { isApiError, type ApiError } from '@/lib/api';
import {
  draftError, initDraft, needsReason, outcome, setQty, setWhole, skip, summarize, toDecisions, type Bucket, type DraftError, type LineDraft,
} from './decision-model';
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
  const granularity = forceDocument ? 'document' : granularityOf(doc, stage);
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const onToggle = useMemo(() => toggleSel(setSelected), []);
  const [attempted, setAttempted] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'send_back' | 'forward' | 'help' | null>(null);
  const [bulkReason, setBulkReason] = useState('');
  const idemKey = useRef<string>(newIdempotencyKey());

  const update = useCallback((lineId: string, fn: (d: LineDraft) => LineDraft) => {
    setDrafts(ds => ds.map(d => (d.lineId === lineId ? fn(d) : d)));
  }, []);

  const errors = useMemo(() => {
    const m = new Map<string, DraftError>();
    for (const d of drafts) { const e = draftError(d, actions); if (e) m.set(d.lineId, e); }
    return m;
  }, [drafts, actions]);
  const summary = useMemo(() => summarize(drafts, lid => { const l = lineById.get(lid); return l ? lineUom(l) : ''; }), [drafts, lineById]);
  const toSend = drafts.filter(d => outcome(d) !== 'skip').length;

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

  const submit = useCallback(async () => {
    setAttempted(true);
    if (busy) return;
    if (errors.size) {
      const first = drafts.findIndex(d => errors.has(d.lineId));
      if (first >= 0) setActive(first);
      return;
    }
    if (!toSend) { toast(t('approve.nothingToSend')); return; }
    const next = await run('decide', { action: 'decide', stageKey: stage.key, decisions: toDecisions(drafts), ...(comment.trim() ? { comment: comment.trim() } : {}) });
    if (next) {
      setAttempted(false); setComment(''); setSelected(new Set());
      toast.success(t('approve.done', { n: toSend }));
      afterAction(next);
    }
  }, [busy, errors, drafts, toSend, run, stage.key, comment, afterAction]);

  const unhold = useCallback(async (lineIds: string[]) => {
    const next = await run(`unhold:${lineIds.join(',')}`, { action: 'unhold', stageKey: stage.key, lineIds });
    if (next) toast.success(t('approve.unheld', { n: lineIds.length }));
  }, [run, stage.key]);

  // ------------------------------------------------------------------ bulk
  const targets = selected.size ? drafts.filter(d => selected.has(d.lineId)) : drafts;
  const applyAll = (b: Bucket | 'skip') => {
    const ids = new Set(targets.map(d => d.lineId));
    setDrafts(ds => ds.map(d => {
      if (!ids.has(d.lineId)) return d;
      const n = b === 'skip' ? skip(d) : setWhole(d, b);
      return (b === 'hold' || b === 'reject') && bulkReason.trim() && !n.reason.trim() ? { ...n, reason: bulkReason.trim() } : n;
    }));
  };

  // ------------------------------------------------------------------ keyboard (j/k move, a/h/r/s set, x select, e edit, Enter submit, ? help)
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
      if (e.key === 'Enter' && (!typing || e.ctrlKey || (el?.tagName === 'INPUT' && el.dataset.submitOnEnter === 'true'))) { e.preventDefault(); void submit(); return; }
      if (typing) { if (e.key === 'Escape') { el!.blur(); } return; }
      const d = drafts[active];
      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); setActive(i => { const n = Math.min(drafts.length - 1, i + 1); focusRow(n); return n; }); break;
        case 'k': case 'ArrowUp': e.preventDefault(); setActive(i => { const n = Math.max(0, i - 1); focusRow(n); return n; }); break;
        case 'a': if (d) { e.preventDefault(); update(d.lineId, x => setWhole(x, 'approve')); } break;
        case 'h': if (d && actions.includes('hold')) { e.preventDefault(); update(d.lineId, x => setWhole(x, 'hold')); focusReason(d.lineNo); } break;
        case 'r': if (d && actions.includes('reject')) { e.preventDefault(); update(d.lineId, x => setWhole(x, 'reject')); focusReason(d.lineNo); } break;
        case 's': if (d) { e.preventDefault(); update(d.lineId, skip); } break;
        case 'x': case ' ': if (d) { e.preventDefault(); setSelected(s => { const n = new Set(s); if (n.has(d.lineId)) n.delete(d.lineId); else n.add(d.lineId); return n; }); } break;
        case 'e': if (d) { e.preventDefault(); document.querySelector<HTMLInputElement>(`[data-testid="decision-${d.lineNo}-approve"]`)?.select(); } break;
        case '?': e.preventDefault(); setDialog('help'); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, drafts, active, submit, update, actions, focusRow]);

  const priorStages = (doc.workflow?.stages ?? []).filter(s => s.status === 'done' && (doc.workflow!.stages.findIndex(x => x.key === s.key) < doc.workflow!.stages.findIndex(x => x.key === stage.key)));
  const canSendBack = actions.includes('send_back') && allowed.has('send_back');
  const canForward = actions.includes('forward') && allowed.has('forward');
  const due = dueText(stage.dueAt, stage.overdue);
  const total = doc.values.total_amount;
  const allSelected = selected.size > 0 && selected.size === drafts.length;

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
              <label className="mr-1 flex items-center gap-2 text-sm">
                <Checkbox checked={allSelected ? true : selected.size ? 'indeterminate' : false} onCheckedChange={v => setSelected(v ? new Set(drafts.map(d => d.lineId)) : new Set())} aria-label={t('approve.selectAll')} data-testid="decision-select-all" />
                <span className="hidden text-fg-muted sm:inline">{selected.size ? t('approve.applyToN', { n: selected.size }) : t('approve.applyToAll')}</span>
              </label>
              <div className="flex gap-1">
                <QuickButton tone="approve" label={t('approve.approve')} onClick={() => applyAll('approve')} testId="decision-apply-all-approve" wide />
                {actions.includes('hold') && <QuickButton tone="hold" label={t('approve.hold')} onClick={() => applyAll('hold')} testId="decision-apply-all-hold" wide />}
                {actions.includes('reject') && <QuickButton tone="reject" label={t('approve.reject')} onClick={() => applyAll('reject')} testId="decision-apply-all-reject" wide />}
                <Button variant="ghost" size="sm" onClick={() => applyAll('skip')} data-testid="decision-apply-all-skip">{t('approve.skip')}</Button>
              </div>
              <Input value={bulkReason} onChange={e => setBulkReason(e.target.value)} placeholder={t('approve.bulkReason')} aria-label={t('approve.bulkReason')} className="h-8 w-full sm:w-56" data-testid="decision-apply-all-reason" />
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setDialog('help')} className="hidden md:inline-flex" aria-keyshortcuts="?" data-testid="decision-help-open"><Keyboard aria-hidden />{t('approve.shortcuts')}</Button>
                {canSendBack && <Button variant="secondary" size="sm" onClick={() => setDialog('send_back')} data-testid="send-back"><Undo2 aria-hidden />{t('approve.sendBack.button')}</Button>}
                {canForward && <Button variant="secondary" size="sm" onClick={() => setDialog('forward')} data-testid="forward"><Forward aria-hidden />{t('approve.forward.button')}</Button>}
              </div>
            </div>

            {/* Column header (wide screens) */}
            <div className="hidden grid-cols-[2rem_2.25rem_minmax(10rem,1fr)_7rem_7.5rem_7.5rem_7.5rem_8.5rem] items-center gap-x-3 border-b border-border bg-subtle px-3 py-2 text-sm font-medium text-fg-muted md:grid" aria-hidden>
              <span /><span className="text-right">#</span><span>{t('docs.col.item')}</span><span className="text-right">{t('approve.pendingHere')}</span>
              <span className="text-right text-success">{t('approve.approve')}</span><span className="text-right text-warning">{t('approve.hold')}</span><span className="text-right text-danger">{t('approve.reject')}</span><span />
            </div>

            <div ref={listRef} role="list" aria-label={t('approve.linesLabel')} className={cn(virtual && 'overflow-y-auto')} style={virtual ? { maxHeight: 'calc(100dvh - 22rem)', minHeight: 320 } : undefined}>
              {virtual ? (
                <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                  {vItems!.map(vi => {
                    const d = drafts[vi.index]!;
                    return (
                      <div key={d.lineId} ref={virtualizer.measureElement} data-index={vi.index} className="absolute inset-x-0" style={{ transform: `translateY(${vi.start}px)` }}>
                        <DecisionRow d={d} line={lineById.get(d.lineId)!} index={vi.index} active={vi.index === active} selected={selected.has(d.lineId)} error={errors.get(d.lineId) ?? null}
                          showErrors={attempted} actions={actions} editable={editable} onActivate={setActive} onUpdate={update} onToggle={onToggle} />
                      </div>
                    );
                  })}
                </div>
              ) : drafts.map((d, i) => (
                <DecisionRow key={d.lineId} d={d} line={lineById.get(d.lineId)!} index={i} active={i === active} selected={selected.has(d.lineId)} error={errors.get(d.lineId) ?? null}
                  showErrors={attempted} actions={actions} editable={editable} onActivate={setActive} onUpdate={update} onToggle={onToggle} />
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

      {granularity === 'line' && drafts.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/95 backdrop-blur lg:left-[var(--sidebar-w)]" data-testid="decision-summary-bar">
          <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
            <p className="min-w-0 flex-1 text-sm" aria-live="polite" data-testid="decision-summary">
              <SummaryText s={summary} />
              {attempted && errors.size > 0 && <span className="ml-2 font-medium text-danger" data-testid="decision-errors">{t('approve.fixLines', { n: errors.size })}</span>}
            </p>
            <Button size="lg" className="w-full sm:w-auto" onClick={() => void submit()} loading={busy === 'decide'} disabled={!!busy || !toSend} aria-keyshortcuts="Enter" data-testid="decision-submit">
              {t('approve.submit', { n: toSend })}
            </Button>
          </div>
        </div>
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

const toggleSel = (set: Dispatch<SetStateAction<Set<string>>>) => (id: string) =>
  set(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

function focusReason(lineNo: number) {
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-testid="decision-${lineNo}-reason"]`)?.focus());
}

function SummaryText({ s }: { s: ReturnType<typeof summarize> }) {
  const parts: { text: string; cls: string }[] = [];
  if (s.approve) parts.push({ text: t('approve.sum.approve', { n: s.approve }), cls: 'text-success' });
  if (s.hold) parts.push({ text: t('approve.sum.hold', { n: s.hold }), cls: 'text-warning' });
  if (s.reject) parts.push({ text: t('approve.sum.reject', { n: s.reject }), cls: 'text-danger' });
  for (const [u, q] of Object.entries(s.reducedQty)) parts.push({ text: t('approve.sum.reduced', { qty: `${fmtQty(q)}${u ? ` ${u}` : ''}` }), cls: 'text-danger' });
  if (s.skip) parts.push({ text: t('approve.sum.skip', { n: s.skip }), cls: 'text-fg-muted' });
  if (!parts.length) return <span className="text-fg-muted">{t('approve.sum.none')}</span>;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>{i > 0 && <span className="mx-1.5 text-fg-subtle" aria-hidden>·</span>}<span className={cn('font-medium', p.cls)}>{p.text}</span></span>
      ))}
    </>
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

/** Proportions of approve / hold / reject over the pending qty; empty = left pending. */
function SplitBar({ d }: { d: LineDraft }) {
  const pa = dec.pct(d.approve, d.pending); const ph = dec.pct(d.hold, d.pending); const pr = dec.pct(d.reject, d.pending);
  const empty = pa + ph + pr === 0;
  return (
    <div className={cn('flex h-1.5 w-full overflow-hidden rounded-full', empty ? 'bg-[repeating-linear-gradient(45deg,rgb(var(--c-border))_0_4px,transparent_4px_8px)]' : 'bg-muted')} aria-hidden>
      <span className={TONE.approve.bar} style={{ width: `${Math.min(100, pa)}%` }} />
      <span className={TONE.hold.bar} style={{ width: `${Math.min(100, ph)}%` }} />
      <span className={TONE.reject.bar} style={{ width: `${Math.min(100, pr)}%` }} />
    </div>
  );
}

const ERR_KEY: Record<DraftError, Parameters<typeof t>[0]> = {
  number: 'approve.err.number', sum: 'approve.err.sum', reason: 'approve.err.reason', hold_not_allowed: 'approve.err.holdNotAllowed',
  reject_not_allowed: 'approve.err.rejectNotAllowed', partial_not_allowed: 'approve.err.partialNotAllowed',
};

const DecisionRow = memo(function DecisionRow({ d, line, index, active, selected, error, showErrors, actions, editable, onActivate, onUpdate, onToggle }: {
  d: LineDraft; line: DocumentLineRow; index: number; active: boolean; selected: boolean; error: DraftError | null; showErrors: boolean;
  actions: readonly string[]; editable: string[];
  onActivate: (i: number) => void; onUpdate: (lineId: string, fn: (d: LineDraft) => LineDraft) => void; onToggle: (id: string) => void;
}) {
  const o = outcome(d);
  const uom = lineUom(line);
  const reduced = dec.gt0(d.approve) && dec.gt0(d.reject);
  // Sum errors show live (they are about the numbers just typed); missing reasons once the user tries to submit.
  const visibleError = error && (error !== 'reason' || showErrors) ? error : null;
  const sumOff = error === 'sum' || error === 'number';
  const id = `dec-${d.lineNo}`;
  const qtyInput = (b: Bucket) => {
    const disabled = (b === 'hold' && !actions.includes('hold')) || (b === 'reject' && !actions.includes('reject'));
    const label = t(`approve.${b}`);
    return (
      <div className="min-w-0">
        <label htmlFor={`${id}-${b}`} className={cn('mb-1 block text-xs font-medium md:sr-only', b === 'approve' ? 'text-success' : b === 'hold' ? 'text-warning' : 'text-danger')}>{label}</label>
        <Input
          id={`${id}-${b}`}
          inputMode="decimal"
          autoComplete="off"
          value={d[b]}
          disabled={disabled}
          onFocus={e => { onActivate(index); e.currentTarget.select(); }}
          onChange={e => onUpdate(d.lineId, x => setQty(x, b, e.target.value.replace(/[^\d.]/g, '')))}
          aria-invalid={sumOff || undefined}
          aria-describedby={visibleError ? `${id}-err` : undefined}
          aria-label={t('approve.qtyLabel', { what: label, n: d.lineNo })}
          className={cn('h-11 text-right tabular-nums md:h-8', sumOff && 'border-danger')}
          data-testid={`decision-${d.lineNo}-${b}`}
        />
      </div>
    );
  };

  return (
    <div role="listitem" data-row-index={index} data-testid={`decision-row-${d.lineNo}`} data-outcome={o} onClick={() => onActivate(index)}
      className={cn(
        'relative border-b border-border px-3 py-3 last:border-b-0 md:py-2',
        active ? 'bg-accent-soft/60 shadow-[inset_3px_0_0_rgb(var(--c-accent))]' : 'hover:bg-subtle',
        o === 'skip' && 'bg-subtle/60',
      )}>
      <div className="grid grid-cols-[2rem_1fr_auto] items-start gap-x-3 gap-y-3 md:grid-cols-[2rem_2.25rem_minmax(10rem,1fr)_7rem_7.5rem_7.5rem_7.5rem_8.5rem] md:items-center">
        <div className="pt-0.5 md:pt-0"><Checkbox checked={selected} onCheckedChange={() => onToggle(d.lineId)} aria-label={t('approve.selectLine', { n: d.lineNo })} data-testid={`decision-${d.lineNo}-select`} /></div>
        <span className="hidden text-right text-sm text-fg-subtle tabular-nums md:block">{d.lineNo}</span>
        <div className="min-w-0">
          <p className="truncate font-medium"><span className="mr-1.5 text-sm font-normal text-fg-subtle md:hidden">{d.lineNo}</span>{lineItemLabel(line)}</p>
          <p className="text-xs text-fg-subtle">{t('approve.requested', { qty: `${fmtQty(line.qty.requested)} ${uom}`.trim() })}</p>
          <div className="mt-1.5 max-w-56"><SplitBar d={d} /></div>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums md:text-base" data-testid={`qty-pending-${d.lineNo}`} data-value={d.pending}>{fmtQty(d.pending)}</p>
          <p className="text-xs text-fg-subtle md:hidden">{uom || t('approve.pendingHere')}</p>
        </div>
        <div className="order-last col-span-3 grid grid-cols-3 gap-2 md:order-none md:col-span-1 md:contents">
          {qtyInput('approve')}
          {qtyInput('hold')}
          {qtyInput('reject')}
        </div>
        <div className="col-span-3 flex gap-2 md:col-span-1 md:justify-end md:gap-1">
          <QuickButton tone="approve" label={t('approve.approve')} short="A" pressed={o === 'approve'} onClick={() => onUpdate(d.lineId, x => setWhole(x, 'approve'))} testId={`decision-${d.lineNo}-set-approve`} />
          <QuickButton tone="hold" label={t('approve.hold')} short="H" pressed={o === 'hold'} disabled={!actions.includes('hold')} onClick={() => { onUpdate(d.lineId, x => setWhole(x, 'hold')); focusReason(d.lineNo); }} testId={`decision-${d.lineNo}-set-hold`} />
          <QuickButton tone="reject" label={t('approve.reject')} short="R" pressed={o === 'reject'} disabled={!actions.includes('reject')} onClick={() => { onUpdate(d.lineId, x => setWhole(x, 'reject')); focusReason(d.lineNo); }} testId={`decision-${d.lineNo}-set-reject`} />
        </div>
      </div>

      {(needsReason(d) || o === 'skip' || visibleError || editable.length > 0) && (
        <div className="mt-2 space-y-2 md:ml-[calc(4.25rem+1.5rem)]">
          {o === 'skip' && <p className="flex items-center gap-1.5 text-xs text-fg-muted"><CircleSlash className="size-3.5" aria-hidden />{t('approve.leftPending')}</p>}
          {needsReason(d) && (
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
              <label htmlFor={`${id}-reason`} className="shrink-0 text-xs font-medium text-fg-muted">
                {reduced ? t('approve.reasonReduce', { qty: `${fmtQty(d.reject)} ${uom}`.trim() }) : dec.gt0(d.hold) && !dec.gt0(d.reject) ? t('approve.reasonHold') : t('approve.reasonReject')}
              </label>
              <Input id={`${id}-reason`} value={d.reason} maxLength={500} onFocus={() => onActivate(index)}
                onChange={e => onUpdate(d.lineId, x => ({ ...x, reason: e.target.value }))}
                aria-invalid={(visibleError === 'reason') || undefined} data-submit-on-enter="true"
                className={cn('h-10 md:h-8', visibleError === 'reason' && 'border-danger')} data-testid={`decision-${d.lineNo}-reason`} />
            </div>
          )}
          {editable.map(f => (
            <div key={f} className="flex items-center gap-2">
              <label htmlFor={`${id}-f-${f}`} className="w-28 shrink-0 text-xs font-medium text-fg-muted">{f}</label>
              <Input id={`${id}-f-${f}`} defaultValue={String(line.values[f] ?? '')} className="h-8 max-w-40"
                onChange={e => onUpdate(d.lineId, x => ({ ...x, values: { ...(x.values ?? {}), [f]: e.target.value } }))} data-testid={`decision-${d.lineNo}-field-${f}`} />
            </div>
          ))}
          {visibleError && <p id={`${id}-err`} role="alert" className="text-xs font-medium text-danger" data-testid={`decision-${d.lineNo}-error`}>{t(ERR_KEY[visibleError], { pending: fmtQty(d.pending) })}</p>}
        </div>
      )}
    </div>
  );
});

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
