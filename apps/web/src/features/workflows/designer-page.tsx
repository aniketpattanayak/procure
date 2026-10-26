'use client';
import type { DocTypeSummary, FormDefinition, SimulateResult, Stage, WorkflowDefinition, WorkflowDetail } from '@procure/schema';
import { Badge, Button, cn, EmptyState, Skeleton, SkeletonGroup, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, ArrowLeft, CheckCircle2, FileWarning, FlaskConical, History, Redo2, Save, Send, Undo, Undo2, Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { scopeFromDefinition } from '@/engines/form-renderer/formula';
import { useDocTypes, useFormDefinition, useRoles, useUserOptions, workflowsApi } from './api';
import { PublishDialog, VersionsDialog } from './dialogs';
import { Lane, type Names, type SimStage } from './lane';
import {
  addParallel, combinedDefinition, detachStage, duplicateStage, headerUserFields, insertStage, keyFromName, lineFieldOptions,
  localIssues, mergeIssues, moveInRow, moveRow, normalize, removeStage, replaceStage, rowIndexOfStage, rowsOf, stageKeyForPath,
  uniqueStageKey, type Issue,
} from './model';
import { StagePanel, WorkflowPanel, type PanelContext } from './panels';
import { SimulatePanel } from './simulate-drawer';
import { designerReducer, initDesigner } from './state';

export function WorkflowDesignerPage({ docType }: { docType: string }) {
  const q = useQuery({ queryKey: ['wf', docType], queryFn: () => workflowsApi.get(docType), staleTime: 0, refetchOnWindowFocus: false });
  const types = useDocTypes();
  const dt = types.data?.find(x => x.key === docType);
  const headerKey = dt?.headerFormKey ?? (types.isFetched ? `${docType}_header` : null);
  const lineKey = dt ? dt.lineFormKey : types.isFetched ? `${docType}_line` : null;
  const header = useFormDefinition(headerKey);
  const line = useFormDefinition(lineKey);
  const formsReady = (!headerKey || !header.isLoading) && (!lineKey || !line.isLoading) && !types.isLoading;

  if (q.isLoading || !formsReady) {
    return (
      <SkeletonGroup label={t('common.loading')} className="flex h-[calc(100dvh-var(--topbar-h)-var(--banner-h))] flex-col">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3"><Skeleton className="h-6 w-64" /><Skeleton className="ml-auto h-8 w-72" /></div>
        <div className="flex flex-1">
          <div className="flex-1 space-y-4 p-8"><Skeleton className="mx-auto h-9 w-40 rounded-full" />{[0, 1, 2].map(i => <Skeleton key={i} className="mx-auto h-24 max-w-2xl" />)}</div>
          <Skeleton className="hidden h-full w-96 rounded-none lg:block" />
        </div>
      </SkeletonGroup>
    );
  }
  if (q.error || !q.data) {
    const notFound = isApiError(q.error) && q.error.status === 404;
    return <EmptyState icon={<FileWarning />} title={notFound ? t('wf.notFound') : t('wf.loadError')} description={isApiError(q.error) ? q.error.message : undefined}
      action={<Button variant="secondary" onClick={() => void q.refetch()}>{t('common.retry')}</Button>} />;
  }
  return <Designer key={q.data.id} initial={q.data} docType={docType} docTypeInfo={dt ?? null} header={header.data ?? null} line={line.data ?? null} />;
}

function IssuesBar({ def, issues, stale, onSelect }: { def: WorkflowDefinition; issues: Issue[]; stale: boolean; onSelect: (key: string | null) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <section aria-labelledby="wf-issues-h" data-testid="wf-issues" data-count={issues.length} className="border-b border-border">
      <h2 id="wf-issues-h" className="flex items-center gap-2 px-4 pb-1.5 pt-3 text-sm font-semibold">
        {issues.length ? <AlertCircle className="size-4 text-danger" aria-hidden /> : <CheckCircle2 className="size-4 text-success" aria-hidden />}
        <span className="flex-1">{issues.length ? t('wf.issues.count', { n: issues.length }) : t('wf.issues.none')}</span>
        {issues.length > 0 && (
          <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? t('wf.issues.hide') : t('wf.issues.show')}
          </button>
        )}
      </h2>
      {stale && <p className="px-4 pb-1 text-xs text-fg-subtle">{t('wf.issues.stale')}</p>}
      {open && issues.length > 0 && (
        <ul className="max-h-44 space-y-0.5 overflow-y-auto px-2 pb-2">
          {issues.map((i, n) => {
            const key = stageKeyForPath(def, i.path);
            const stage = key ? def.stages.find(s => s.key === key) : undefined;
            return (
              <li key={`${i.path}-${i.code}-${n}`}>
                <button type="button" onClick={() => onSelect(key)} data-testid="wf-issue" data-code={i.code}
                  className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-danger-soft focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="block text-xs font-medium text-fg-muted">{stage ? stage.name || stage.key : t('wf.issues.workflow')}</span>
                  <span className="text-danger">{i.message}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Designer({ initial, docType, docTypeInfo, header, line }: { initial: WorkflowDetail; docType: string; docTypeInfo: DocTypeSummary | null; header: FormDefinition | null; line: FormDefinition | null }) {
  const qc = useQueryClient();
  const perms = usePermissions();
  const canEdit = perms.has('config.workflows:action.edit');
  const canPublish = perms.has('config.workflows:action.publish');
  const [detail, setDetail] = useState(initial);
  const savedDef = useMemo(() => normalize(detail.draft ?? detail.published), [detail]);
  const [state, dispatch] = useReducer(designerReducer, savedDef, initDesigner);
  const def = state.def;
  const defJson = useMemo(() => JSON.stringify(def), [def]);
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(savedDef));
  const dirty = defJson !== savedJson;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [pane, setPane] = useState<'canvas' | 'props'>('canvas');
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  // The simulation panel stays mounted once opened so its sample values survive switching to stage settings.
  const [simMounted, setSimMounted] = useState(false);
  useEffect(() => { if (simOpen) setSimMounted(true); }, [simOpen]);
  const [sim, setSim] = useState<{ forJson: string; result: SimulateResult } | null>(null);

  // ---------------------------------------------------------------- names + formula scope
  const roles = useRoles();
  const users = useUserOptions('');
  const userNames = useRef(new Map<string, string>());
  for (const u of users.data ?? []) userNames.current.set(u.id, u.name);
  const userFields = useMemo(() => headerUserFields(header), [header]);
  const headerLabels = useMemo(() => new Map((header?.fields ?? []).map(f => [f.key, 'label' in f && f.label ? f.label : f.key])), [header]);
  const names: Names = useMemo(() => ({
    role: id => roles.data?.find(r => r.id === id)?.name ?? t('wf.actor.unknownRole'),
    user: id => userNames.current.get(id) ?? t('wf.actor.userShort', { id: id.slice(0, 8) }),
    field: key => headerLabels.get(key) ?? key,
  }), [roles.data, users.data, headerLabels]);
  const combined = useMemo(() => combinedDefinition(header, line), [header, line]);
  const scope = useMemo(() => (header ? scopeFromDefinition(combined) : null), [combined, header]);
  const lineFields = useMemo(() => lineFieldOptions(line), [line]);

  // ---------------------------------------------------------------- issues: local (instant) + server (for the saved draft)
  const issues = useMemo(() => {
    const local = localIssues(def, {
      scope,
      availableEffects: detail.availableEffects,
      headerFields: header ? new Set(header.fields.map(f => f.key)) : null,
      lineFields: line ? new Set(line.fields.map(f => f.key)) : null,
      roleIds: roles.data ? new Set(roles.data.map(r => r.id)) : null,
      msg: (code, vars) => t(`wf.check.${code}` as 'wf.check.duplicate', vars),
    });
    const server: Issue[] = !dirty && detail.draft ? detail.draftIssues : [];
    return mergeIssues(server, local);
  }, [def, scope, detail, header, line, roles.data, dirty]);
  const issuesByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of issues) { const k = stageKeyForPath(def, i.path); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [issues, def]);

  // ---------------------------------------------------------------- edits
  const change = useCallback((d: WorkflowDefinition, tag?: string, select?: string | null) => dispatch({ type: 'change', def: d, tag, select }), []);
  const publishedKeys = useMemo(() => new Set((detail.published?.stages ?? []).map(s => s.key)), [detail.published]);
  const select = useCallback((key: string | null) => { dispatch({ type: 'select', key }); setSimOpen(false); setPane('props'); }, []);
  const newName = () => t('wf.newStageN', { n: def.stages.length + 1 });

  const focusStage = (key: string) => setTimeout(() => {
    const el = document.querySelector<HTMLElement>(`[data-testid="wf-stage-${key}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, 40);

  const insert = useCallback((rowIndex: number) => {
    const r = insertStage(def, rowIndex, newName());
    change(r.def, undefined, r.key);
    setPane('props');
    focusStage(r.key);
  }, [def, change]);
  const parallel = useCallback((rowIndex: number) => {
    const r = addParallel(def, rowIndex, newName());
    change(r.def, undefined, r.key);
    setPane('props');
    focusStage(r.key);
  }, [def, change]);

  const onAction = useCallback((key: string, action: 'duplicate' | 'delete' | 'detach' | 'left' | 'right' | 'up' | 'down' | 'toggle') => {
    const stage = def.stages.find(s => s.key === key);
    if (!stage) return;
    switch (action) {
      case 'delete':
        change(removeStage(def, key), undefined, state.selected === key ? null : state.selected);
        toast(t('wf.removed', { name: stage.name || key }), { description: t('wf.removedHint') });
        break;
      case 'duplicate': { const r = duplicateStage(def, key, n => t('wf.copyOf', { name: n })); change(r.def, undefined, r.key); focusStage(r.key); break; }
      case 'detach': change(detachStage(def, key)); break;
      case 'left': change(moveInRow(def, key, -1)); break;
      case 'right': change(moveInRow(def, key, 1)); break;
      case 'up': case 'down': {
        const ri = rowIndexOfStage(def.stages, key);
        change(moveRow(def, ri, ri + (action === 'up' ? -1 : 1)));
        focusStage(key);
        break;
      }
      case 'toggle': change(replaceStage(def, key, { ...stage, enabled: !stage.enabled })); break;
    }
  }, [def, change, state.selected]);

  const selectedStage = state.selected ? def.stages.find(s => s.key === state.selected) : undefined;
  const update = useCallback((patch: Partial<Stage> & { __keyTouched?: boolean }, tag?: string) => {
    if (!selectedStage) return;
    const { __keyTouched, ...rest } = patch;
    let next: Stage = { ...selectedStage, ...rest };
    if ('name' in rest && typeof rest.name === 'string' && !state.keyTouched.has(selectedStage.key) && !publishedKeys.has(selectedStage.key)) {
      const taken = new Set(def.stages.map(s => s.key));
      taken.delete(selectedStage.key);
      next = { ...next, key: uniqueStageKey(keyFromName(rest.name || 'stage'), taken) };
    }
    if (__keyTouched) dispatch({ type: 'touchKey', key: next.key });
    change(replaceStage(def, selectedStage.key, next), tag ? `${selectedStage.key}:${tag}` : undefined, next.key);
  }, [selectedStage, def, state.keyTouched, publishedKeys, change]);

  // ---------------------------------------------------------------- save / discard / publish
  async function save(): Promise<WorkflowDetail | null> {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await workflowsApi.saveDraft(docType, def, detail.version);
      setDetail(r);
      setSavedJson(defJson);
      qc.setQueryData(['wf', docType], r);
      void qc.invalidateQueries({ queryKey: ['wf-list'] });
      toast.success(r.draftIssues.length ? t('wf.savedWithIssues', { n: r.draftIssues.length }) : t('wf.saved'));
      return r;
    } catch (e) {
      const conflict = isApiError(e) && (e.status === 409 || e.is('VERSION_CONFLICT') || e.is('CONFLICT'));
      setSaveError({ message: conflict ? t('wf.conflict') : isApiError(e) ? [e.message, ...e.errors.map(x => x.message)].join(' · ') : String(e), conflict });
      return null;
    } finally {
      setSaving(false);
    }
  }
  async function reloadLatest() {
    const r = await workflowsApi.get(docType);
    setDetail(r);
    const base = normalize(r.draft ?? r.published);
    setSavedJson(JSON.stringify(base));
    dispatch({ type: 'load', def: base });
    setSaveError(null);
  }
  async function discard() {
    if (!window.confirm(t('wf.discardConfirm'))) return;
    try {
      const r = detail.draft ? await workflowsApi.discardDraft(docType) : detail;
      setDetail(r);
      const base = normalize(r.draft ?? r.published);
      setSavedJson(JSON.stringify(base));
      dispatch({ type: 'load', def: base });
      qc.setQueryData(['wf', docType], r);
      void qc.invalidateQueries({ queryKey: ['wf-list'] });
      toast.success(t('wf.discarded'));
    } catch (e) {
      toast.error(t('wf.discardFailed'), isApiError(e) ? e.message : undefined);
    }
  }
  async function publish(note: string) {
    let d = detail;
    if (dirty || !detail.draft) {
      const r = await save();
      if (!r) throw new Error(t('wf.publishSaveFailed'));
      d = r;
    }
    const r = await workflowsApi.publish(docType, d.version, note);
    setDetail(r);
    const base = normalize(r.draft ?? r.published);
    setSavedJson(JSON.stringify(base));
    dispatch({ type: 'load', def: base });
    qc.setQueryData(['wf', docType], r);
    void qc.invalidateQueries({ queryKey: ['wf-list'] });
    void qc.invalidateQueries({ queryKey: ['wf-versions', docType] });
    void qc.invalidateQueries({ queryKey: ['doc-types'] });
    toast.success(t('wf.published', { n: r.publishedVersion ?? '' }));
  }

  // ---------------------------------------------------------------- keyboard + unsaved guard
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const editing = el.closest('input, textarea, select, [contenteditable="true"]');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (canEdit) void saveRef.current(); return; }
      if (editing) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); dispatch({ type: 'undo' }); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); dispatch({ type: 'redo' }); }
      else if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) dispatch({ type: 'select', key: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit]);

  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    // App Router has no navigation-blocking API: intercept in-app link clicks while there are unsaved changes.
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
      if (!window.confirm(t('wf.leaveConfirm'))) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', before);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', before); document.removeEventListener('click', click, true); };
  }, [dirty]);

  // ---------------------------------------------------------------- simulation (only shown on the canvas for the definition it ran on)
  const simMap = useMemo(() => {
    if (!sim || sim.forJson !== defJson) return null;
    return new Map<string, SimStage>(sim.result.stages.map(s => [s.key, s]));
  }, [sim, defJson]);

  const ctx: PanelContext = {
    def, formula: combined, actors: { roles: roles.data ?? [], userFields, userName: names.user }, lineFields,
    available: detail.availableEffects, docType, canEdit,
  };
  const rows = rowsOf(def.stages);
  const summary = t('wf.summary', {
    stages: def.stages.length, rows: rows.length,
    conditional: def.stages.filter(s => s.when?.trim()).length,
    sla: def.stages.filter(s => s.sla).length,
  });
  const status = saving ? t('wf.status.saving') : dirty ? t('wf.status.unsaved') : detail.draft ? t('wf.status.draftSaved') : detail.publishedVersion ? t('wf.status.published') : t('wf.status.empty');
  const stageIssues = selectedStage ? issues.filter(i => stageKeyForPath(def, i.path) === selectedStage.key) : [];
  const workflowIssues = issues.filter(i => !stageKeyForPath(def, i.path));
  const name = docTypeInfo?.name ?? detail.name;

  return (
    <div className="flex h-[calc(100dvh-var(--topbar-h)-var(--banner-h))] min-h-[32rem] flex-col bg-bg" data-testid="wf-designer" data-dirty={dirty || undefined}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
        <Button asChild variant="ghost" size="icon-sm" aria-label={t('wf.back')}><Link href="/config/workflows"><ArrowLeft /></Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-md font-semibold">
            <Workflow className="size-4 shrink-0 text-fg-subtle" aria-hidden />
            <span className="truncate">{t('wf.designerTitle', { name })}</span>
            <Badge tone={detail.publishedVersion ? 'accent' : 'neutral'}>{detail.publishedVersion ? t('wf.versionN', { n: detail.publishedVersion }) : t('wf.unpublished')}</Badge>
          </h1>
          <p className={cn('text-xs', dirty ? 'text-warning' : 'text-fg-subtle')} aria-live="polite" data-testid="wf-status">{status}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" onClick={() => dispatch({ type: 'undo' })} disabled={!state.past.length} aria-label={t('wf.undo')} title={t('wf.undoHint')} data-testid="wf-undo"><Undo2 /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => dispatch({ type: 'redo' })} disabled={!state.future.length} aria-label={t('wf.redo')} title={t('wf.redoHint')} data-testid="wf-redo"><Redo2 /></Button>
          <Button variant={simOpen ? 'primary' : 'secondary'} size="sm" onClick={() => { setSimOpen(o => !o); setPane(simOpen ? 'canvas' : 'props'); }} aria-pressed={simOpen} data-testid="wf-simulate"><FlaskConical aria-hidden />{t('wf.simulate')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setVersionsOpen(true)} aria-label={t('wf.versions')} data-testid="wf-versions"><History aria-hidden /><span className="hidden sm:inline">{t('wf.versions')}</span></Button>
          {canEdit && (detail.draft || dirty) && <Button variant="ghost" size="sm" onClick={discard} data-testid="wf-discard"><Undo aria-hidden /><span className="hidden sm:inline">{t('wf.discard')}</span></Button>}
          {canEdit && <Button variant="secondary" size="sm" onClick={() => void save()} loading={saving} disabled={!dirty} data-testid="wf-save"><Save aria-hidden />{t('wf.saveDraft')}</Button>}
          {canPublish && (
            <Button size="sm" onClick={() => setPublishOpen(true)} disabled={issues.length > 0 || saving || (!dirty && !detail.draft)} data-testid="wf-publish"
              title={issues.length ? t('wf.publishBlocked', { n: issues.length }) : undefined}>
              <Send aria-hidden />{t('wf.publish')}
            </Button>
          )}
        </div>
      </div>
      {saveError && (
        <InlineAlert className="m-2" data-testid="wf-save-error">
          {saveError.message}
          {saveError.conflict && <Button size="sm" variant="secondary" className="ml-2" onClick={() => void reloadLatest()}>{t('wf.reload')}</Button>}
        </InlineAlert>
      )}
      {!canEdit && <InlineAlert tone="info" className="m-2">{t('wf.readOnlyNotice')}</InlineAlert>}
      {!header && <InlineAlert tone="warning" className="m-2">{t('wf.noHeaderForm')}</InlineAlert>}

      {/* Small screens: one pane at a time */}
      <div className="flex border-b border-border bg-surface lg:hidden" role="tablist" aria-label={t('wf.panes')}>
        {(['canvas', 'props'] as const).map(p => (
          <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)}
            className={cn('-mb-px flex-1 border-b-2 py-2 text-sm font-medium', pane === p ? 'border-accent text-fg' : 'border-transparent text-fg-muted')}>
            {t(`wf.pane.${p}` as 'wf.pane.canvas')}{p === 'props' && issues.length > 0 ? ` (${issues.length})` : ''}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <main
          className={cn('min-w-0 flex-1 overflow-y-auto bg-subtle lg:block', pane === 'canvas' ? 'block' : 'hidden')}
          style={{ backgroundImage: 'radial-gradient(rgb(var(--c-border)) 1px, transparent 1px)', backgroundSize: '18px 18px' }}
          aria-label={t('wf.pane.canvas')}
          onClick={e => { if (e.target === e.currentTarget) dispatch({ type: 'select', key: null }); }}
        >
          {simMap && (
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-success/30 bg-success-soft px-4 py-1.5 text-sm text-success" data-testid="wf-sim-banner">
              <FlaskConical className="size-4" aria-hidden />
              <span className="flex-1">{t('wf.sim.onCanvas')}</span>
              <button type="button" className="font-medium underline-offset-4 hover:underline" onClick={() => setSim(null)}>{t('wf.sim.clear')}</button>
            </div>
          )}
          <Lane
            def={def} selected={state.selected} issuesByKey={issuesByKey} sim={simMap} names={names} readOnly={!canEdit}
            onSelect={select} onInsert={insert} onAddParallel={parallel}
            onMoveRow={(a, b) => change(moveRow(def, a, b))} onAction={onAction}
          />
        </main>
        {simMounted && (
          <aside className={cn('w-full shrink-0 flex-col border-l border-border bg-surface lg:w-[34rem] xl:w-[40rem]', !simOpen ? 'hidden' : pane === 'props' ? 'flex' : 'hidden lg:flex')} aria-label={t('wf.sim.title')}>
            <SimulatePanel
              onClose={() => setSimOpen(false)} docType={docType} combined={combined} hasPublished={!!detail.published} dirty={dirty} canEdit={canEdit}
              onSave={async () => !!(await save())}
              result={sim?.result ?? null}
              onResult={r => setSim(r ? { forJson: defJson, result: r } : null)}
            />
          </aside>
        )}
        <aside className={cn('w-full shrink-0 flex-col overflow-y-auto border-l border-border bg-surface lg:w-96', simOpen ? 'hidden' : pane === 'props' ? 'flex lg:flex' : 'hidden lg:flex')} aria-label={t('wf.pane.props')}>
          <IssuesBar def={def} issues={issues} stale={dirty && !!detail.draft && detail.draftIssues.length > 0} onSelect={k => select(k)} />
          {selectedStage ? (
            <StagePanel key={selectedStage.key} stage={selectedStage} update={update} keyLocked={publishedKeys.has(selectedStage.key)} issues={stageIssues} ctx={ctx} />
          ) : (
            <WorkflowPanel def={def} change={change} ctx={ctx} issues={workflowIssues} onAddStage={() => insert(rows.length)} />
          )}
        </aside>
      </div>

      <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} onPublish={publish} nextVersion={(detail.publishedVersion ?? 0) + 1} issues={issues.length} summary={summary} />
      <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} docType={docType} current={detail.publishedVersion} names={names} />
    </div>
  );
}

export default WorkflowDesignerPage;
