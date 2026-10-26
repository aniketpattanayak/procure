'use client';
import type { PermissionSetView, ScopeEntry } from '@procure/schema';
import { Button, Card, Checkbox, cn, EmptyState, Input, NativeSelect, Skeleton, SkeletonGroup, Switch, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe2, MapPin, RotateCcw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { locationKeys, locationsApi } from '@/features/locations/api';
import { ancestorIds, buildTree, searchVisible, type TreeNode } from '@/features/locations/tree';
import { TreeView } from '@/features/locations/tree-view';
import { t } from '@/i18n';
import { useSession } from '@/lib/session';
import { permissionsApi, qk, type Subject } from './api';
import { useRegistry } from './permission-workbench';

type Entry = ScopeEntry;
const keyOf = (e: Entry) => `${e.tabKey ?? '*'}|${e.allNodes ? '*' : e.nodeId}`;

function normalise(list: Entry[]) {
  return [...list].map(e => ({ allNodes: e.allNodes, nodeId: e.nodeId, includeDescendants: e.includeDescendants, tabKey: e.tabKey })).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}
function sameEntries(a: Entry[], b: Entry[]) {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

/**
 * Data scope: which locations a role / user's records are limited to. "All locations" or a set of nodes, each
 * optionally including its sub-locations. Entries can apply to every tab (default) or narrow one scoped tab.
 */
export function ScopeEditor({ subject, readOnly, isTenantAdmin }: { subject: Subject; readOnly?: boolean; isTenantAdmin?: boolean }) {
  const qc = useQueryClient();
  const { reloadMe } = useSession();
  const set = useQuery({ queryKey: qk.set(subject), queryFn: () => permissionsApi.get(subject) });
  const registry = useRegistry();
  const tree = useQuery({ queryKey: locationKeys.tree('active'), queryFn: () => locationsApi.tree({ view: 'active' }) });
  const scopedTabs = (registry.data ?? []).filter(x => x.scoped);

  const server = useMemo<Entry[]>(() => (set.data?.scope ?? []).map(s => ({ allNodes: s.allNodes, nodeId: s.nodeId, includeDescendants: s.includeDescendants, tabKey: s.tabKey })), [set.data]);
  const [entries, setEntries] = useState<Entry[]>(server);
  useEffect(() => setEntries(server), [server]);
  const [tabKey, setTabKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const built = useMemo(() => buildTree(tree.data ?? []), [tree.data]);
  // Open the first level by default and the path to every selected node.
  useEffect(() => {
    if (!tree.data) return;
    const open = new Set(built.roots.map(r => r.id));
    for (const e of server) {
      const tn = e.nodeId ? built.byId.get(e.nodeId) : undefined;
      if (tn) ancestorIds(tn).forEach(a => open.add(a));
    }
    setExpanded(open);
  }, [built, tree.data, server]);

  const dirty = !sameEntries(entries, server);
  const mine = entries.filter(e => e.tabKey === tabKey);
  const allNodes = mine.some(e => e.allNodes);
  const byNode = new Map(mine.filter(e => !e.allNodes && e.nodeId).map(e => [e.nodeId!, e]));
  const search = useMemo(() => searchVisible(built, query), [built, query]);

  /** A node is covered when an ancestor is selected with "include sub-locations". */
  const coveredBy = (tn: TreeNode): TreeNode | null => {
    for (let p = tn.parent; p; p = p.parent) { const e = byNode.get(p.id); if (e?.includeDescendants) return p; }
    return null;
  };

  const replaceMine = (next: Entry[]) => setEntries([...entries.filter(e => e.tabKey !== tabKey), ...next]);
  const toggleNode = (tn: TreeNode) => {
    if (readOnly || allNodes || coveredBy(tn)) return;
    if (byNode.has(tn.id)) replaceMine(mine.filter(e => e.nodeId !== tn.id));
    else replaceMine([...mine, { allNodes: false, nodeId: tn.id, includeDescendants: true, tabKey }]);
  };
  const setDescendants = (tn: TreeNode, on: boolean) => replaceMine(mine.map(e => (e.nodeId === tn.id ? { ...e, includeDescendants: on } : e)));
  const setAll = (on: boolean) => replaceMine(on ? [{ allNodes: true, nodeId: null, includeDescendants: true, tabKey }] : []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next: PermissionSetView = await permissionsApi.saveScope(subject, entries);
      qc.setQueryData(qk.set(subject), next);
      void qc.invalidateQueries({ queryKey: ['permissions', 'effective'] });
      void qc.invalidateQueries({ queryKey: locationKeys.mine });
      void reloadMe();
      toast.success(t('scope.saved'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const tabsWithEntries = new Set(entries.map(e => e.tabKey).filter(Boolean));
  const summary = allNodes ? t('scope.summaryAll') : mine.length ? t('scope.summaryCount', { count: mine.length }) : tabKey ? t('scope.summaryInherit') : t(subject.kind === 'user' ? 'scope.summaryNoneUser' : 'scope.summaryNone');

  if (set.isLoading || tree.isLoading) {
    return <SkeletonGroup label={t('common.loading')} className="space-y-2 rounded-lg border border-border p-4">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-8" />)}</SkeletonGroup>;
  }
  if (set.isError) return <InlineAlert>{(set.error as Error).message}</InlineAlert>;

  return (
    <Card className="overflow-hidden" data-testid="scope-editor">
      <div className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold">{t('scope.title')}</h2>
          <p className="text-sm text-fg-muted">{t(subject.kind === 'role' ? 'scope.hintRole' : 'scope.hintUser')}</p>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {dirty && <span className="text-sm text-warning" role="status">{t('perm.unsaved')}</span>}
            <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => setEntries(server)}><RotateCcw aria-hidden />{t('perm.revert')}</Button>
            <Button size="sm" disabled={!dirty} loading={saving} onClick={() => void save()} data-testid="scope-save">{t('scope.save')}</Button>
          </div>
        )}
      </div>

      <div className="space-y-4 px-4 py-4 sm:px-5">
        {isTenantAdmin && <InlineAlert tone="info">{t('scope.adminNote')}</InlineAlert>}
        {error && <InlineAlert>{error}</InlineAlert>}

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-1 flex-col gap-1.5 sm:max-w-xs">
            <span className="text-sm font-medium">{t('scope.appliesTo')}</span>
            <NativeSelect value={tabKey ?? ''} onChange={e => setTabKey(e.target.value || null)} data-testid="scope-tab">
              <option value="">{t('scope.everyTab')}</option>
              {scopedTabs.map(x => <option key={x.key} value={x.key}>{x.label}{tabsWithEntries.has(x.key) ? ` ${t('scope.narrowedMark')}` : ''}</option>)}
            </NativeSelect>
          </label>
          <p className="pb-2 text-sm text-fg-muted" role="status" data-testid="scope-summary">{summary}</p>
        </div>

        <label className={cn('flex items-center gap-3 rounded border px-3 py-3', allNodes ? 'border-accent/50 bg-accent-soft' : 'border-border')}>
          <Switch checked={allNodes} onCheckedChange={setAll} disabled={readOnly} data-testid="scope-all" aria-describedby="scope-all-hint" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium"><Globe2 className="size-4" aria-hidden />{t('scope.allLocations')}</span>
            <span id="scope-all-hint" className="block text-sm text-fg-muted">{t('scope.allLocationsHint')}</span>
          </span>
        </label>

        {!tree.data?.length ? (
          <EmptyState icon={<MapPin />} title={t('scope.noLocations')} description={t('scope.noLocationsHint')} />
        ) : (
          <div className={cn('rounded border border-border', allNodes && 'pointer-events-none opacity-50')} aria-disabled={allNodes || undefined}>
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
                <Input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('locations.search')} aria-label={t('locations.search')} className="pl-8" data-testid="scope-search" />
              </div>
            </div>
            <div className="max-h-[28rem] overflow-y-auto p-1">
              <TreeView
                roots={built.roots}
                label={t('scope.treeLabel')}
                multiselectable
                expanded={expanded}
                onExpandedChange={setExpanded}
                visibleIds={search?.visible}
                onSelect={toggleNode}
                checked={tn => byNode.has(tn.id) || !!coveredBy(tn)}
                disabled={tn => !!readOnly || allNodes || !!coveredBy(tn)}
                rowTestId={tn => `scope-node-${tn.node.code}`}
                renderRow={(tn) => {
                  const e = byNode.get(tn.id);
                  const cover = coveredBy(tn);
                  return (
                    <>
                      <Checkbox
                        tabIndex={-1}
                        aria-hidden
                        checked={!!e || !!cover}
                        disabled={!!readOnly || allNodes || !!cover}
                        onClick={ev => ev.stopPropagation()}
                        onCheckedChange={() => toggleNode(tn)}
                        className="mr-2"
                      />
                      <span className={cn('min-w-0 flex-1 truncate', search?.matches.has(tn.id) && 'font-medium')}>
                        {tn.node.name} <span className="text-sm text-fg-subtle">{tn.node.levelLabel}</span>
                      </span>
                      {cover && <span className="hidden text-xs text-fg-subtle sm:inline">{t('scope.viaParent', { name: cover.node.name })}</span>}
                      {e && tn.children.length > 0 && (
                        <label className="flex items-center gap-1.5 text-xs text-fg-muted" onClick={ev => ev.stopPropagation()}>
                          <Switch
                            checked={e.includeDescendants}
                            onCheckedChange={v => setDescendants(tn, v)}
                            disabled={readOnly}
                            aria-label={t('scope.includeSubFor', { name: tn.node.name })}
                            data-testid={`scope-desc-${tn.node.code}`}
                          />
                          <span className="hidden sm:inline">{t('scope.includeSub')}</span>
                        </label>
                      )}
                    </>
                  );
                }}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
