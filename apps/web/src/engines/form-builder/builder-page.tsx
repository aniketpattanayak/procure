'use client';
import {
  closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { Field, FieldType, FormDefinition, FormDefinitionIssue, FormDetail, FormulaScope, GridColumn } from '@procure/schema';
import { Badge, Button, cn, EmptyState, Skeleton, SkeletonGroup, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, FileWarning, History, PencilRuler, Redo2, Save, Send, Undo2, Undo } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { checkDefinition, formulaTypeOf, isDataField } from '@/engines/form-renderer/formula';
import { formsApi, useTargetForms } from './api';
import { Canvas } from './canvas';
import { allKeys, createField, duplicateField, keyFromLabel, typeInfo, uniqueKey } from './catalog';
import { selectionForPath, IssuesList } from './issues';
import { localIssues, mergeIssues } from './local-checks';
import { Palette } from './palette';
import { PropertiesPanel } from './properties';
import { PublishDialog, VersionsDialog } from './dialogs';
import { BuilderPreview } from './preview';
import { builderReducer, findField, initBuilder, renameKeyRefs, replaceField, type Selection } from './state';

const EMPTY_DEF: FormDefinition = { version: 1, fields: [], validations: [] };

/** Line form key of a document type's header form (`<type>_header` → `<type>_line`), else null. */
const lineFormKeyOf = (formKey: string) => (formKey.endsWith('_header') ? `${formKey.slice(0, -'_header'.length)}_line` : null);

/**
 * Formula scope of a document type header form: the header plus the line form as the virtual grid `lines` (appended
 * last so header paths keep their indices), as the server composes it (QA3-BUG-015: `SUM(lines.amount)`).
 */
function withLinesGrid(def: FormDefinition, line: FormDefinition | null | undefined): FormDefinition {
  const cols = (line?.fields ?? []).filter(f => isDataField(f) && !f.removed && f.type !== 'grid');
  if (!cols.length) return def;
  const grid = {
    key: 'lines', type: 'grid', label: 'Lines', columns: cols, minRows: 0, maxRows: 200, system: false, required: false, readOnly: false,
    hidden: false, unique: false, removed: false, width: 12,
  } as unknown as Field;
  return { ...def, fields: [...def.fields.filter(f => f.key !== 'lines'), grid] };
}

function defaultLabel(type: FieldType) {
  if (type === 'section') return t('fb.new.section');
  if (type === 'tab') return t('fb.new.tab');
  if (type === 'help') return t('fb.new.help');
  return t(typeInfo(type).label);
}

/** Collect published keys/types (keys and types are immutable once published). */
function publishedIndex(def: FormDefinition | null) {
  const types = new Map<string, string>();
  const system = new Set<string>();
  for (const f of def?.fields ?? []) {
    types.set(f.key, f.type);
    if ('system' in f && f.system) system.add(f.key);
    if (f.type === 'grid') for (const c of f.columns) types.set(c.key, c.type);
  }
  return { types, system };
}

export function FormBuilderPage({ formKey }: { formKey: string }) {
  const q = useQuery({ queryKey: ['config-form', formKey], queryFn: () => formsApi.get(formKey), staleTime: 0, refetchOnWindowFocus: false });
  if (q.isLoading) {
    return (
      <SkeletonGroup label={t('common.loading')} className="flex h-[calc(100dvh-var(--topbar-h))] flex-col">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3"><Skeleton className="h-6 w-56" /><Skeleton className="ml-auto h-8 w-64" /></div>
        <div className="flex flex-1 gap-0">
          <Skeleton className="hidden h-full w-60 rounded-none lg:block" />
          <div className="flex-1 space-y-3 p-6"><Skeleton className="mx-auto h-16 max-w-4xl" /><Skeleton className="mx-auto h-16 max-w-4xl" /><Skeleton className="mx-auto h-16 max-w-4xl" /></div>
          <Skeleton className="hidden h-full w-80 rounded-none lg:block" />
        </div>
      </SkeletonGroup>
    );
  }
  if (q.error || !q.data) {
    const notFound = isApiError(q.error) && q.error.status === 404;
    return <EmptyState icon={<FileWarning />} title={notFound ? t('fb.notFound') : t('fb.loadError')} description={isApiError(q.error) ? q.error.message : undefined}
      action={<Button variant="secondary" onClick={() => void q.refetch()}>{t('common.retry')}</Button>} />;
  }
  return <Builder detail={q.data} />;
}

function Builder({ detail: initial }: { detail: FormDetail }) {
  const qc = useQueryClient();
  const perms = usePermissions();
  const canEdit = perms.has('config.forms:action.edit');
  const canPublish = perms.has('config.forms:action.publish');
  const [detail, setDetail] = useState(initial);
  const savedDef = detail.draft ?? detail.published ?? EMPTY_DEF;
  const [state, dispatch] = useReducer(builderReducer, savedDef, initBuilder);
  const def = state.def;
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(savedDef));
  const dirty = JSON.stringify(def) !== savedJson;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [pane, setPane] = useState<'palette' | 'canvas' | 'props'>('canvas');
  const [publishOpen, setPublishOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [dragType, setDragType] = useState<FieldType | null>(null);

  const pub = useMemo(() => publishedIndex(detail.published), [detail.published]);
  // Document type header forms see their line form as `lines` in formulas and conditions (QA3-BUG-015).
  const lineKey = lineFormKeyOf(detail.key);
  const lineForm = useQuery({ queryKey: ['config-form', lineKey], queryFn: () => formsApi.get(lineKey!), enabled: !!lineKey, retry: false, staleTime: 60_000 });
  const lineDef = lineForm.data ? (lineForm.data.published ?? lineForm.data.draft) : null;
  const scopeDef = useMemo(() => withLinesGrid(def, lineDef), [def, lineDef]);

  // ---------------------------------------------------------------- lookups -> target forms (pickers + formula attributes)
  const masterKeys = useMemo(() => {
    const ks: string[] = [];
    for (const f of def.fields) {
      if ((f.type === 'lookup' || f.type === 'multilookup') && f.source.kind === 'master') ks.push(f.source.masterKey);
      if (f.type === 'grid') for (const c of f.columns) if ((c.type === 'lookup' || c.type === 'multilookup') && c.source.kind === 'master') ks.push(c.source.masterKey);
    }
    return ks;
  }, [def]);
  const { masters, forms: targetForms } = useTargetForms(masterKeys);
  const lookupAttributes = useMemo<FormulaScope['lookupAttributes']>(() => {
    const out: FormulaScope['lookupAttributes'] = {};
    const add = (key: string, mk: string) => {
      const tdef = targetForms.get(mk);
      const attrs: Record<string, ReturnType<typeof formulaTypeOf>> = { code: 'text', name: 'text' };
      for (const tf of tdef?.fields ?? []) if (isDataField(tf) && !tf.removed && tf.type !== 'grid') attrs[tf.key] = formulaTypeOf(tf);
      out[key] = attrs;
    };
    for (const f of def.fields) {
      if (f.type === 'lookup' && f.source.kind === 'master') add(f.key, f.source.masterKey);
      if (f.type === 'grid') for (const c of f.columns) if (c.type === 'lookup' && c.source.kind === 'master') add(c.key, c.source.masterKey);
    }
    return out;
  }, [def, targetForms]);

  // ---------------------------------------------------------------- issues: local + engine (instant) + server (debounced)
  const [serverIssues, setServerIssues] = useState<{ forJson: string; issues: FormDefinitionIssue[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const defJson = useMemo(() => JSON.stringify(def), [def]);
  useEffect(() => {
    if (!canEdit || def.fields.length === 0) return;
    const ctl = new AbortController();
    const id = setTimeout(async () => {
      setChecking(true);
      try {
        const r = await formsApi.validate(def, detail.key);
        if (!ctl.signal.aborted) setServerIssues({ forJson: defJson, issues: r.issues });
      } catch { /* the live check is advisory; save/publish re-validate */ } finally {
        if (!ctl.signal.aborted) setChecking(false);
      }
    }, 800);
    return () => { ctl.abort(); clearTimeout(id); };
  }, [defJson]);
  const issues = useMemo(() => mergeIssues(
    localIssues(def, pub.types, pub.system),
    // Issues of the virtual `lines` grid itself belong to the line form, not this one.
    checkDefinition(scopeDef, lookupAttributes).filter(i => scopeDef === def || !(i.path === `fields.${scopeDef.fields.length - 1}` || i.path.startsWith(`fields.${scopeDef.fields.length - 1}.`))),
    serverIssues?.forJson === defJson ? serverIssues.issues : [],
    def.fields.length === 0 ? [{ path: 'fields', code: 'LAYOUT_ORDER', message: t('fb.check.empty') } as FormDefinitionIssue] : [],
  ), [def, scopeDef, defJson, pub, lookupAttributes, serverIssues]);

  const issuesByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of issues) { const s = selectionForPath(def, i.path); if (s) m.set(s.key, (m.get(s.key) ?? 0) + 1); }
    return m;
  }, [issues, def]);
  const selectedIssues = useMemo(() => issues.filter(i => {
    const s = selectionForPath(def, i.path);
    return s && state.selected && s.key === state.selected.key && (s.col ?? null) === (state.selected.col ?? null);
  }), [issues, def, state.selected]);

  // ---------------------------------------------------------------- mutations of the draft
  const change = useCallback((d: FormDefinition, tag?: string, select?: Selection | null) => dispatch({ type: 'change', def: d, tag, select }), []);

  const addField = useCallback((type: FieldType, at?: number) => {
    const f = createField(type, defaultLabel(type), allKeys(def));
    const fields = [...def.fields];
    let index = at;
    if (index === undefined) {
      const selIdx = state.selected && !state.selected.col ? fields.findIndex(x => x.key === state.selected!.key) : -1;
      index = selIdx >= 0 ? selIdx + 1 : fields.length;
    }
    fields.splice(index, 0, f);
    change({ ...def, fields }, undefined, { key: f.key });
    setPane('props');
    setTimeout(() => document.querySelector<HTMLElement>(`[data-testid="canvas-field-${f.key}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  }, [def, state.selected, change]);

  const update = useCallback((patch: Record<string, unknown>, tag?: string) => {
    const sel = state.selected;
    if (!sel) return;
    const cur = findField(def, sel) as (Field | GridColumn) | undefined;
    if (!cur) return;
    const { __keyTouched, ...rest } = patch;
    let next = { ...cur, ...rest } as Field | GridColumn;
    const system = 'system' in cur && cur.system;
    if ('label' in rest && typeof rest.label === 'string' && !state.keyTouched.has(cur.key) && !pub.types.has(cur.key) && !system) {
      const taken = allKeys(def);
      taken.delete(cur.key);
      next = { ...next, key: uniqueKey(keyFromLabel(rest.label || 'field'), taken) } as Field | GridColumn;
    }
    let d = replaceField(def, sel, next);
    let newSel: Selection = sel;
    if (next.key !== cur.key) {
      d = renameKeyRefs(d, cur.key, next.key);
      newSel = sel.col ? { key: sel.key, col: next.key } : { key: next.key };
    }
    if (__keyTouched) dispatch({ type: 'touchKey', key: next.key });
    change(d, tag, newSel);
  }, [def, state.selected, state.keyTouched, pub.types, change]);

  const onGridChange = useCallback((gridKey: string, columns: GridColumn[], select?: Selection) => {
    change({ ...def, fields: def.fields.map(f => (f.key === gridKey && f.type === 'grid' ? { ...f, columns } : f)) }, undefined, select);
  }, [def, change]);

  const duplicate = useCallback((key: string) => {
    const i = def.fields.findIndex(f => f.key === key);
    if (i < 0) return;
    const copy = duplicateField(def.fields[i]!, allKeys(def));
    const fields = [...def.fields];
    fields.splice(i + 1, 0, copy);
    change({ ...def, fields }, undefined, { key: copy.key });
  }, [def, change]);

  const remove = useCallback((key: string) => {
    const f = def.fields.find(x => x.key === key);
    if (!f || ('system' in f && f.system)) return;
    change({ ...def, fields: def.fields.filter(x => x.key !== key) }, undefined, state.selected?.key === key ? null : state.selected);
    toast(t('fb.removed', { label: 'label' in f && f.label ? f.label : f.key }), { description: t('fb.removedHint') });
  }, [def, change, state.selected]);

  const move = useCallback((key: string, dir: -1 | 1) => {
    const i = def.fields.findIndex(f => f.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= def.fields.length) return;
    change({ ...def, fields: arrayMove(def.fields, i, j) });
    setTimeout(() => document.querySelector<HTMLElement>(`[data-testid="canvas-select-${key}"]`)?.focus(), 0);
  }, [def, change]);

  // ---------------------------------------------------------------- drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setDragType(id.startsWith('palette:') ? (id.slice(8) as FieldType) : null);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragType(null);
    const id = String(e.active.id);
    const over = e.over ? String(e.over.id) : null;
    if (id.startsWith('palette:')) {
      if (!over) return;
      const at = over === 'canvas-end' ? def.fields.length : def.fields.findIndex(f => f.key === over);
      addField(id.slice(8) as FieldType, at < 0 ? def.fields.length : at);
      return;
    }
    if (!over || over === id) return;
    const from = def.fields.findIndex(f => f.key === id);
    const to = over === 'canvas-end' ? def.fields.length - 1 : def.fields.findIndex(f => f.key === over);
    if (from < 0 || to < 0) return;
    change({ ...def, fields: arrayMove(def.fields, from, to) });
  };

  // ---------------------------------------------------------------- save / discard / publish
  async function save(): Promise<FormDetail | null> {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await formsApi.saveDraft(detail.key, def, detail.version);
      setDetail(r);
      setSavedJson(JSON.stringify(def));
      qc.setQueryData(['config-form', detail.key], r);
      setServerIssues({ forJson: JSON.stringify(def), issues: r.draftIssues });
      toast.success(t('fb.saved'));
      return r;
    } catch (e) {
      const msg = isApiError(e) && (e.status === 409 || e.is('CONFLICT') || e.is('VERSION_CONFLICT')) ? t('fb.conflict') : isApiError(e) ? e.message : String(e);
      setSaveError(msg);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function discard() {
    if (!window.confirm(t('fb.discardConfirm'))) return;
    try {
      const r = detail.draft ? await formsApi.discardDraft(detail.key) : detail;
      setDetail(r);
      const base = r.draft ?? r.published ?? EMPTY_DEF;
      setSavedJson(JSON.stringify(base));
      dispatch({ type: 'load', def: base });
      qc.setQueryData(['config-form', detail.key], r);
      toast.success(t('fb.discarded'));
    } catch (e) {
      toast.error(t('fb.discardFailed'), isApiError(e) ? e.message : undefined);
    }
  }

  async function publish(note: string) {
    let d = detail;
    if (dirty || !detail.draft) {
      const r = await save();
      if (!r) throw new Error(t('fb.publishSaveFailed'));
      d = r;
    }
    const r = await formsApi.publish(d.key, d.version, note);
    setDetail(r);
    const base = r.draft ?? r.published ?? EMPTY_DEF;
    setSavedJson(JSON.stringify(base));
    dispatch({ type: 'load', def: base });
    qc.setQueryData(['config-form', d.key], r);
    void qc.invalidateQueries({ queryKey: ['form-render', d.key] });
    void qc.invalidateQueries({ queryKey: ['config-form-versions', d.key] });
    toast.success(t('fb.published', { n: r.currentVersion ?? '' }));
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
      if (!window.confirm(t('fb.leaveConfirm'))) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', before);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', before); document.removeEventListener('click', click, true); };
  }, [dirty]);

  const selectedField = state.selected ? findField(def, state.selected) : undefined;
  const select = (s: Selection | null) => { dispatch({ type: 'select', sel: s }); if (s) setPane('props'); };

  const status = saving ? t('fb.status.saving') : dirty ? t('fb.status.unsaved') : detail.hasDraft || detail.draft ? t('fb.status.draftSaved') : t('fb.status.published');

  return (
    <div className="flex h-[calc(100dvh-var(--topbar-h)-var(--banner-h))] min-h-[32rem] flex-col bg-bg" data-testid="form-builder">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
        <Button asChild variant="ghost" size="icon-sm" aria-label={t('fb.back')}><Link href="/config/forms"><ArrowLeft /></Link></Button>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-md font-semibold">
            <PencilRuler className="size-4 text-fg-subtle" aria-hidden />{detail.name}
            <Badge tone={detail.currentVersion ? 'accent' : 'neutral'}>{detail.currentVersion ? t('fb.versionN', { n: detail.currentVersion }) : t('fb.unpublished')}</Badge>
          </h1>
          <p className={cn('text-xs', dirty ? 'text-warning' : 'text-fg-subtle')} aria-live="polite" data-testid="builder-status">{status}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="icon-sm" onClick={() => dispatch({ type: 'undo' })} disabled={!state.past.length} aria-label={t('fb.undo')} title={t('fb.undoHint')} data-testid="builder-undo"><Undo2 /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => dispatch({ type: 'redo' })} disabled={!state.future.length} aria-label={t('fb.redo')} title={t('fb.redoHint')} data-testid="builder-redo"><Redo2 /></Button>
          <Button variant={preview ? 'primary' : 'secondary'} size="sm" onClick={() => setPreview(p => !p)} aria-pressed={preview} data-testid="builder-preview-toggle"><Eye aria-hidden />{t('fb.preview')}</Button>
          <Button variant="ghost" size="sm" onClick={() => setVersionsOpen(true)} aria-label={t('fb.versions')} data-testid="builder-versions"><History aria-hidden /><span className="hidden sm:inline">{t('fb.versions')}</span></Button>
          {canEdit && (detail.draft || dirty) && <Button variant="ghost" size="sm" onClick={discard} data-testid="builder-discard"><Undo aria-hidden /><span className="hidden sm:inline">{t('fb.discard')}</span></Button>}
          {canEdit && <Button variant="secondary" size="sm" onClick={() => void save()} loading={saving} disabled={!dirty} data-testid="builder-save"><Save aria-hidden />{t('fb.saveDraft')}</Button>}
          {canPublish && (
            <Button size="sm" onClick={() => setPublishOpen(true)} disabled={issues.length > 0 || saving || (!dirty && !detail.draft)} data-testid="builder-publish"
              title={issues.length ? t('fb.publishBlocked', { n: issues.length }) : undefined}>
              <Send aria-hidden />{t('fb.publish')}
            </Button>
          )}
        </div>
      </div>
      {saveError && <InlineAlert className="m-2" data-testid="builder-save-error">{saveError}</InlineAlert>}
      {!canEdit && <InlineAlert tone="info" className="m-2">{t('fb.readOnlyNotice')}</InlineAlert>}

      {/* Small screens: one pane at a time */}
      <div className="flex border-b border-border bg-surface lg:hidden" role="tablist" aria-label={t('fb.panes')}>
        {(['palette', 'canvas', 'props'] as const).map(p => (
          <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)}
            className={cn('-mb-px flex-1 border-b-2 py-2 text-sm font-medium', pane === p ? 'border-accent text-fg' : 'border-transparent text-fg-muted')}>
            {t(`fb.pane.${p}` as 'fb.pane.canvas')}{p === 'props' && issues.length > 0 ? ` (${issues.length})` : ''}
          </button>
        ))}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragType(null)}>
        <div className="flex min-h-0 flex-1">
          <aside className={cn('w-full shrink-0 border-r border-border bg-surface lg:block lg:w-64', pane === 'palette' ? 'block' : 'hidden', (!canEdit || preview) && 'lg:hidden')} aria-label={t('fb.pane.palette')}>
            <Palette onAdd={type => { addField(type); }} />
          </aside>
          <main className={cn('min-w-0 flex-1 overflow-y-auto bg-subtle lg:block', pane === 'canvas' ? 'block' : 'hidden')} aria-label={preview ? t('fb.preview') : t('fb.pane.canvas')}>
            {preview ? (
              <BuilderPreview formKey={detail.key} def={def} />
            ) : (
              <Canvas def={def} selected={state.selected} issuesByKey={issuesByKey} onSelect={select} onDuplicate={duplicate} onDelete={remove} onMove={move} />
            )}
          </main>
          <aside className={cn('w-full shrink-0 flex-col border-l border-border bg-surface lg:flex lg:w-80 xl:w-96', pane === 'props' ? 'flex' : 'hidden')} aria-label={t('fb.pane.props')}>
            <div className="border-b border-border">
              <IssuesList def={def} issues={issues} checking={checking} onSelect={s => select(s)} />
            </div>
            <div className="min-h-0 flex-1">
              <PropertiesPanel
                def={def}
                scopeDef={scopeDef}
                sel={state.selected}
                field={selectedField}
                update={update}
                publishedKeys={new Set(pub.types.keys())}
                formKind={detail.kind}
                masters={masters.data ?? []}
                targetForms={targetForms}
                lookupAttributes={lookupAttributes}
                issues={selectedIssues}
                onSelect={select}
                onGridChange={onGridChange}
              />
            </div>
          </aside>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragType && (
            <div className="flex items-center gap-2 rounded border border-accent bg-surface px-3 py-2 text-sm shadow-pop">
              {(() => { const I = typeInfo(dragType).icon; return <I className="size-4 text-accent" aria-hidden />; })()}
              {t(typeInfo(dragType).label)}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      <PublishDialog open={publishOpen} onOpenChange={setPublishOpen} onPublish={publish} nextVersion={(detail.currentVersion ?? 0) + 1} issues={issues.length} />
      <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} formKey={detail.key} current={detail.currentVersion} />
    </div>
  );
}

export default FormBuilderPage;
