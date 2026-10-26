'use client';
import type { LocationNode } from '@procure/schema';
import {
  Badge, Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Input,
  Sheet, SheetContent, Skeleton, SkeletonGroup, StatusBadge, toast, UsageBar, usageLevel,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsDownUp, ChevronsUpDown, FolderInput, MapPinned, MoreHorizontal, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { useDefaultView, ViewChips } from '@/components/view-chips';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { Can, perm, useMe, usePermissions } from '@/lib/permissions';
import { locationKeys, locationsApi, type LocationView } from './api';
import { formatUsedBy, invalidateLocations, LocationFormDialog, MoveLocationDialog } from './location-dialogs';
import { ancestorIds, ancestorPath, buildTree, descendantIds, levelName, searchVisible, type TreeNode } from './tree';
import { TreeView } from './tree-view';

const TAB = 'admin.locations';
const VIEWS = ['active', 'inactive'] as const;

type DialogState =
  | { kind: 'add'; parent: LocationNode | null }
  | { kind: 'edit'; node: LocationNode }
  | { kind: 'move'; node: LocationNode }
  | { kind: 'deactivate'; node: LocationNode }
  | { kind: 'delete'; node: LocationNode }
  | null;

function useIsDesktop() {
  const [desk, setDesk] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const on = () => setDesk(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desk;
}

export function LocationsPage() {
  const qc = useQueryClient();
  const me = useMe();
  const p = usePermissions();
  const desktop = useIsDesktop();
  const rawLevels = me?.settings?.['labels.location_levels'];
  const levels = Array.isArray(rawLevels) ? (rawLevels as string[]) : undefined;
  const [view, setView] = useState<LocationView>(useDefaultView(TAB, VIEWS, 'active'));
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [panelError, setPanelError] = useState<{ msg: string; limit?: boolean } | null>(null);

  const q = useQuery({ queryKey: locationKeys.tree(view), queryFn: () => locationsApi.tree({ view }) });
  const tree = useMemo(() => buildTree(q.data ?? []), [q.data]);
  const search = useMemo(() => searchVisible(tree, query), [tree, query]);
  const selected = selectedId ? tree.byId.get(selectedId) ?? null : null;
  const limit = me?.limits?.find(l => l.key === 'max_locations');
  const levelOf = (depth: number, fallback?: string) => levelName(levels, depth, fallback ?? t('locations.level.default'));

  // First load: open the top level.
  useEffect(() => {
    if (q.data && expanded.size === 0) setExpanded(new Set(tree.roots.filter(r => r.children.length).map(r => r.id)));
  }, [q.data]); // only when data first arrives
  useEffect(() => setPanelError(null), [selectedId]);

  const reveal = (n: LocationNode) => {
    setSelectedId(n.id);
    const tn = tree.byId.get(n.id);
    const next = new Set(expanded);
    (tn ? ancestorIds(tn) : n.parentId ? [n.parentId] : []).forEach(a => next.add(a));
    setExpanded(next);
  };

  async function activate(n: LocationNode) {
    setPanelError(null);
    try {
      await locationsApi.activate(n.id);
      toast.success(t('locations.activated', { name: n.name }));
      invalidateLocations(qc);
    } catch (e) {
      if (isApiError(e) && e.is('LIMIT_EXCEEDED')) setPanelError({ msg: e.message, limit: true });
      else setPanelError({ msg: (e as Error).message });
    }
  }

  const canAdd = p.can(TAB, 'add');
  const allIds = () => new Set([...tree.byId.values()].filter(x => x.children.length).map(x => x.id));
  const levelsChain = (levels?.length ? levels : null)?.join(' › ');

  const actionsFor = (tn: TreeNode) => ({
    addChild: canAdd && tn.node.isActive ? () => setDialog({ kind: 'add', parent: tn.node }) : null,
    edit: p.can(TAB, 'edit') ? () => setDialog({ kind: 'edit', node: tn.node }) : null,
    move: p.can(TAB, 'move') ? () => setDialog({ kind: 'move', node: tn.node }) : null,
    toggle: p.can(TAB, 'deactivate') ? () => (tn.node.isActive ? setDialog({ kind: 'deactivate', node: tn.node }) : void activate(tn.node)) : null,
    remove: p.can(TAB, 'deactivate') && tn.children.length === 0 ? () => setDialog({ kind: 'delete', node: tn.node }) : null,
  });

  const panel = selected && (
    <DetailPanel
      tn={selected}
      level={selected.node.levelLabel || levelOf(selected.node.depth)}
      childLevel={levelOf(selected.node.depth + 1)}
      actions={actionsFor(selected)}
      error={panelError}
      onSelect={id => { const x = tree.byId.get(id); if (x) reveal(x.node); }}
    />
  );

  return (
    <PageBody>
      <PageHeader
        title={t('locations.title')}
        description={levelsChain ? t('locations.descriptionLevels', { levels: levelsChain }) : t('locations.description')}
        actions={canAdd && (
          <Button onClick={() => setDialog({ kind: 'add', parent: null })} data-testid="location-add-root"><Plus aria-hidden />{t('locations.add.root', { level: levelOf(1) })}</Button>
        )}
      />

      {limit && limit.effective !== null && (
        <LimitStrip used={limit.used} max={limit.effective} name={limit.name} />
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="flex min-h-[24rem] flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('locations.search')} aria-label={t('locations.search')} className="pl-8" data-testid="locations-search" />
            </div>
            <ViewChips
              tab={TAB}
              label={t('locations.viewLabel')}
              value={view}
              onChange={setView}
              testId="locations-view"
              options={[{ value: 'active', label: t('locations.view.active') }, { value: 'inactive', label: t('locations.view.inactive') }]}
              extra={[{ value: 'all', label: t('locations.view.all') }]}
            />
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" size="icon-sm" onClick={() => setExpanded(allIds())} aria-label={t('locations.expandAll')} title={t('locations.expandAll')} data-testid="locations-expand-all"><ChevronsUpDown aria-hidden /></Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setExpanded(new Set())} aria-label={t('locations.collapseAll')} title={t('locations.collapseAll')}><ChevronsDownUp aria-hidden /></Button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {q.isLoading ? (
              <SkeletonGroup label={t('common.loading')} className="space-y-1.5 p-1.5">
                {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-8" style={{ marginLeft: `${(i % 3) * 1.25}rem` }} />)}
              </SkeletonGroup>
            ) : q.isError ? (
              <div className="p-3"><InlineAlert>{(q.error as Error).message}</InlineAlert></div>
            ) : !tree.roots.length ? (
              <EmptyState
                icon={<MapPinned />}
                title={view === 'inactive' ? t('locations.emptyInactive') : t('locations.empty')}
                description={view === 'inactive' ? undefined : t('locations.emptyHint', { level: levelOf(1) })}
                action={canAdd && view !== 'inactive' && <Button variant="secondary" onClick={() => setDialog({ kind: 'add', parent: null })}><Plus aria-hidden />{t('locations.add.root', { level: levelOf(1) })}</Button>}
              />
            ) : search && !search.matches.size ? (
              <EmptyState icon={<Search />} title={t('locations.noMatch')} />
            ) : (
              <TreeView
                roots={tree.roots}
                label={t('locations.treeLabel')}
                expanded={expanded}
                onExpandedChange={setExpanded}
                visibleIds={search?.visible}
                selectedId={selectedId}
                onSelect={tn => { setSelectedId(tn.id); if (!desktop) setSheetOpen(true); }}
                rowTestId={tn => `location-row-${tn.node.code}`}
                data-testid="locations-tree"
                renderRow={tn => <Row tn={tn} match={!!search?.matches.has(tn.id)} actions={actionsFor(tn)} />}
              />
            )}
          </div>
        </Card>

        {desktop && (
          <aside aria-label={t('locations.details')} className="lg:sticky lg:top-[calc(var(--topbar-h)+var(--banner-h)+1rem)] lg:self-start">
            {panel ?? (
              <Card className="p-5 text-center text-fg-muted">
                <MapPinned className="mx-auto mb-2 size-6 text-fg-subtle" aria-hidden />
                <p>{t('locations.pickHint')}</p>
                <p className="mt-1 text-sm">{t('locations.keyboardHint')}</p>
              </Card>
            )}
          </aside>
        )}
      </div>

      {!desktop && (
        <Sheet open={sheetOpen && !!selected} onOpenChange={setSheetOpen}>
          <SheetContent side="right" title={selected?.node.name ?? t('locations.details')} closeLabel={t('common.close')}>
            <div className="p-3">{panel}</div>
          </SheetContent>
        </Sheet>
      )}

      {dialog?.kind === 'add' && (
        <LocationFormDialog
          open
          onOpenChange={o => { if (!o) setDialog(null); }}
          parent={dialog.parent}
          levelLabel={levelOf(dialog.parent ? dialog.parent.depth + 1 : 1)}
          onSaved={n => { if (view === 'inactive') setView('active'); reveal(n); }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <LocationFormDialog open onOpenChange={o => { if (!o) setDialog(null); }} node={dialog.node} levelLabel={dialog.node.levelLabel} />
      )}
      {dialog?.kind === 'move' && (
        <MoveLocationDialog open onOpenChange={o => { if (!o) setDialog(null); }} node={dialog.node} tree={tree} onMoved={reveal} />
      )}
      {dialog?.kind === 'deactivate' && (
        <ConfirmDialog
          open
          onOpenChange={o => { if (!o) setDialog(null); }}
          title={t('locations.deactivate.title', { name: dialog.node.name })}
          description={(() => {
            const tn = tree.byId.get(dialog.node.id);
            const n = tn ? descendantIds(tn).size : 0;
            return n ? t('locations.deactivate.cascade', { count: n }) : t('locations.deactivate.body');
          })()}
          confirmLabel={t('locations.action.deactivate')}
          tone="danger"
          testId="confirm-location-deactivate"
          onConfirm={async () => {
            await locationsApi.deactivate(dialog.node.id);
            toast.success(t('locations.deactivated', { name: dialog.node.name }));
            invalidateLocations(qc);
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog node={dialog.node} onClose={() => setDialog(null)} onDeleted={() => { setSelectedId(dialog.node.parentId); invalidateLocations(qc); }} />
      )}
    </PageBody>
  );
}

function LimitStrip({ used, max, name }: { used: number; max: number; name: string }) {
  const level = usageLevel(used, max);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-2.5" data-testid="locations-limit" data-level={level}>
      <p className="text-sm">
        <span className="font-semibold tabular">{fmtNumber(used)}</span>
        <span className="text-fg-muted"> {t('locations.limit', { max: fmtNumber(max) })}</span>
      </p>
      <UsageBar used={used} max={max} label={name} className="min-w-32 flex-1" />
      {level === 'full' && <StatusBadge tone="danger">{t('locations.limitFull')}</StatusBadge>}
      {level === 'warn' && <StatusBadge tone="warning">{t('usage.nearLimit')}</StatusBadge>}
    </div>
  );
}

type Actions = { addChild: (() => void) | null; edit: (() => void) | null; move: (() => void) | null; toggle: (() => void) | null; remove: (() => void) | null };

function Row({ tn, match, actions }: { tn: TreeNode; match: boolean; actions: Actions }) {
  const n = tn.node;
  const any = Object.values(actions).some(Boolean);
  return (
    <>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={match ? 'truncate font-semibold' : 'truncate'}>{n.name}</span>
        <span className="hidden font-mono text-xs text-fg-subtle sm:inline">{n.code}</span>
      </span>
      <span className="hidden text-xs text-fg-subtle md:inline">{n.levelLabel}</span>
      {!n.isActive && <StatusBadge tone="neutral">{t('locations.inactive')}</StatusBadge>}
      {any && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              tabIndex={-1}
              className="size-7 opacity-60 group-hover:opacity-100 data-[state=open]:opacity-100"
              aria-label={t('locations.actionsFor', { name: n.name })}
              onClick={e => e.stopPropagation()}
              onKeyDown={e => e.stopPropagation()}
              data-testid={`location-menu-${n.code}`}
            >
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
            <ActionItems actions={actions} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function ActionItems({ actions }: { actions: Actions }) {
  return (
    <>
      {actions.addChild && <DropdownMenuItem onSelect={actions.addChild} data-testid="location-action-add-child"><Plus aria-hidden />{t('locations.action.addChild')}</DropdownMenuItem>}
      {actions.edit && <DropdownMenuItem onSelect={actions.edit} data-testid="location-action-edit"><Pencil aria-hidden />{t('locations.action.edit')}</DropdownMenuItem>}
      {actions.move && <DropdownMenuItem onSelect={actions.move} data-testid="location-action-move"><FolderInput aria-hidden />{t('locations.action.move')}</DropdownMenuItem>}
      {(actions.toggle || actions.remove) && <DropdownMenuSeparator />}
      {actions.toggle && <DropdownMenuItem onSelect={actions.toggle} data-testid="location-action-toggle"><Power aria-hidden />{t('locations.action.toggle')}</DropdownMenuItem>}
      {actions.remove && <DropdownMenuItem destructive onSelect={actions.remove} data-testid="location-action-delete"><Trash2 aria-hidden />{t('locations.action.delete')}</DropdownMenuItem>}
    </>
  );
}

function DetailPanel({ tn, level, childLevel, actions, error, onSelect }: {
  tn: TreeNode;
  level: string;
  childLevel: string;
  actions: Actions;
  error: { msg: string; limit?: boolean } | null;
  onSelect: (id: string) => void;
}) {
  const n = tn.node;
  const crumbs = ancestorPath(n);
  const ancestors = (() => { const out: TreeNode[] = []; for (let x = tn.parent; x; x = x.parent) out.unshift(x); return out; })();
  return (
    <Card className="overflow-hidden" data-testid="location-detail">
      <div className="space-y-1 border-b border-border px-4 py-3">
        {crumbs.length > 0 && (
          <nav aria-label={t('locations.breadcrumb')} className="truncate text-sm text-fg-muted">
            {ancestors.length === crumbs.length
              ? ancestors.map((a, i) => <span key={a.id}>{i > 0 && ' / '}<button type="button" className="hover:text-fg hover:underline" onClick={() => onSelect(a.id)}>{a.node.name}</button></span>)
              : crumbs.join(' / ')}
          </nav>
        )}
        <h2 className="text-md font-semibold">{n.name}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{level}</Badge>
          {n.isActive ? <StatusBadge tone="success">{t('locations.active')}</StatusBadge> : <StatusBadge tone="neutral">{t('locations.inactive')}</StatusBadge>}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 px-4 py-3 text-base">
        <Field label={t('locations.field.code')}><span className="font-mono">{n.code}</span></Field>
        <Field label={t('locations.field.sortOrder')}><span className="tabular">{n.sortOrder}</span></Field>
        <Field label={t('locations.children')}><span className="tabular">{tn.children.length || n.childCount}</span></Field>
        <Field label={t('locations.field.depth')}><span className="tabular">{n.depth}</span></Field>
      </dl>
      {error && <div className="px-4 pb-3"><InlineAlert tone={error.limit ? 'warning' : 'danger'} data-testid={error.limit ? 'location-limit-error' : 'location-error'}>{error.msg}</InlineAlert></div>}
      <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
        {actions.addChild && <Button size="sm" onClick={actions.addChild} data-testid="location-add-child"><Plus aria-hidden />{t('locations.add.child', { level: childLevel })}</Button>}
        {actions.edit && <Button size="sm" variant="secondary" onClick={actions.edit} data-testid="location-edit"><Pencil aria-hidden />{t('locations.action.edit')}</Button>}
        {actions.move && <Button size="sm" variant="secondary" onClick={actions.move} data-testid="location-move"><FolderInput aria-hidden />{t('locations.action.move')}</Button>}
        {actions.toggle && (n.isActive
          ? <Button size="sm" variant="danger-outline" onClick={actions.toggle} data-testid="location-deactivate"><Power aria-hidden />{t('locations.action.deactivate')}</Button>
          : <Button size="sm" variant="secondary" onClick={actions.toggle} data-testid="location-activate"><Power aria-hidden />{t('locations.action.activate')}</Button>)}
        {actions.remove && <Button size="sm" variant="ghost" className="text-danger" onClick={actions.remove} data-testid="location-delete"><Trash2 aria-hidden />{t('locations.action.delete')}</Button>}
        <Can anyOf={[perm.action(TAB, 'add'), perm.action(TAB, 'edit'), perm.action(TAB, 'move'), perm.action(TAB, 'deactivate')]} fallback={<p className="text-sm text-fg-muted">{t('locations.viewOnly')}</p>}>{null}</Can>
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-sm text-fg-muted">{label}</dt><dd>{children}</dd></div>;
}

function DeleteDialog({ node, onClose, onDeleted }: { node: LocationNode; onClose: () => void; onDeleted: () => void }) {
  const [usedBy, setUsedBy] = useState<string[] | null>(null);
  return (
    <ConfirmDialog
      open
      onOpenChange={o => { if (!o) onClose(); }}
      title={t('locations.delete.title', { name: node.name })}
      description={t('locations.delete.body')}
      confirmLabel={t('locations.action.delete')}
      tone="danger"
      testId="confirm-location-delete"
      onConfirm={async () => {
        try {
          await locationsApi.remove(node.id);
        } catch (e) {
          if (isApiError(e) && e.status === 409) {
            const list = formatUsedBy(e.meta.usedBy);
            setUsedBy(list);
            throw new Error(t('locations.delete.inUse'));
          }
          throw e;
        }
        toast.success(t('locations.deleted', { name: node.name }));
        onDeleted();
      }}
    >
      {usedBy && usedBy.length > 0 && (
        <div className="rounded border border-warning/30 bg-warning-soft px-3 py-2.5 text-warning" data-testid="location-used-by">
          <p className="font-medium">{t('locations.delete.usedBy')}</p>
          <ul className="mt-1 list-disc pl-5">{usedBy.map(u => <li key={u}>{u}</li>)}</ul>
          <p className="mt-1.5 text-sm">{t('locations.delete.deactivateInstead')}</p>
        </div>
      )}
    </ConfirmDialog>
  );
}
