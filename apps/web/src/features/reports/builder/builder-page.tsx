'use client';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Button, Card, CardBody, cn, Skeleton, toast } from '@procure/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, ChartColumn, Eye, Save, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { REPORT_PERMS, reportKeys, reportsApi, useReport, useSources } from '../api';
import { chartModel } from '../chart-data';
import { initialParams, paramsOf } from '../params';
import { ReportChart } from '../report-chart';
import { bucketOf } from '../reports-home';
import { ResultsTable } from '../results-table';
import type { CatalogueField, ReportDefinition, ReportRow } from '../types';
import { FieldTree, SourcePicker, typeIcon } from './field-tree';
import { Inspector } from './inspector';
import { cleanDefinition, emptyDefinition, LIMITS, localIssues, newColumn, newFilter, type Selection, type Shelf, slugKey, sourceId } from './model';
import { SaveDialog, type SaveValues } from './save-dialog';
import { Shelves } from './shelves';

const tr = (k: string, v?: Record<string, string | number>) => t(k as 'builder.issue.noColumns', v);

interface Meta { name: string; key: string; description: string; sharedRoleIds: string[] }

/** /reports/new (optionally ?from=<id> to copy) and /reports/:id/edit. */
export function ReportBuilderPage({ id, from }: { id?: string; from?: string }) {
  const sources = useSources();
  const base = useReport(id ?? from);
  const me = useTenantPrincipal();
  const p = usePermissions();
  const router = useRouter();
  const qc = useQueryClient();

  const [def, setDefState] = useState<ReportDefinition | null>(null);
  const [meta, setMeta] = useState<Meta>({ name: '', key: '', description: '', sharedRoleIds: [] });
  const [selection, setSelection] = useState<Selection>(null);
  const [dirty, setDirty] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [dragField, setDragField] = useState<CatalogueField | null>(null);
  // The inspector lives in the right column from lg up, inline under the shelves below that (rendered once).
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const editing: ReportRow | undefined = id ? base.data : undefined;
  const readOnlyBase = !!editing && (editing.kind === 'builtin' || !(editing.canEdit ?? bucketOf(editing, me?.userId) === 'mine'));

  // Initialise once the base report (edit / copy) is known; a new report starts empty with the first source.
  useEffect(() => {
    if (def) return;
    if (id || from) {
      if (!base.data) return;
      const r = base.data;
      setDefState(structuredClone(r.definition));
      if (id && !readOnlyBase) setMeta({ name: r.name, key: r.key, description: r.description ?? '', sharedRoleIds: r.sharedRoleIds ?? [] });
      else setMeta({ name: t('builder.copyName', { name: r.name }), key: slugKey(`${r.key}_copy`), description: r.description ?? '', sharedRoleIds: [] });
      return;
    }
    if (sources.data?.length) setDefState(emptyDefinition(sources.data[0]!.source));
  }, [def, id, from, base.data, sources.data, readOnlyBase]);

  const setDef = useCallback((fn: (d: ReportDefinition) => ReportDefinition) => { setDefState(d => (d ? fn(d) : d)); setDirty(true); }, []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const catalogue = useMemo(() => sources.data?.find(s => def && sourceId(s.source) === sourceId(def.source)), [sources.data, def]);
  const fields = useMemo(() => new Map((catalogue?.fields ?? []).map(f => [f.id, f])), [catalogue]);
  const issues = useMemo(() => (def ? localIssues(def, catalogue, tr) : []), [def, catalogue]);
  const issueAt = useCallback((s: Shelf, i: number) => issues.some(x => x.shelf === s && x.index === i), [issues]);
  const counts: Record<Shelf, number> = { columns: def?.columns.length ?? 0, groupBy: def?.groupBy.length ?? 0, filters: def?.filters.length ?? 0, sort: def?.sort.length ?? 0 };

  // ---------------------------------------------------------------- shelf operations
  const add = useCallback((shelf: Shelf, f: CatalogueField, at?: number) => {
    if (!def) return;
    if (counts[shelf] >= LIMITS[shelf]) { toast.error(t('builder.limit', { n: LIMITS[shelf] })); return; }
    if (shelf === 'groupBy' && !f.groupable) { toast.error(t('builder.notGroupable', { field: f.label })); return; }
    if (shelf === 'filters' && !f.filterable) { toast.error(t('builder.notFilterable', { field: f.label })); return; }
    let index = 0;
    setDef(d => {
      const ins = <T,>(list: T[], item: T) => { const n = [...list]; index = at ?? n.length; n.splice(index, 0, item); return n; };
      if (shelf === 'columns') return { ...d, columns: ins(d.columns, newColumn(f, d.groupBy.length > 0)) };
      if (shelf === 'filters') return { ...d, filters: ins(d.filters, newFilter(f)) };
      if (shelf === 'sort') return d.sort.some(s => s.field === f.id) ? d : { ...d, sort: ins(d.sort, { field: f.id, dir: 'asc' as const }) };
      if (d.groupBy.includes(f.id)) return d;
      // Grouping: the group field becomes a column; plain numeric columns turn into sums.
      const columns = d.columns.map(c => (c.aggregate === 'none' && !d.groupBy.includes(c.field) && c.field !== f.id && (fields.get(c.field)?.type === 'number' || fields.get(c.field)?.type === 'currency') ? { ...c, aggregate: 'sum' as const } : c));
      let withCol = columns;
      if (!columns.some(c => c.field === f.id)) {
        // Group columns lead, in group order: insert after the last existing group column.
        const after = columns.reduce((last, c, i) => (d.groupBy.includes(c.field) ? i : last), -1);
        withCol = [...columns.slice(0, after + 1), { field: f.id, aggregate: 'none' as const, format: 'auto' as const }, ...columns.slice(after + 1)];
      }
      return { ...d, groupBy: ins(d.groupBy, f.id), columns: withCol };
    });
    setSelection({ shelf, index: at ?? counts[shelf] });
    void index;
  }, [def, counts, setDef, fields]);

  const remove = useCallback((shelf: Shelf, i: number) => {
    setDef(d => {
      if (shelf === 'columns') {
        const removed = d.columns[i]?.field;
        const columns = d.columns.filter((_, j) => j !== i);
        const chart = d.chart && removed && !columns.some(c => c.field === removed) && (d.chart.x === removed || d.chart.series.includes(removed))
          ? (d.chart.x === removed ? undefined : { ...d.chart, series: d.chart.series.filter(s => s !== removed) }) : d.chart;
        return { ...d, columns, chart };
      }
      if (shelf === 'groupBy') return { ...d, groupBy: d.groupBy.filter((_, j) => j !== i) };
      if (shelf === 'filters') return { ...d, filters: d.filters.filter((_, j) => j !== i) };
      return { ...d, sort: d.sort.filter((_, j) => j !== i) };
    });
    setSelection(null);
  }, [setDef]);

  const move = useCallback((shelf: Shelf, a: number, b: number) => {
    setDef(d => ({ ...d, [shelf]: arrayMove(d[shelf] as unknown[], a, b) }) as ReportDefinition);
    setSelection(s => (s && 'shelf' in s && s.shelf === shelf && s.index === a ? { shelf, index: b } : s));
  }, [setDef]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragStart = (e: DragStartEvent) => { const d = e.active.data.current; setDragField(d?.kind === 'field' ? (d.field as CatalogueField) : null); };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragField(null);
    const a = active.data.current;
    const o = over?.data.current;
    if (!a || !o) return;
    const targetShelf = (o.shelf as Shelf | undefined);
    if (!targetShelf) return;
    if (a.kind === 'field') add(targetShelf, a.field as CatalogueField, o.kind === 'chip' ? (o.index as number) : undefined);
    else if (a.kind === 'chip' && o.kind === 'chip' && a.shelf === o.shelf && a.index !== o.index) move(targetShelf, a.index as number, o.index as number);
  };

  // ---------------------------------------------------------------- preview
  const previewDef = useDebounced(def, 600);
  const previewParams = useMemo(() => (previewDef ? initialParams(paramsOf(previewDef, catalogue?.fields), null) : {}), [previewDef, catalogue]);
  const previewOk = !!previewDef && previewDef.columns.length > 0 && localIssues(previewDef, catalogue, tr).length === 0;
  const preview = useQuery({
    queryKey: reportKeys.preview(previewDef, previewParams),
    queryFn: () => reportsApi.preview(cleanDefinition(previewDef!), previewParams),
    enabled: previewOk,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const model = useMemo(() => (def && preview.data ? chartModel(preview.data, def) : null), [preview.data, def]);

  // ---------------------------------------------------------------- save
  const save = useMutation({
    mutationFn: async (v: SaveValues) => {
      const body = { key: v.key, name: v.name, description: v.description || undefined, definition: cleanDefinition(def!), sharedRoleIds: v.sharedRoleIds };
      return editing && !readOnlyBase ? reportsApi.update(editing.id, { ...body, version: editing.version }) : reportsApi.create(body);
    },
    onSuccess: row => {
      setDirty(false);
      setSaveOpen(false);
      toast.success(t('builder.saved'));
      void qc.invalidateQueries({ queryKey: ['reports'] });
      router.push(`/reports/${row.id}`);
    },
  });

  if (sources.isLoading || ((id || from) && base.isLoading) || (!def && !sources.isError && !base.isError)) {
    return (
      <div className="flex h-[calc(100dvh-var(--topbar-h))] flex-col" aria-busy="true">
        <div className="border-b border-border px-4 py-3"><Skeleton className="h-6 w-64" /></div>
        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[17rem_1fr_19rem]"><Skeleton className="h-full" /><Skeleton className="h-full" /><Skeleton className="h-full" /></div>
      </div>
    );
  }
  if (!def) {
    const err = sources.error ?? base.error;
    return <div className="p-6"><InlineAlert data-testid="builder-load-error">{isApiError(err) ? err.message : t('builder.loadError')}</InlineAlert></div>;
  }

  const switchSource = (sid: string) => {
    const cat = sources.data?.find(s => sourceId(s.source) === sid);
    if (!cat) return;
    setDefState(d => ({ ...emptyDefinition(cat.source), totals: d?.totals ?? true, rowLimit: d?.rowLimit ?? 10_000 }));
    setSelection(null);
    setDirty(true);
  };
  const title = meta.name || (id ? editing?.name : null) || t('builder.untitled');
  const canShare = p.has(REPORT_PERMS.share);

  const inspector = <Inspector def={def} fields={fields} selection={selection} setDef={setDef} onRemove={() => selection && 'shelf' in selection && remove(selection.shelf, selection.index)} />;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragField(null)}>
      <div className="flex min-h-[calc(100dvh-var(--topbar-h))] flex-col lg:h-[calc(100dvh-var(--topbar-h))]" data-testid="report-builder" data-dirty={dirty}>
        <header className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
          <Button asChild variant="ghost" size="icon-sm"><Link href={id ? `/reports/${id}` : '/reports'} aria-label={t('report.backToReports')}><ArrowLeft aria-hidden /></Link></Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold" data-testid="builder-title">{title}</h1>
            <p className="truncate text-sm text-fg-muted">{catalogue?.label ?? '—'}{dirty ? ` · ${t('builder.unsaved')}` : ''}</p>
          </div>
          {issues.length > 0 && (
            <span className="flex items-center gap-1 text-sm text-warning" data-testid="builder-issues" data-count={issues.length}>
              <AlertTriangle className="size-4" aria-hidden />{t('builder.issueCount', { n: issues.length })}
            </span>
          )}
          <Button size="sm" onClick={() => setSaveOpen(true)} disabled={issues.length > 0} data-testid="builder-save">
            <Save aria-hidden />{editing && !readOnlyBase ? t('builder.save.button') : t('builder.save.as')}
          </Button>
        </header>
        {readOnlyBase && <InlineAlert tone="info" className="m-3 mb-0" data-testid="builder-copy-note">{t('builder.copyNote')}</InlineAlert>}

        <div className="grid min-h-0 flex-1 lg:grid-cols-[17rem_minmax(0,1fr)_19rem]">
          {/* Catalogue */}
          <aside className="flex min-h-0 flex-col gap-3 border-b border-border bg-subtle/40 p-3 lg:border-b-0 lg:border-r" aria-label={t('builder.fields')}>
            <SourcePicker sources={sources.data ?? []} value={sourceId(def.source)} loading={sources.isLoading}
              onChange={sid => { if (def.columns.length || def.filters.length) setPendingSource(sid); else switchSource(sid); }} />
            <div className="flex max-h-72 min-h-0 flex-1 flex-col lg:max-h-none"><FieldTree catalogue={catalogue} onAdd={(s, f) => add(s, f)} counts={counts} /></div>
          </aside>

          {/* Design + preview */}
          <main className="min-h-0 space-y-4 overflow-y-auto p-4" aria-label={t('builder.design')}>
            <Card>
              <CardBody className="space-y-3">
                <Shelves def={def} fields={fields} selection={selection} issueAt={issueAt}
                  onSelect={(s, i) => setSelection({ shelf: s, index: i })} onRemove={remove}
                  onToggleDir={i => setDef(d => ({ ...d, sort: d.sort.map((x, j) => (j === i ? { ...x, dir: x.dir === 'asc' ? 'desc' : 'asc' } : x)) }))} />
                <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                  <Button variant={selection && 'panel' in selection && selection.panel === 'chart' ? 'primary' : 'secondary'} size="sm" onClick={() => setSelection({ panel: 'chart' })} data-testid="builder-chart">
                    <ChartColumn aria-hidden />{def.chart ? t('builder.chart.button', { type: t(`report.chart.type.${def.chart.type}` as 'report.chart.type.bar') }) : t('builder.chart.add')}
                  </Button>
                  <Button variant={selection && 'panel' in selection && selection.panel === 'settings' ? 'primary' : 'secondary'} size="sm" onClick={() => setSelection({ panel: 'settings' })} data-testid="builder-settings">
                    <Settings2 aria-hidden />{t('builder.settings.title')}
                  </Button>
                </div>
              </CardBody>
            </Card>

            {/* Inspector inline below lg */}
            {selection && !wide && <Card><CardBody>{inspector}</CardBody></Card>}

            {issues.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning" data-testid="builder-issue-list">
                {issues.map((x, i) => (
                  <li key={i} data-testid="builder-issue" data-code={x.code}>
                    {x.shelf !== undefined && x.index !== undefined
                      ? <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => setSelection({ shelf: x.shelf!, index: x.index! })}>{x.message}</button>
                      : x.message}
                  </li>
                ))}
              </ul>
            )}

            <section aria-labelledby="builder-preview-h" data-testid="builder-preview">
              <div className="mb-2 flex items-center gap-2">
                <Eye className="size-4 text-fg-muted" aria-hidden />
                <h2 id="builder-preview-h" className="font-semibold">{t('builder.preview')}</h2>
                <span className="text-sm text-fg-muted">{preview.isFetching ? t('builder.previewRunning') : preview.data ? t('builder.previewRows', { n: preview.data.rows.length }) : ''}</span>
              </div>
              {!previewOk ? (
                <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-fg-muted" data-testid="builder-preview-empty">{def.columns.length ? t('builder.previewFix') : t('builder.previewStart')}</p>
              ) : preview.isError ? (
                <InlineAlert data-testid="builder-preview-error">{isApiError(preview.error) ? preview.error.message : t('report.runError')}</InlineAlert>
              ) : (
                <div className="space-y-3">
                  {def.chart && model && model.categories.length > 0 && (
                    <Card><CardBody className={cn(preview.isFetching && 'opacity-60')}><ReportChart model={model} height={240} /></CardBody></Card>
                  )}
                  <ResultsTable result={preview.data} def={def} loading={preview.isLoading} caption={t('builder.preview')} height="26rem" dim={preview.isFetching && !!preview.data} />
                </div>
              )}
            </section>
          </main>

          {/* Inspector */}
          {wide && (
            <aside className="min-h-0 overflow-y-auto border-l border-border bg-surface p-4" aria-label={t('builder.inspector.title')} data-testid="builder-inspector">
              {inspector}
            </aside>
          )}
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {dragField && (() => { const Icon = typeIcon[dragField.type]; return (
          <div className="flex items-center gap-2 rounded border border-accent bg-surface px-2.5 py-1.5 text-sm shadow-pop"><Icon className="size-3.5 text-fg-subtle" aria-hidden />{dragField.label}</div>
        ); })()}
      </DragOverlay>

      <SaveDialog open={saveOpen} onOpenChange={setSaveOpen} keyLocked={!!editing && !readOnlyBase} canShare={canShare}
        title={editing && !readOnlyBase ? t('builder.save.title') : t('builder.save.asTitle')}
        initial={{ name: meta.name, key: meta.key || slugKey(meta.name || 'report'), description: meta.description, sharedRoleIds: meta.sharedRoleIds }}
        onSave={async v => { setMeta({ name: v.name, key: v.key, description: v.description ?? '', sharedRoleIds: v.sharedRoleIds }); await save.mutateAsync(v); }} />

      <ConfirmDialog testId="builder-source-confirm" open={!!pendingSource} onOpenChange={o => { if (!o) setPendingSource(null); }}
        title={t('builder.sourceChange.title')} description={t('builder.sourceChange.body')} confirmLabel={t('builder.sourceChange.confirm')} tone="danger"
        onConfirm={async () => { if (pendingSource) switchSource(pendingSource); setPendingSource(null); }} />
    </DndContext>
  );
}
