'use client';
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent } from '@dnd-kit/core';
import {
  Button, Checkbox, cn, Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, FormField, Input, NativeSelect, Skeleton, toast,
} from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, FileStack, Gauge, GripHorizontal, Inbox, Plus, Save, Share2, Table2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { InlineAlert } from '@/components/page';
import { useDocTypes } from '@/features/documents/api';
import { dashboardsApi, reportKeys, useReports } from '@/features/reports/api';
import { DATE_PRESETS } from '@/features/reports/params';
import type { DashboardRow, DashboardWidget, WidgetType } from '@/features/reports/types';
import { rolesApi } from '@/features/users/api';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { COLS, DEFAULT_SIZE, findSlot, GAP_PX, MIN_SIZE, newWidgetId, pixelHeight, readingOrder, resolveLayout, ROW_PX } from './grid';
import { WidgetView } from './widgets';

const TYPES: { type: WidgetType; icon: typeof Gauge }[] = [
  { type: 'kpi', icon: Gauge }, { type: 'chart', icon: BarChart3 }, { type: 'table', icon: Table2 }, { type: 'inbox_counts', icon: Inbox }, { type: 'doc_counts', icon: FileStack },
];

interface Draft { name: string; widgets: DashboardWidget[]; sharedRoleIds: string[]; isDefaultForRoleIds: string[] }

// ----------------------------------------------------------------------------- canvas cell

function Cell({ w, selected, onSelect, colPx, preview, onResize, onKeyMove }: {
  w: DashboardWidget; selected: boolean; onSelect: () => void; colPx: number; preview: DashboardWidget | null;
  onResize: (id: string, dw: number, dh: number, commit: boolean) => void; onKeyMove: (id: string, dx: number, dy: number, resize: boolean) => void;
}) {
  const { setNodeRef, attributes, listeners, transform, isDragging } = useDraggable({ id: w.id });
  const start = useRef<{ x: number; y: number } | null>(null);
  const box = preview ?? w;
  const unitX = colPx + GAP_PX;
  const unitY = ROW_PX + GAP_PX;
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); start.current = { x: e.clientX, y: e.clientY }; };
  const delta = (e: ReactPointerEvent) => [Math.round((e.clientX - start.current!.x) / unitX), Math.round((e.clientY - start.current!.y) / unitY)] as const;
  return (
    <div
      ref={setNodeRef}
      className={cn('group relative min-w-0', isDragging && 'z-20')}
      style={{ gridColumn: `${box.x + 1} / span ${box.w}`, gridRow: `${box.y + 1} / span ${box.h}`, transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined }}
      data-testid={`dash-design-cell-${w.id}`}
      data-x={box.x} data-y={box.y} data-w={box.w} data-h={box.h}
    >
      <div className={cn('pointer-events-none h-full rounded-lg', selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : '', isDragging && 'opacity-80 shadow-pop')}>
        <WidgetView widget={w} dashboardId={null} live />
      </div>
      {/* Click anywhere on the widget selects it (links inside are inert while designing). */}
      <button type="button" className="absolute inset-0 rounded-lg focus-visible:outline-none" aria-label={t('dash.design.select', { title: w.title || t(`dash.type.${w.type}` as 'dash.type.kpi') })} aria-pressed={selected} onClick={onSelect} data-testid={`dash-select-${w.id}`} />
      <button
        type="button"
        {...attributes}
        {...listeners}
        onKeyDown={e => {
          const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (k) { e.preventDefault(); onKeyMove(w.id, k[0]!, k[1]!, e.shiftKey); }
        }}
        className="absolute -top-3.5 left-1/2 z-10 grid h-7 w-10 -translate-x-1/2 cursor-grab place-items-center rounded border border-border bg-surface text-fg-muted opacity-0 shadow-sm transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
        style={selected ? { opacity: 1 } : undefined}
        aria-label={t('dash.design.move', { title: w.title })}
        aria-describedby="dash-move-help"
        data-testid={`dash-move-${w.id}`}
      >
        <GripHorizontal className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onPointerDown={onPointerDown}
        onPointerMove={e => { if (start.current) { const [dx, dy] = delta(e); onResize(w.id, dx, dy, false); } }}
        onPointerUp={e => { if (start.current) { const [dx, dy] = delta(e); start.current = null; onResize(w.id, dx, dy, true); } }}
        className="absolute bottom-1 right-1 z-10 size-5 cursor-se-resize rounded-sm opacity-0 transition-opacity group-hover:opacity-100"
        style={selected ? { opacity: 1 } : undefined}
        data-testid={`dash-resize-${w.id}`}
      >
        <svg viewBox="0 0 10 10" className="size-full text-fg-subtle" aria-hidden><path d="M9 3 3 9M9 6 6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}

// ----------------------------------------------------------------------------- widget panel

/** Period for a widget's report (`params.datePreset`, resolved by the server in the tenant timezone). */
function PeriodSelect({ value, onChange }: { value: unknown; onChange: (v: string | undefined) => void }) {
  return (
    <FormField label={t('dash.widget.period')} hint={t('dash.widget.periodHint')}>
      <NativeSelect value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value || undefined)} data-testid="widget-period">
        <option value="">{t('dash.widget.periodReport')}</option>
        {DATE_PRESETS.map(p => <option key={p} value={p}>{t(`report.preset.${p}` as 'report.preset.today')}</option>)}
      </NativeSelect>
    </FormField>
  );
}

function WidgetPanel({ w, onChange, onRemove }: { w: DashboardWidget; onChange: (p: Partial<DashboardWidget>) => void; onRemove: () => void }) {
  const reports = useReports();
  const docTypes = useDocTypes();
  const needsReport = w.type === 'kpi' || w.type === 'chart' || w.type === 'table';
  const num = (k: 'x' | 'y' | 'w' | 'h', v: string) => onChange({ [k]: Number(v) || 0 });
  return (
    <div className="space-y-4" data-testid="widget-panel" data-widget-id={w.id}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{t('dash.widget.title')}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label={t('dash.widget.remove')} data-testid="widget-remove"><Trash2 aria-hidden /></Button>
      </div>
      <FormField label={t('dash.widget.type')}>
        <NativeSelect value={w.type} onChange={e => { const type = e.target.value as WidgetType; onChange({ type, ...DEFAULT_SIZE[type], x: w.x, y: w.y }); }} data-testid="widget-type">
          {TYPES.map(x => <option key={x.type} value={x.type}>{t(`dash.type.${x.type}` as 'dash.type.kpi')}</option>)}
        </NativeSelect>
      </FormField>
      <FormField label={t('dash.widget.name')}>
        <Input value={w.title} maxLength={80} onChange={e => onChange({ title: e.target.value })} data-testid="widget-title" />
      </FormField>
      {needsReport && (
        <FormField label={t('dash.widget.report')}>
          <NativeSelect value={w.reportId ?? ''} onChange={e => onChange({ reportId: e.target.value || undefined, title: w.title || reports.data?.find(r => r.id === e.target.value)?.name || '' })} data-testid="widget-report">
            <option value="">{t('dash.widget.pickReport')}</option>
            {(reports.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </NativeSelect>
        </FormField>
      )}
      {w.type === 'kpi' && <p className="-mt-2 text-sm text-fg-muted">{t('dash.widget.kpiHint')}</p>}
      {needsReport && w.reportId && <PeriodSelect value={w.params?.datePreset} onChange={datePreset => onChange({ params: { ...w.params, datePreset } })} />}
      {w.type === 'doc_counts' && (
        <FormField label={t('dash.widget.docType')}>
          <NativeSelect value={w.docTypeKey ?? ''} onChange={e => onChange({ docTypeKey: e.target.value || undefined, title: w.title || docTypes.data?.find(d => d.key === e.target.value)?.pluralName || '' })} data-testid="widget-doctype">
            <option value="">{t('dash.docCounts.allTypes')}</option>
            {(docTypes.data ?? []).filter(d => d.isActive).map(d => <option key={d.key} value={d.key}>{d.pluralName}</option>)}
          </NativeSelect>
        </FormField>
      )}
      {w.type === 'inbox_counts' && <p className="text-sm text-fg-muted">{t('dash.widget.inboxHint')}</p>}
      <fieldset>
        <legend className="mb-1.5 font-medium">{t('dash.widget.position')}</legend>
        <div className="grid grid-cols-4 gap-2">
          {(['x', 'y', 'w', 'h'] as const).map(k => (
            <label key={k} className="text-sm text-fg-muted">
              {t(`dash.widget.pos.${k}` as 'dash.widget.pos.x')}
              <Input type="number" min={k === 'w' ? MIN_SIZE[w.type].w : k === 'h' ? MIN_SIZE[w.type].h : 0} max={k === 'x' ? COLS - 1 : k === 'w' ? COLS : undefined} value={w[k]} onChange={e => num(k, e.target.value)} className="mt-1 h-8" data-testid={`widget-pos-${k}`} />
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

// ----------------------------------------------------------------------------- share dialog

function ShareDialog({ open, onOpenChange, draft, setDraft }: { open: boolean; onOpenChange: (o: boolean) => void; draft: Draft; setDraft: (fn: (d: Draft) => Draft) => void }) {
  const roles = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list, enabled: open, staleTime: 5 * 60_000 });
  const toggle = (k: 'sharedRoleIds' | 'isDefaultForRoleIds', id: string, on: boolean) => setDraft(d => {
    const next = { ...d, [k]: on ? [...new Set([...d[k], id])] : d[k].filter(x => x !== id) };
    // A role's default dashboard is always shared with that role.
    if (k === 'isDefaultForRoleIds' && on) next.sharedRoleIds = [...new Set([...next.sharedRoleIds, id])];
    if (k === 'sharedRoleIds' && !on) next.isDefaultForRoleIds = next.isDefaultForRoleIds.filter(x => x !== id);
    return next;
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t('dash.share.title')} description={t('dash.share.subtitle')} data-testid="dash-share-dialog" footer={<Button onClick={() => onOpenChange(false)} data-testid="dash-share-done">{t('common.done')}</Button>}>
        {roles.isLoading ? <Skeleton className="h-24" /> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-fg-muted"><th scope="col" className="py-1.5 font-medium">{t('dash.share.role')}</th><th scope="col" className="w-24 py-1.5 text-center font-medium">{t('dash.share.canView')}</th><th scope="col" className="w-24 py-1.5 text-center font-medium">{t('dash.share.default')}</th></tr></thead>
            <tbody>
              {(roles.data ?? []).map(r => (
                <tr key={r.id} className="border-t border-border" data-testid={`dash-share-row-${r.key}`}>
                  <th scope="row" className="py-2 text-left font-normal">{r.name}</th>
                  <td className="text-center"><Checkbox aria-label={t('dash.share.canViewFor', { role: r.name })} checked={draft.sharedRoleIds.includes(r.id)} onCheckedChange={v => toggle('sharedRoleIds', r.id, v === true)} data-testid={`dash-share-${r.key}`} /></td>
                  <td className="text-center"><Checkbox aria-label={t('dash.share.defaultFor', { role: r.name })} checked={draft.isDefaultForRoleIds.includes(r.id)} onCheckedChange={v => toggle('isDefaultForRoleIds', r.id, v === true)} data-testid={`dash-default-${r.key}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-sm text-fg-muted">{t('dash.share.note')}</p>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------- page

/** /dashboard/design?id=: 12-column designer — add, move (drag or arrow keys), resize (corner or Shift+arrows), configure, share. */
export function DashboardDesigner({ id }: { id?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: reportKeys.dashboards, queryFn: dashboardsApi.list, retry: false });
  const one = useQuery({ queryKey: reportKeys.dashboard(id ?? ''), queryFn: () => dashboardsApi.get(id!), enabled: !!id, retry: false });
  const mine = useQuery({ queryKey: reportKeys.dashMine, queryFn: dashboardsApi.mine, enabled: !id, retry: false });
  const base: DashboardRow | undefined = id ? one.data : mine.data;
  // Saving updates the dashboard only when it is mine to change; otherwise (built-in, someone else's) it saves a copy.
  const editable = !!id && !!one.data && !one.data.builtin && one.data.canEdit !== false;

  const [draft, setDraftState] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [preview, setPreview] = useState<DashboardWidget | null>(null);
  const [resizing, setResizing] = useState<DashboardWidget | null>(null);
  const [announce, setAnnounce] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const [colPx, setColPx] = useState(80);

  useEffect(() => { setDraftState(null); setDirty(false); setSelected(null); }, [id]);
  useEffect(() => {
    if (draft || (!base && !(id ? one.isError : mine.isError))) return;
    // Starting from the built-in dashboard (no id) creates a personal copy on save.
    const own = !!id && !!base && !base.builtin && base.canEdit !== false;
    setDraftState({ name: own ? base!.name : base?.name ? t('dash.design.copyName', { name: base.name }) : t('dash.design.newName'), widgets: base?.widgets ?? [], sharedRoleIds: own ? base!.sharedRoleIds ?? [] : [], isDefaultForRoleIds: own ? base!.isDefaultForRoleIds ?? [] : [] });
  }, [draft, base, id, one.isError, mine.isError]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setColPx((el.clientWidth - GAP_PX * (COLS - 1)) / COLS));
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft === null]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const setDraft = useCallback((fn: (d: Draft) => Draft) => { setDraftState(d => (d ? fn(d) : d)); setDirty(true); }, []);
  const update = useCallback((wid: string, p: Partial<DashboardWidget>, pin = true) => setDraft(d => ({ ...d, widgets: resolveLayout(d.widgets.map(w => (w.id === wid ? { ...w, ...p } : w)), pin ? wid : undefined) })), [setDraft]);

  const addWidget = (type: WidgetType) => {
    const size = DEFAULT_SIZE[type];
    const wid = newWidgetId(type);
    setDraft(d => {
      const slot = findSlot(d.widgets, size.w, size.h);
      return { ...d, widgets: [...d.widgets, { id: wid, type, title: type === 'inbox_counts' ? t('inbox.widget.title') : '', params: {}, ...slot, ...size }] };
    });
    setSelected(wid);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const snap = (wid: string, dx: number, dy: number) => {
    const w = draft?.widgets.find(x => x.id === wid);
    if (!w) return null;
    return { ...w, x: Math.max(0, Math.min(COLS - w.w, w.x + Math.round(dx / (colPx + GAP_PX)))), y: Math.max(0, w.y + Math.round(dy / (ROW_PX + GAP_PX))) };
  };
  const onDragMove = (e: DragMoveEvent) => setPreview(snap(String(e.active.id), e.delta.x, e.delta.y));
  const onDragEnd = (e: DragEndEvent) => {
    setPreview(null);
    const s = snap(String(e.active.id), e.delta.x, e.delta.y);
    if (s) { update(s.id, { x: s.x, y: s.y }); setSelected(s.id); }
  };
  const onResize = (wid: string, dw: number, dh: number, commit: boolean) => {
    const w = draft?.widgets.find(x => x.id === wid);
    if (!w) return;
    const next = { ...w, w: Math.max(MIN_SIZE[w.type].w, Math.min(COLS - w.x, w.w + dw)), h: Math.max(MIN_SIZE[w.type].h, Math.min(12, w.h + dh)) };
    if (commit) { setResizing(null); update(wid, { w: next.w, h: next.h }); setSelected(wid); } else setResizing(next);
  };
  const onKeyMove = (wid: string, dx: number, dy: number, resize: boolean) => {
    const w = draft?.widgets.find(x => x.id === wid);
    if (!w) return;
    const p = resize ? { w: w.w + dx, h: w.h + dy } : { x: w.x + dx, y: w.y + dy };
    update(wid, p);
    const after = { ...w, ...p };
    setAnnounce(t('dash.design.announce', { title: w.title || w.type, x: Math.max(0, after.x) + 1, y: Math.max(0, after.y) + 1, w: after.w, h: after.h }));
  };

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: draft!.name.trim() || t('dash.design.newName'), widgets: draft!.widgets, sharedRoleIds: draft!.sharedRoleIds, isDefaultForRoleIds: draft!.isDefaultForRoleIds };
      return editable ? dashboardsApi.update(id!, { ...body, version: one.data!.version }) : dashboardsApi.create(body);
    },
    onSuccess: row => {
      setDirty(false);
      toast.success(t('dash.design.saved'));
      void qc.invalidateQueries({ queryKey: reportKeys.dashboards });
      if (row.id) qc.setQueryData(reportKeys.dashboard(row.id), row);
      if (row.id && row.id !== id) router.replace(`/dashboard/design?id=${row.id}`);
    },
    onError: e => toast.error(t('dash.design.saveError'), isApiError(e) ? e.message : undefined),
  });

  if (!draft) {
    const err = id ? one.error : mine.error;
    if (err) return <div className="p-6"><InlineAlert data-testid="dash-design-error">{isApiError(err) ? err.message : t('dash.widgetError')}</InlineAlert></div>;
    return <div className="space-y-3 p-6" aria-busy="true"><Skeleton className="h-8 w-80" /><Skeleton className="h-96" /></div>;
  }
  const sel = draft.widgets.find(w => w.id === selected) ?? null;
  const rows = Math.max(8, draft.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0) + 3);

  return (
    <div className="flex min-h-[calc(100dvh-var(--topbar-h))] flex-col" data-testid="dash-designer" data-dirty={dirty}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        <Button asChild variant="ghost" size="icon-sm"><Link href="/dashboard" aria-label={t('dash.design.back')}><ArrowLeft aria-hidden /></Link></Button>
        <Input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} aria-label={t('dash.design.name')} className="h-8 w-full max-w-xs font-semibold sm:w-64" maxLength={80} data-testid="dash-name-input" />
        {(list.data?.length ?? 0) > 0 && (
          <NativeSelect className="h-8 w-full sm:w-52" aria-label={t('dash.design.open')} value={id ?? ''} data-testid="dash-picker"
            onChange={e => router.push(e.target.value ? `/dashboard/design?id=${e.target.value}` : '/dashboard/design')}>
            <option value="">{t('dash.design.fromMine')}</option>
            {list.data!.filter(d => d.id).map(d => <option key={d.id!} value={d.id!}>{d.name}</option>)}
          </NativeSelect>
        )}
        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="secondary" size="sm" data-testid="dash-add"><Plus aria-hidden />{t('dash.design.add')}</Button></DropdownMenuTrigger>
            <DropdownMenuContent>
              {TYPES.map(({ type, icon: Icon }) => (
                <DropdownMenuItem key={type} onSelect={() => addWidget(type)} data-testid={`dash-add-${type}`}><Icon className="size-4 text-fg-muted" aria-hidden />{t(`dash.type.${type}` as 'dash.type.kpi')}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="secondary" size="sm" onClick={() => setShareOpen(true)} data-testid="dash-share"><Share2 aria-hidden />{t('dash.design.share')}{draft.isDefaultForRoleIds.length > 0 && <span className="rounded-full bg-accent-soft px-1.5 text-xs text-accent tabular-nums">{draft.isDefaultForRoleIds.length}</span>}</Button>
          <Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty && editable} data-testid="dash-save"><Save aria-hidden />{t('dash.design.save')}</Button>
        </div>
      </header>
      <p id="dash-move-help" className="sr-only">{t('dash.design.moveHelp')}</p>
      <p className="sr-only" aria-live="polite">{announce}</p>

      <div className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <main className="min-w-0 overflow-auto p-4" aria-label={t('dash.design.canvas')}>
          <p className="mb-3 text-sm text-fg-muted lg:hidden">{t('dash.design.smallScreen')}</p>
          <DndContext sensors={sensors} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={() => setPreview(null)}>
            <div
              ref={gridRef}
              className="relative grid min-w-[56rem] grid-cols-12"
              style={{ gridAutoRows: `${ROW_PX}px`, gap: GAP_PX, minHeight: pixelHeight(rows),
                backgroundImage: `linear-gradient(to right, rgb(var(--c-border) / 0.5) 1px, transparent 1px)`, backgroundSize: `${colPx + GAP_PX}px 100%` }}
              data-testid="dash-canvas"
              onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}
            >
              {preview && (
                <div aria-hidden className="pointer-events-none rounded-lg border-2 border-dashed border-accent bg-accent-soft/60"
                  style={{ gridColumn: `${preview.x + 1} / span ${preview.w}`, gridRow: `${preview.y + 1} / span ${preview.h}` }} />
              )}
              {draft.widgets.map(w => (
                <Cell key={w.id} w={w} colPx={colPx} selected={selected === w.id} onSelect={() => setSelected(w.id)}
                  preview={resizing && resizing.id === w.id ? resizing : null}
                  onResize={onResize} onKeyMove={onKeyMove} />
              ))}
              {draft.widgets.length === 0 && (
                <div className="col-span-12 row-span-3 grid place-items-center rounded-lg border border-dashed border-border text-center" data-testid="dash-canvas-empty">
                  <div><p className="font-medium">{t('dash.design.emptyTitle')}</p><p className="text-sm text-fg-muted">{t('dash.design.emptyBody')}</p></div>
                </div>
              )}
            </div>
          </DndContext>
        </main>
        <aside className="border-t border-border bg-surface p-4 lg:border-l lg:border-t-0" aria-label={t('dash.widget.title')}>
          {sel ? (
            <WidgetPanel key={sel.id} w={sel} onChange={p => update(sel.id, p, 'x' in p || 'y' in p || 'w' in p || 'h' in p || 'type' in p)} onRemove={() => { setDraft(d => ({ ...d, widgets: resolveLayout(d.widgets.filter(w => w.id !== sel.id)) })); setSelected(null); }} />
          ) : (
            <div className="space-y-3 text-sm text-fg-muted" data-testid="widget-panel-empty">
              <p>{t('dash.design.panelEmpty')}</p>
              <ul className="space-y-1">{readingOrder(draft.widgets).map(w => (
                <li key={w.id}><button type="button" className="w-full truncate rounded px-2 py-1 text-left text-fg hover:bg-subtle" onClick={() => setSelected(w.id)}>{w.title || t(`dash.type.${w.type}` as 'dash.type.kpi')}</button></li>
              ))}</ul>
            </div>
          )}
        </aside>
      </div>
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} draft={draft} setDraft={setDraft} />
    </div>
  );
}
