'use client';
import { useDroppable } from '@dnd-kit/core';
import { rectSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Field, FormDefinition } from '@procure/schema';
import { Button, cn } from '@procure/ui';
import { AlertCircle, Copy, Eye, GripVertical, Lock, PanelTop, Sigma, Trash2 } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { t } from '@/i18n';
import { spanOf } from '@/engines/form-renderer/form-renderer';
import { typeInfo } from './catalog';
import type { Selection } from './state';

const SPAN: Record<number, string> = {
  1: 'md:col-span-1', 2: 'md:col-span-2', 3: 'md:col-span-3', 4: 'md:col-span-4', 5: 'md:col-span-5', 6: 'md:col-span-6',
  7: 'md:col-span-7', 8: 'md:col-span-8', 9: 'md:col-span-9', 10: 'md:col-span-10', 11: 'md:col-span-11', 12: 'md:col-span-12',
};

export interface CanvasProps {
  def: FormDefinition;
  selected: Selection | null;
  issuesByKey: Map<string, number>;
  onSelect: (s: Selection | null) => void;
  onDuplicate: (key: string) => void;
  onDelete: (key: string) => void;
  onMove: (key: string, dir: -1 | 1) => void;
}

/** Drop target and sortable list. Layout markers (tab/section) are full-width bars; fields take their real width. */
export function Canvas({ def, selected, issuesByKey, onSelect, onDuplicate, onDelete, onMove }: CanvasProps) {
  const { setNodeRef: endRef, isOver } = useDroppable({ id: 'canvas-end' });
  let sectionColumns = 1;
  const visible = def.fields.filter(f => !f.removed);
  return (
    <div className="min-h-full p-4 sm:p-6" onClick={() => onSelect(null)}>
      <div className="mx-auto max-w-4xl rounded-lg border border-border bg-surface shadow-pop" data-testid="builder-canvas">
        <div className="relative p-4 sm:p-6">
          {/* 12-column guides make widths legible while arranging. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-4 inset-y-4 hidden grid-cols-12 gap-x-3 sm:inset-x-6 md:grid">
            {Array.from({ length: 12 }, (_, i) => <div key={i} className="rounded-sm bg-accent/[0.035]" />)}
          </div>
          <SortableContext items={visible.map(f => f.key)} strategy={rectSortingStrategy}>
            <ol className="relative grid grid-cols-1 gap-3 md:grid-cols-12" aria-label={t('fb.canvas.label')}>
              {visible.map(f => {
                if (f.type === 'section') sectionColumns = f.columns;
                if (f.type === 'tab') sectionColumns = 1;
                return (
                  <SortableField
                    key={f.key}
                    field={f}
                    span={f.type === 'tab' || f.type === 'section' ? 12 : spanOf(f, sectionColumns)}
                    selected={selected}
                    issues={issuesByKey.get(f.key) ?? 0}
                    onSelect={onSelect}
                    onDuplicate={onDuplicate}
                    onDelete={onDelete}
                    onMove={onMove}
                  />
                );
              })}
            </ol>
          </SortableContext>
          <div
            ref={endRef}
            className={cn('relative mt-3 grid place-items-center rounded border border-dashed px-4 py-6 text-sm text-fg-subtle transition-colors', isOver ? 'border-accent bg-accent-soft text-accent' : 'border-border-strong')}
            data-testid="canvas-drop-end"
          >
            {visible.length ? t('fb.canvas.dropHere') : t('fb.canvas.empty')}
          </div>
        </div>
      </div>
    </div>
  );
}

function SortableField({ field, span, selected, issues, onSelect, onDuplicate, onDelete, onMove }: {
  field: Field; span: number; selected: Selection | null; issues: number;
} & Pick<CanvasProps, 'onSelect' | 'onDuplicate' | 'onDelete' | 'onMove'>) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: field.key });
  const isSel = selected?.key === field.key && !selected.col;
  const system = 'system' in field && field.system;
  const info = typeInfo(field.type);
  const Icon = info.icon;
  const label = 'label' in field ? field.label : field.type === 'help' ? t('fb.type.help') : t('fb.type.divider');

  // Structure (axe-clean): <li> stays a plain list item; dnd-kit's role/keyboard drag lives on the handle button;
  // selection is a separate toggle button (aria-pressed); actions are siblings, never nested in another control.
  const select = (e: MouseEvent | KeyboardEvent) => { e.stopPropagation(); onSelect({ key: field.key }); };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && !system) { e.preventDefault(); onDelete(field.key); }
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); onMove(field.key, -1); }
    if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); onMove(field.key, 1); }
  };

  const actions = (
    <div className={cn('flex shrink-0 items-center gap-0.5', !isSel && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}>
      <Button variant="ghost" size="icon-sm" className="size-7" onClick={e => { e.stopPropagation(); onDuplicate(field.key); }} aria-label={t('fb.canvas.duplicate', { label })} data-testid={`canvas-dup-${field.key}`}><Copy /></Button>
      <Button variant="ghost" size="icon-sm" className="size-7 hover:text-danger" disabled={!!system} onClick={e => { e.stopPropagation(); onDelete(field.key); }} aria-label={t('fb.canvas.delete', { label })} data-testid={`canvas-del-${field.key}`}><Trash2 /></Button>
    </div>
  );
  const handle = (
    <button
      ref={setActivatorNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      className="-ml-1 shrink-0 cursor-grab touch-none self-start rounded p-0.5 text-fg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing"
      aria-label={t('fb.canvas.drag', { label })}
      onClick={e => e.stopPropagation()}
    >
      <GripVertical className="size-4" aria-hidden />
    </button>
  );
  const selectProps = {
    type: 'button' as const,
    'aria-pressed': isSel,
    onClick: select,
    onKeyDown: onKey,
    'data-testid': `canvas-select-${field.key}`,
    className: 'min-w-0 flex-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
  };

  const style = { transform: CSS.Translate.toString(transform), transition };
  const base = cn('group relative min-w-0 rounded border bg-surface transition-shadow', SPAN[span], isDragging && 'z-10 opacity-60 shadow-pop',
    isSel ? 'border-accent ring-2 ring-accent/25' : 'border-border hover:border-border-strong');

  if (field.type === 'tab' || field.type === 'section') {
    return (
      <li ref={setNodeRef} style={style} onClick={select}
        className={cn(base, field.type === 'tab' ? 'bg-subtle' : 'border-transparent bg-transparent', 'mt-2 first:mt-0')} data-testid={`canvas-field-${field.key}`} data-type={field.type}>
        <div className={cn('flex items-center gap-2 px-2 py-1.5', field.type === 'section' && 'border-b-2 border-fg/15')}>
          {handle}
          <button {...selectProps} aria-label={`${label || t('fb.canvas.untitledSection')}, ${t(info.label)}`} className={cn(selectProps.className, 'flex items-center gap-2')}>
            {field.type === 'tab' ? <PanelTop className="size-4 shrink-0 text-accent" aria-hidden /> : null}
            <span className={cn('min-w-0 flex-1 truncate', field.type === 'tab' ? 'font-semibold' : 'text-md font-semibold')}>
              {field.label || <span className="font-normal italic text-fg-subtle">{t('fb.canvas.untitledSection')}</span>}
            </span>
            <span className="shrink-0 text-xs text-fg-subtle">{field.type === 'tab' ? t('fb.type.tab') : (field.columns === 1 ? t('fb.canvas.oneColumn') : t('fb.canvas.columns', { n: field.columns }))}</span>
            {field.visibleWhen && <Eye className="size-3.5 shrink-0 text-fg-subtle" aria-label={t('fb.canvas.conditional')} />}
            {issues > 0 && <AlertCircle className="size-4 shrink-0 text-danger" aria-label={t('fb.canvas.issues', { n: issues })} />}
          </button>
          {actions}
        </div>
      </li>
    );
  }

  if (field.type === 'divider') {
    return (
      <li ref={setNodeRef} style={style} onClick={select} className={cn(base, 'border-dashed')} data-testid={`canvas-field-${field.key}`} data-type={field.type}>
        <div className="flex items-center gap-2 px-2 py-1">
          {handle}
          <button {...selectProps} aria-label={t('fb.type.divider')} className={cn(selectProps.className, 'flex items-center gap-2')}>
            <span className="block h-px flex-1 bg-border-strong" aria-hidden /><span className="text-xs text-fg-subtle">{t('fb.type.divider')}</span>
          </button>
          {actions}
        </div>
      </li>
    );
  }

  const required = 'required' in field && field.required;
  const conditional = 'visibleWhen' in field && (field.visibleWhen || ('requiredWhen' in field && field.requiredWhen) || ('readOnlyWhen' in field && field.readOnlyWhen));

  return (
    <li ref={setNodeRef} style={style} onClick={select} className={base} data-testid={`canvas-field-${field.key}`} data-type={field.type}>
      {isSel && <span className="absolute inset-y-0 left-0 w-0.5 rounded-l bg-accent" aria-hidden />}
      <div className="flex items-start gap-1.5 px-2 pb-2 pt-1.5">
        {handle}
        <div className="min-w-0 flex-1">
          <button {...selectProps} aria-label={`${label}, ${t(info.label)}${required ? `, ${t('fr.required')}` : ''}${system ? `, ${t('fb.canvas.system')}` : ''}${issues ? `, ${t('fb.canvas.issues', { n: issues })}` : ''}`} className={cn(selectProps.className, 'block w-full')}>
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{label}</span>
              {required && <span className="text-danger" aria-hidden>*</span>}
              {system && <Lock className="size-3 shrink-0 text-fg-subtle" aria-hidden />}
              {conditional && <Eye className="size-3 shrink-0 text-fg-subtle" aria-hidden />}
              {issues > 0 && <AlertCircle className="size-3.5 shrink-0 text-danger" aria-hidden />}
            </span>
            {field.type !== 'grid' && <FauxControl field={field} />}
            <span className="mt-1 flex items-center gap-1 text-[0.7rem] text-fg-subtle">
              <Icon className="size-3" aria-hidden />{t(info.label)}<span aria-hidden>·</span><code className="truncate">{field.key}</code>
            </span>
          </button>
          {field.type === 'grid' && (
            <ul className="mt-1 flex gap-1 overflow-x-auto rounded-sm border border-border bg-subtle p-1" aria-label={t('fb.props.columns')}>
              {field.columns.filter(c => !c.removed).map(c => {
                const on = selected?.key === field.key && selected.col === c.key;
                return (
                  <li key={c.key} className="shrink-0">
                    <button type="button" aria-pressed={on}
                      onClick={e => { e.stopPropagation(); onSelect({ key: field.key, col: c.key }); }}
                      className={cn('rounded-sm border px-2 py-1 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface text-fg-muted hover:border-border-strong')}
                      data-testid={`canvas-col-${field.key}-${c.key}`}
                    >
                      {c.type === 'formula' && <Sigma className="mr-0.5 inline size-3" aria-hidden />}{c.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {actions}
      </div>
    </li>
  );
}

/** Low-fidelity stand-in for the control (non-interactive spans: it sits inside the select button). */
function FauxControl({ field }: { field: Field }) {
  const box = 'mt-1 flex h-7 items-center overflow-hidden whitespace-nowrap rounded-sm border border-border bg-subtle px-2 text-xs text-fg-subtle';
  switch (field.type) {
    case 'help':
      return <span className={cn('mt-1 block rounded-sm px-2 py-1 text-xs', field.tone === 'warning' ? 'bg-warning-soft text-warning' : 'bg-accent-soft text-fg-muted')}>{field.text}</span>;
    case 'textarea': return <span className={cn(box, 'h-12 items-start pt-1')}>{field.placeholder}</span>;
    case 'checkbox': case 'toggle': return <span className="mt-1 block h-4 w-7 rounded-full bg-border-strong" aria-hidden />;
    case 'radio': case 'select': case 'multiselect':
      return <span className={box}>{field.options.slice(0, 3).map(o => o.label).join(' · ')}{field.options.length > 3 ? ' …' : ''}</span>;
    case 'formula':
      return <span className={cn(box, 'border-dashed border-accent/40 bg-accent-soft/50 font-mono text-fg-muted')}><Sigma className="mr-1 size-3 shrink-0 text-accent" aria-hidden /><span className="truncate">{field.expr}</span></span>;
    case 'lookup': case 'multilookup':
      return <span className={box}>{field.source.kind === 'master' ? t('fb.canvas.lookupOf', { master: field.source.masterKey }) : t(`fb.source.${field.source.kind}` as 'fb.source.user')}{field.filterBy.length ? ` · ${t('fb.canvas.cascades', { field: field.filterBy.map(f => f.field).join(', ') })}` : ''}</span>;
    case 'image': case 'file': case 'files': case 'signature':
      return <span className={cn(box, 'h-9 justify-center border-dashed')}>{t('fb.canvas.upload')}</span>;
    default: return <span className={box}>{'placeholder' in field ? field.placeholder : ''}</span>;
  }
}
