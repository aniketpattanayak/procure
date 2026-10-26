'use client';
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Effect, SimulateResult, Stage, WorkflowActor, WorkflowDefinition } from '@procure/schema';
import {
  Badge, Button, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@procure/ui';
import {
  AlertCircle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleCheckBig, Clock, Copy, Filter, GripVertical, MoreHorizontal,
  Plus, PlusSquare, Power, Send, SplitSquareHorizontal, Trash2, Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '@/i18n';
import { rowsOf } from './model';

const HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, rgb(var(--c-muted)) 0 4px, transparent 4px 8px)' };

export type SimStage = SimulateResult['stages'][number];

export interface Names {
  role: (id: string) => string;
  user: (id: string) => string;
  field: (key: string) => string;
}

export function actorLabel(a: WorkflowActor, n: Names): string {
  switch (a.type) {
    case 'role': return t('wf.actor.roleNamed', { name: n.role(a.roleId) });
    case 'users': return a.userIds.length === 1 ? n.user(a.userIds[0]!) : t('wf.actor.usersN', { n: a.userIds.length });
    case 'reporting_manager': return t('wf.actor.reporting_manager');
    case 'field': return t('wf.actor.fieldNamed', { name: n.field(a.field) });
    default: return '';
  }
}

export function effectLabel(e: Effect): string {
  return t(`wf.effect.${e.effect}` as 'wf.effect.notify');
}

export function slaLabel(s: Stage['sla']): string | null {
  if (!s) return null;
  return s.remindEveryHours ? t('wf.card.slaRemind', { h: s.hours, r: s.remindEveryHours }) : t('wf.card.sla', { h: s.hours });
}

export interface LaneProps {
  def: WorkflowDefinition;
  selected: string | null;
  issuesByKey: Map<string, number>;
  sim: Map<string, SimStage> | null;
  names: Names;
  readOnly?: boolean;
  onSelect: (key: string | null) => void;
  onInsert: (rowIndex: number) => void;
  onAddParallel: (rowIndex: number) => void;
  onMoveRow: (from: number, to: number) => void;
  onAction: (key: string, action: 'duplicate' | 'delete' | 'detach' | 'left' | 'right' | 'up' | 'down' | 'toggle') => void;
}

/** Vertical stage lane: Start → rows of stages (parallel rows side by side) → End, with insertion points between rows. */
export function Lane(props: LaneProps) {
  const { def, readOnly, onInsert, onMoveRow, sim } = props;
  const rows = rowsOf(def.stages);
  const ids = rows.map(r => `row:${def.stages[r.indexes[0]!]!.key}`);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.over.id === e.active.id) return;
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from >= 0 && to >= 0) onMoveRow(from, to);
  }
  const anyRuns = sim ? [...sim.values()].some(s => s.outcome === 'run' || s.outcome === 'no_actor_admins') : false;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-8 sm:px-10" data-testid="wf-lane">
      <Terminal kind="start" effects={def.onSubmit} onClick={() => props.onSelect(null)} />
      <Connector index={0} onInsert={readOnly ? undefined : onInsert} last={rows.length === 0} lit={!!sim} />
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol className="contents" aria-label={t('wf.lane.label')}>
            {rows.map((r, ri) => (
              <SortableRow key={ids[ri]} id={ids[ri]!} index={ri} count={rows.length} readOnly={readOnly}>
                <RowBody {...props} rowIndex={ri} stages={r.indexes.map(i => def.stages[i]!)} parallel={r.indexes.length > 1} />
                <Connector index={ri + 1} onInsert={readOnly ? undefined : onInsert} last={ri === rows.length - 1} lit={!!sim} />
              </SortableRow>
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {rows.length === 0 && (
        <p className="mx-auto mb-3 max-w-sm text-center text-sm text-fg-muted" data-testid="wf-empty">{t('wf.lane.empty')}</p>
      )}
      <Terminal kind="end" effects={def.onComplete} onClick={() => props.onSelect(null)} autoApprove={rows.length === 0 || (!!sim && !anyRuns)} />
    </div>
  );
}

function SortableRow({ id, index, count, readOnly, children }: { id: string; index: number; count: number; readOnly?: boolean; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: readOnly });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn('relative list-none', isDragging && 'z-10 opacity-90')}>
      {!readOnly && count > 1 && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={t('wf.lane.reorder', { n: index + 1 })}
          className="absolute -left-8 top-3 hidden cursor-grab touch-none rounded p-1 text-fg-subtle hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing sm:block"
          data-testid={`wf-drag-${id.slice(4)}`}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      )}
      {children}
    </li>
  );
}

function RowBody(props: LaneProps & { rowIndex: number; stages: Stage[]; parallel: boolean }) {
  const { stages, parallel, rowIndex, readOnly, onAddParallel } = props;
  const first = stages[0]!;
  const addParallel = !readOnly && (
    <button
      type="button"
      onClick={() => onAddParallel(rowIndex)}
      className="grid min-h-16 w-10 shrink-0 place-items-center rounded-lg border border-dashed border-border-strong text-fg-subtle hover:border-accent hover:bg-accent-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t('wf.lane.addParallel', { name: first.name })}
      title={t('wf.lane.addParallelHint')}
      data-testid={`wf-add-parallel-${first.key}`}
    >
      <PlusSquare className="size-4" aria-hidden />
    </button>
  );
  if (!parallel) {
    return (
      <div className="flex items-stretch gap-2">
        <div className="min-w-0 flex-1"><StageCard {...props} stage={first} label={String(rowIndex + 1)} /></div>
        {addParallel}
      </div>
    );
  }
  return (
    <div className="flex items-stretch gap-2">
      <div className="relative min-w-0 flex-1 rounded-lg border border-accent/30 bg-accent-soft/40 p-2 pt-7" data-testid={`wf-row-${first.parallelGroup}`}>
        <p className="absolute left-3 top-1.5 flex items-center gap-1.5 text-xs font-medium text-accent">
          <SplitSquareHorizontal className="size-3.5" aria-hidden />{t('wf.lane.parallel', { n: stages.length })}
        </p>
        <div className={cn('grid gap-2', stages.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-3')}>
          {stages.map((s, i) => (
            <StageCard key={s.key} {...props} stage={s} label={`${rowIndex + 1}${String.fromCharCode(97 + i)}`} inRow={{ first: i === 0, last: i === stages.length - 1 }} />
          ))}
        </div>
      </div>
      {addParallel}
    </div>
  );
}

function StageCard({ stage, label, selected, issuesByKey, sim, names, readOnly, onSelect, onAction, inRow, rowIndex, def }: LaneProps & { stage: Stage; label: string; rowIndex: number; inRow?: { first: boolean; last: boolean } }) {
  const isSel = selected === stage.key;
  const issues = issuesByKey.get(stage.key) ?? 0;
  const res = sim?.get(stage.key);
  const runs = res && (res.outcome === 'run' || res.outcome === 'no_actor_admins');
  const skipped = res && !runs;
  const actors = stage.actors.length ? stage.actors.map(a => actorLabel(a, names)) : [t('wf.actor.anyone')];
  const sla = slaLabel(stage.sla);
  const effects = stage.effects.onEnter.length + stage.effects.onApprove.length + stage.effects.onReject.length;
  const rows = rowsOf(def.stages).length;

  return (
    <div
      data-testid={`wf-stage-${stage.key}`}
      data-selected={isSel || undefined}
      data-enabled={stage.enabled}
      data-sim={res?.outcome}
      onClick={() => onSelect(stage.key)}
      className={cn(
        'group relative flex cursor-pointer overflow-hidden rounded-lg border bg-surface text-left transition-shadow',
        isSel ? 'border-accent shadow-pop ring-2 ring-accent/40' : 'border-border hover:border-border-strong',
        !stage.enabled && 'border-dashed bg-subtle',
        skipped && 'opacity-60',
      )}
    >
      {/* Order rail: the stage number, tinted by the simulation outcome when one is shown. */}
      <div aria-hidden style={skipped ? HATCH : undefined} className={cn(
        'flex w-9 shrink-0 flex-col items-center border-r pt-3 text-xs font-semibold tabular-nums',
        runs ? 'border-success/30 bg-success-soft text-success' : skipped ? 'border-border text-fg-subtle' : isSel ? 'border-accent/30 bg-accent-soft text-accent' : 'border-border bg-subtle text-fg-muted',
      )}>
        {label}
      </div>
      <div className={cn('min-w-0 flex-1 px-3 py-2.5', !stage.enabled && 'text-fg-muted')}>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onSelect(stage.key); }}
              className="block max-w-full truncate text-left font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-pressed={isSel}
              data-testid={`wf-stage-${stage.key}-open`}
            >
              {stage.name || <span className="italic text-fg-subtle">{t('wf.card.unnamed')}</span>}
            </button>
            <p className="truncate font-mono text-xs text-fg-subtle">{stage.key}</p>
          </div>
          {issues > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger" title={t('wf.card.issues', { n: issues })}>
              <AlertCircle className="size-3" aria-hidden />{issues}<span className="sr-only">{t('wf.card.issues', { n: issues })}</span>
            </span>
          )}
          {!stage.enabled && <Badge>{t('wf.card.disabled')}</Badge>}
          {!readOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="-mr-1 -mt-0.5" onClick={e => e.stopPropagation()} aria-label={t('wf.card.menu', { name: stage.name })} data-testid={`wf-stage-menu-${stage.key}`}>
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent onClick={e => e.stopPropagation()}>
                {!inRow && rowIndex > 0 && <DropdownMenuItem onSelect={() => onAction(stage.key, 'up')}><ArrowUp aria-hidden />{t('wf.card.moveUp')}</DropdownMenuItem>}
                {!inRow && rowIndex < rows - 1 && <DropdownMenuItem onSelect={() => onAction(stage.key, 'down')}><ArrowDown aria-hidden />{t('wf.card.moveDown')}</DropdownMenuItem>}
                {inRow && !inRow.first && <DropdownMenuItem onSelect={() => onAction(stage.key, 'left')}><ArrowLeft aria-hidden />{t('wf.card.moveLeft')}</DropdownMenuItem>}
                {inRow && !inRow.last && <DropdownMenuItem onSelect={() => onAction(stage.key, 'right')}><ArrowRight aria-hidden />{t('wf.card.moveRight')}</DropdownMenuItem>}
                {inRow && <DropdownMenuItem onSelect={() => onAction(stage.key, 'detach')} data-testid={`wf-detach-${stage.key}`}><SplitSquareHorizontal aria-hidden />{t('wf.card.detach')}</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => onAction(stage.key, 'toggle')}><Power aria-hidden />{stage.enabled ? t('wf.card.disable') : t('wf.card.enable')}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAction(stage.key, 'duplicate')}><Copy aria-hidden />{t('wf.card.duplicate')}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => onAction(stage.key, 'delete')} data-testid={`wf-delete-${stage.key}`}><Trash2 aria-hidden />{t('wf.card.delete')}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <ul className="mt-2 flex flex-wrap gap-1.5 text-xs" aria-label={t('wf.card.summary')}>
          <li className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-fg-muted">
            <Users className="size-3 shrink-0" aria-hidden /><span className="truncate">{actors.join(t('wf.card.or'))}</span>
          </li>
          {stage.quorum === 'all' && <li className="rounded bg-muted px-1.5 py-0.5 text-fg-muted">{t('wf.card.quorumAll')}</li>}
          {stage.when?.trim() && (
            <li className="inline-flex max-w-full items-center gap-1 rounded bg-warning-soft px-1.5 py-0.5 text-warning" data-testid={`wf-cond-${stage.key}`} title={stage.when}>
              <Filter className="size-3 shrink-0" aria-hidden /><span className="truncate">{t('wf.card.onlyWhen')} <span className="font-mono">{stage.when}</span></span>
            </li>
          )}
          {sla && (
            <li className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-fg-muted" data-testid={`wf-sla-${stage.key}`}>
              <Clock className="size-3" aria-hidden />{sla}
            </li>
          )}
          {effects > 0 && <li className="rounded bg-muted px-1.5 py-0.5 text-fg-muted">{t('wf.card.effects', { n: effects })}</li>}
        </ul>

        {res && (
          <p className={cn('mt-2 border-t pt-1.5 text-xs', runs ? 'border-success/30 text-success' : 'border-border text-fg-muted')} data-testid={`wf-sim-card-${stage.key}`}>
            <span className="font-semibold">{t(`wf.sim.outcome.${res.outcome}` as 'wf.sim.outcome.run')}</span>
            {runs && res.actors.length > 0 && <span className="text-fg-muted">{` — ${res.actors.join(', ')}`}</span>}
            {res.error && <span className="text-danger">{` — ${res.error}`}</span>}
          </p>
        )}
      </div>
    </div>
  );
}

function Connector({ index, onInsert, last, lit }: { index: number; onInsert?: (i: number) => void; last?: boolean; lit?: boolean }) {
  return (
    <div className="relative flex flex-col items-center py-1" aria-hidden={!onInsert}>
      <span className={cn('h-3 w-px', lit ? 'bg-success/60' : 'bg-border-strong')} />
      {onInsert && last ? (
        <Button
          variant="secondary" size="sm" className="my-0.5 h-7 rounded-full px-3 text-xs"
          onClick={() => onInsert(index)}
          data-testid="wf-add-stage"
        >
          <Plus aria-hidden />{t('wf.lane.addStage')}
        </Button>
      ) : onInsert ? (
        <button
          type="button"
          onClick={() => onInsert(index)}
          className="my-0.5 grid size-6 place-items-center rounded-full border border-border-strong bg-surface text-fg-subtle opacity-70 hover:border-accent hover:text-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={t('wf.lane.insertAt', { n: index + 1 })}
          data-testid={`wf-insert-${index}`}
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      ) : null}
      <span className={cn('h-3 w-px', lit ? 'bg-success/60' : 'bg-border-strong')} />
      <ArrowDown className={cn('-mt-1.5 size-3', lit ? 'text-success/70' : 'text-border-strong')} aria-hidden />
    </div>
  );
}

function Terminal({ kind, effects, onClick, autoApprove }: { kind: 'start' | 'end'; effects: Effect[]; onClick: () => void; autoApprove?: boolean }) {
  const start = kind === 'start';
  const Icon = start ? Send : CircleCheckBig;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-auto flex w-fit max-w-full items-center gap-2.5 rounded-full border border-border bg-surface py-1.5 pl-1.5 pr-4 text-left hover:border-border-strong focus-visible:outline-2 focus-visible:outline-ring"
      data-testid={start ? 'wf-start' : 'wf-end'}
    >
      <span className={cn('grid size-7 shrink-0 place-items-center rounded-full', start ? 'bg-accent text-accent-fg' : 'bg-success text-white dark:text-bg')}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{start ? t('wf.lane.start') : autoApprove ? t('wf.lane.endAuto') : t('wf.lane.end')}</span>
        {effects.length > 0 && <span className="block truncate text-xs text-fg-muted">{effects.map(effectLabel).join(', ')}</span>}
      </span>
    </button>
  );
}
