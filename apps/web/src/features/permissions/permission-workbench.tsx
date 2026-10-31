'use client';
import type { EffectivePermissions, PermissionSetView, RegistryTab } from '@procure/schema';
import { Badge, Button, Checkbox, cn, Dialog, DialogContent, EmptyState, Input, NativeSelect, Segmented, Skeleton, SkeletonGroup, toast } from '@procure/ui';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Minus, RotateCcw, Search, ShieldOff, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { permissionsApi, qk, type Subject } from './api';
import {
  actionKey, countsFor, draftFromSet, draftsEqual, effectiveFor, fieldId, roleBody, roleSources, tabKeys, userBody, viewKey,
  type Draft, type RoleDraft, type RoleFieldMode, type UserDraft, type UserFieldMode,
} from './model';

export interface WorkbenchProps {
  subject: Subject;
  /** For users: assigned roles (to show inherited field access). */
  userRoles?: { id: string; name: string }[];
  /** For users: true when the user is a company administrator (holds every key). */
  isTenantAdmin?: boolean;
  /** Disable editing (e.g. system role). */
  readOnly?: boolean;
  readOnlyReason?: string;
}

export function useRegistry() {
  return useQuery({ queryKey: qk.registry, queryFn: permissionsApi.registry, staleTime: 60_000 });
}

/** Orders groups the way the sidebar does; unknown groups keep registry order. */
const GROUP_ORDER = ['Masters', 'Configuration', 'Administration'];
export function groupTabs(tabs: RegistryTab[]) {
  const groups = new Map<string, RegistryTab[]>();
  for (const tab of tabs) {
    const list = groups.get(tab.group) ?? [];
    list.push(tab);
    groups.set(tab.group, list);
  }
  return [...groups].sort(([a], [b]) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? -1 : ia) - (ib < 0 ? -1 : ib);
  });
}

/**
 * The permission screen: tab list on the left, one tab's buttons / status views / field access on the right,
 * saved per tab. Used by Role detail and User access.
 */
export function PermissionWorkbench({ subject, userRoles = [], isTenantAdmin = false, readOnly, readOnlyReason }: WorkbenchProps) {
  const qc = useQueryClient();
  const { reloadMe } = useSession();
  const registry = useRegistry();
  const set = useQuery({ queryKey: qk.set(subject), queryFn: () => permissionsApi.get(subject) });
  const isUser = subject.kind === 'user';
  const effective = useQuery({ queryKey: qk.effective(subject.id), queryFn: () => permissionsApi.effective(subject.id), enabled: isUser });
  // Inherited field access comes from each assigned role's own set (best effort: hidden if the caller can't read roles).
  const roleSets = useQueries({
    queries: (isUser ? userRoles : []).map(r => ({ queryKey: qk.set({ kind: 'role', id: r.id }), queryFn: () => permissionsApi.get({ kind: 'role', id: r.id }), retry: false })),
  });

  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draftState, setDraft] = useState<Draft | null>(null);
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allTabs = registry.data ?? [];
  // Filter out bare-key tabs (e.g. "indent") that have a corresponding "doc.*" entry (e.g. "doc.indent");
  // both can coexist when old platform entries pre-date the doc.* naming convention.
  const docKeys = new Set(allTabs.filter(t => t.key.startsWith("doc.")).map(t => t.key.slice(4)));
  const tabs = allTabs.filter(t => t.key.includes(".") || !docKeys.has(t.key));
  const tab = tabs.find(x => x.key === selectedKey) ?? tabs[0];

  const baseline = useMemo(() => (tab ? draftFromSet(subject.kind, tab, set.data) : null), [tab, set.data, subject.kind]);
  // Reset the draft whenever the tab or the saved data changes.
  useEffect(() => { setDraft(baseline); setError(null); }, [baseline]);
  // Until the effect runs for a new tab, show the saved state rather than nothing / the previous tab.
  const draft = draftState && baseline && draftState.kind === baseline.kind ? draftState : baseline;
  const dirty = !!draft && !!baseline && !draftsEqual(draft, baseline);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const inheritedGranted = (key: string) => roleSources(effective.data, key).length > 0;

  const counts = useMemo(() => {
    if (isUser) {
      const eff = new Map(effective.data?.keys.map(k => [k.key, k.granted]) ?? []);
      return countsFor(tabs, k => isTenantAdmin || !!eff.get(k));
    }
    const granted = new Set((set.data?.grants ?? []).filter(g => g.effect === 'allow').map(g => g.key));
    return countsFor(tabs, k => granted.has(k));
  }, [tabs, set.data, effective.data, isUser, isTenantAdmin]);

  const overrideCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (!isUser) return m;
    for (const tb of tabs) {
      const keys = new Set(tabKeys(tb));
      m.set(tb.key, (set.data?.grants ?? []).filter(g => keys.has(g.key)).length);
    }
    return m;
  }, [tabs, set.data, isUser]);

  function selectTab(key: string) {
    if (key === tab?.key) return;
    if (dirty) { setPendingTab(key); return; }
    setSelectedKey(key);
  }

  async function save(): Promise<boolean> {
    if (!tab || !draft) return false;
    setSaving(true);
    setError(null);
    try {
      const next: PermissionSetView = draft.kind === 'role'
        ? await permissionsApi.saveRoleTab(subject.id, tab.key, roleBody(tab, draft))
        : await permissionsApi.saveUserTab(subject.id, tab.key, userBody(draft));
      qc.setQueryData(qk.set(subject), next);
      void qc.invalidateQueries({ queryKey: ['permissions', 'effective'] });
      void reloadMe(); // permver bumped; refresh the signed-in user's own keys too
      toast.success(t('perm.saved', { tab: tab.label }));
      return true;
    } catch (e) {
      setError(isApiError(e) && e.is('FEATURE_NOT_IN_PLAN') ? t('perm.error.notInPlan') : (e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (registry.isLoading || set.isLoading) return <WorkbenchSkeleton />;
  if (registry.isError) return <InlineAlert>{(registry.error as Error).message}</InlineAlert>;
  if (set.isError) return <InlineAlert>{(set.error as Error).message}</InlineAlert>;
  if (!tabs.length || !tab || !draft) return <EmptyState icon={<ShieldOff />} title={t('perm.noTabs')} description={t('perm.noTabsHint')} />;

  const editable = !readOnly && !(isUser && isTenantAdmin);

  return (
    <div className="grid min-h-[32rem] overflow-hidden rounded-lg border border-border bg-surface md:grid-cols-[17rem_minmax(0,1fr)]" data-testid="perm-workbench">
      <TabList
        tabs={tabs}
        query={query}
        onQuery={setQuery}
        selected={tab.key}
        onSelect={selectTab}
        counts={counts}
        overrideCounts={overrideCounts}
        dirtyKey={dirty ? tab.key : null}
      />

      <section aria-labelledby="perm-tab-title" className="flex min-w-0 flex-col" role="tabpanel" id="perm-tabpanel">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface/95 px-4 py-3 backdrop-blur sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 id="perm-tab-title" className="truncate text-md font-semibold">{tab.label}</h2>
            <p className="text-sm text-fg-muted">
              {tab.group}
              {tab.scoped && <> <span aria-hidden>/</span> {t('perm.scopedTab')}</>}
            </p>
          </div>
          {editable && (
            <div className="flex items-center gap-2">
              {dirty && <span className="text-sm text-warning" role="status">{t('perm.unsaved')}</span>}
              <Button variant="ghost" size="sm" onClick={() => setDraft(baseline)} disabled={!dirty || saving} data-testid="perm-revert"><RotateCcw aria-hidden />{t('perm.revert')}</Button>
              <Button size="sm" onClick={() => void save()} disabled={!dirty} loading={saving} data-testid="perm-save">{t('perm.saveTab')}</Button>
            </div>
          )}
        </header>

        <div className="flex-1 space-y-6 px-4 py-4 sm:px-5">
          {readOnly && readOnlyReason && <InlineAlert tone="info">{readOnlyReason}</InlineAlert>}
          {isUser && isTenantAdmin && <InlineAlert tone="info" data-testid="perm-admin-note">{t('perm.user.adminNote')}</InlineAlert>}
          {error && <InlineAlert data-testid="perm-error">{error}</InlineAlert>}

          {draft.kind === 'role' ? (
            <RoleTabEditor tab={tab} draft={draft} onChange={setDraft} disabled={!editable} />
          ) : (
            <UserTabEditor
              tab={tab}
              draft={draft}
              onChange={setDraft}
              disabled={!editable}
              effective={effective.data}
              effectiveLoading={effective.isLoading}
              isTenantAdmin={isTenantAdmin}
              inheritedGranted={inheritedGranted}
              roleFieldModes={(formKey, fieldKey) => {
                const out: { role: string; mode: RoleFieldMode }[] = [];
                roleSets.forEach((q, i) => {
                  const m = q.data?.fieldAccess.find(f => f.formKey === formKey && f.fieldKey === fieldKey);
                  if (m && m.mode !== 'editable') out.push({ role: userRoles[i]!.name, mode: m.mode });
                });
                return out;
              }}
            />
          )}
        </div>
      </section>

      <Dialog open={!!pendingTab} onOpenChange={o => { if (!o) setPendingTab(null); }}>
        <DialogContent
          title={t('perm.dirty.title')}
          description={t('perm.dirty.body', { tab: tab.label })}
          size="sm"
          closeLabel={t('common.close')}
          data-testid="perm-dirty-dialog"
          footer={<>
            <Button variant="secondary" onClick={() => setPendingTab(null)}>{t('perm.dirty.stay')}</Button>
            <Button variant="danger-outline" onClick={() => { const k = pendingTab; setPendingTab(null); setDraft(baseline); setSelectedKey(k); }} data-testid="perm-dirty-discard">{t('perm.dirty.discard')}</Button>
            <Button loading={saving} onClick={async () => { const k = pendingTab; if (await save()) { setPendingTab(null); setSelectedKey(k); } else setPendingTab(null); }} data-testid="perm-dirty-save">{t('perm.dirty.save')}</Button>
          </>}
        >
          <p className="text-fg-muted">{t('perm.dirty.hint')}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorkbenchSkeleton() {
  return (
    <SkeletonGroup label={t('common.loading')} className="grid min-h-[28rem] gap-0 overflow-hidden rounded-lg border border-border md:grid-cols-[17rem_1fr]">
      <div className="space-y-2 border-b border-border p-3 md:border-b-0 md:border-r">
        <Skeleton className="h-9" />
        {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-8" />)}
      </div>
      <div className="space-y-3 p-5">
        <Skeleton className="h-6 w-40" />
        {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-9" />)}
      </div>
    </SkeletonGroup>
  );
}

// ------------------------------------------------------------------------------------------------ tab list

function TabList({ tabs, query, onQuery, selected, onSelect, counts, overrideCounts, dirtyKey }: {
  tabs: RegistryTab[];
  query: string;
  onQuery: (q: string) => void;
  selected: string;
  onSelect: (key: string) => void;
  counts: Map<string, { granted: number; total: number }>;
  overrideCounts: Map<string, number>;
  dirtyKey: string | null;
}) {
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? tabs.filter(tb => tb.label.toLowerCase().includes(needle) || tb.key.includes(needle) || tb.actions.some(a => a.label.toLowerCase().includes(needle)))
    : tabs;
  const groups = groupTabs(filtered);
  const order = groups.flatMap(([, list]) => list.map(tb => tb.key));
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [focus, setFocus] = useState<string | null>(null);
  const tabStop = order.includes(focus ?? '') ? focus : order.includes(selected) ? selected : order[0];

  const onKey = (e: KeyboardEvent, key: string) => {
    const i = order.indexOf(key);
    let next: string | undefined;
    if (e.key === 'ArrowDown') next = order[i + 1];
    else if (e.key === 'ArrowUp') next = order[i - 1];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    if (next) { e.preventDefault(); setFocus(next); refs.current.get(next)?.focus(); }
  };

  return (
    <div className="flex min-h-0 flex-col border-b border-border bg-subtle/60 md:border-b-0 md:border-r">
      <div className="p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input type="search" value={query} onChange={e => onQuery(e.target.value)} placeholder={t('perm.searchTabs')} aria-label={t('perm.searchTabs')} className="pl-8" data-testid="perm-tab-search" />
        </div>
      </div>

      {/* Mobile: a select instead of the list. */}
      <div className="px-3 pb-3 md:hidden">
        <NativeSelect value={selected} onChange={e => onSelect(e.target.value)} aria-label={t('perm.tab')} data-testid="perm-tab-select">
          {groups.map(([g, list]) => (
            <optgroup key={g} label={g}>
              {list.map(tb => {
                const c = counts.get(tb.key);
                return <option key={tb.key} value={tb.key}>{tb.label} ({c?.granted ?? 0}/{c?.total ?? 0})</option>;
              })}
            </optgroup>
          ))}
        </NativeSelect>
      </div>

      <div role="tablist" aria-orientation="vertical" aria-label={t('perm.tabs')} className="hidden flex-1 overflow-y-auto px-2 pb-3 md:block" data-testid="perm-tab-list">
        {!groups.length && <p className="px-2 py-4 text-sm text-fg-muted">{t('perm.noTabMatch')}</p>}
        {groups.map(([g, list]) => (
          <div key={g} role="presentation" className="mb-3">
            <p className="px-2 pb-1 pt-2 text-xs font-medium text-fg-subtle" role="presentation">{g}</p>
            {list.map(tb => {
              const c = counts.get(tb.key) ?? { granted: 0, total: 0 };
              const active = tb.key === selected;
              const ov = overrideCounts.get(tb.key) ?? 0;
              return (
                <button
                  key={tb.key}
                  ref={el => { if (el) refs.current.set(tb.key, el); else refs.current.delete(tb.key); }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls="perm-tabpanel"
                  tabIndex={tabStop === tb.key ? 0 : -1}
                  onKeyDown={e => onKey(e, tb.key)}
                  onFocus={() => setFocus(tb.key)}
                  onClick={() => onSelect(tb.key)}
                  data-testid={`perm-tab-${tb.key}`}
                  data-granted={c.granted}
                  className={cn(
                    'flex h-9 w-full items-center gap-2 rounded px-2 text-left text-base outline-none transition-colors',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    active ? 'bg-surface font-medium text-fg shadow-sm ring-1 ring-border' : 'text-fg-muted hover:bg-muted hover:text-fg',
                  )}
                >
                  <GrantDot granted={c.granted} total={c.total} />
                  <span className="min-w-0 flex-1 truncate">{tb.label}</span>
                  {dirtyKey === tb.key && <span className="size-1.5 rounded-full bg-warning" aria-label={t('perm.unsaved')} />}
                  {ov > 0 && <span className="rounded-sm bg-accent-soft px-1 text-[11px] font-semibold text-accent" title={t('perm.user.overrideCount', { count: ov })}>{ov}</span>}
                  <span className="tabular text-xs text-fg-subtle" aria-label={t('perm.countLabel', { granted: c.granted, total: c.total })}>{c.granted}/{c.total}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ring that fills with the share of granted keys: empty = none, full disc = all. */
function GrantDot({ granted, total }: { granted: number; total: number }) {
  const pct = total ? granted / total : 0;
  const r = 5, cfull = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0 -rotate-90" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2.5" className="stroke-border-strong" />
      {pct > 0 && <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2.5" className="stroke-accent" strokeDasharray={`${cfull * pct} ${cfull}`} />}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ shared bits

function Section({ title, hint, actions, children, testId }: { title: string; hint?: string; actions?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} aria-label={title}>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="font-semibold">{title}</h3>
          {hint && <p className="text-sm text-fg-muted">{hint}</p>}
        </div>
        {actions}
      </div>
      <div className="divide-y divide-border rounded border border-border">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ role editor

function RoleTabEditor({ tab, draft, onChange, disabled }: { tab: RegistryTab; draft: RoleDraft; onChange: (d: Draft) => void; disabled: boolean }) {
  const toggle = (key: string, on: boolean) => {
    const granted = new Set(draft.granted);
    if (on) granted.add(key); else granted.delete(key);
    onChange({ ...draft, granted });
  };
  const setMany = (keys: string[], on: boolean) => {
    const granted = new Set(draft.granted);
    keys.forEach(k => (on ? granted.add(k) : granted.delete(k)));
    onChange({ ...draft, granted });
  };
  const setField = (id: string, mode: 'visible' | RoleFieldMode) => {
    const fields = new Map(draft.fields);
    if (mode === 'visible') fields.delete(id); else fields.set(id, mode);
    onChange({ ...draft, fields });
  };

  const actions = tab.actions.map(a => ({ ...a, full: actionKey(tab, a.key) }));
  const views = tab.views.map(v => ({ ...v, full: viewKey(tab, v.key) }));

  return (
    <>
      <CheckList title={t('perm.buttons')} hint={t('perm.buttonsHint')} items={actions} granted={draft.granted} onToggle={toggle} onAll={setMany} disabled={disabled} testId="perm-actions" />
      {views.length > 0 && <CheckList title={t('perm.views')} hint={t('perm.viewsHint')} items={views} granted={draft.granted} onToggle={toggle} onAll={setMany} disabled={disabled} testId="perm-views" />}
      {tab.forms.map(form => (
        <Section key={form.formKey} title={t('perm.fields', { form: form.label })} hint={t('perm.fieldsHint')} testId={`perm-form-${form.formKey}`}>
          {form.fields.map(f => {
            const id = fieldId(form.formKey, f.key);
            const mode = draft.fields.get(id) ?? 'visible';
            return (
              <div key={f.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0">
                  {f.label}
                  {f.system && <Badge className="ml-2">{t('perm.systemField')}</Badge>}
                </span>
                <Segmented
                  label={t('perm.fieldAccessFor', { field: f.label })}
                  value={mode}
                  onChange={m => setField(id, m)}
                  disabled={disabled}
                  data-testid={`field-${form.formKey}-${f.key}`}
                  options={[
                    { value: 'visible', label: t('perm.field.visible') },
                    { value: 'readonly', label: t('perm.field.readonly'), tone: 'warning' },
                    { value: 'hidden', label: t('perm.field.hidden'), tone: 'danger' },
                  ]}
                />
              </div>
            );
          })}
        </Section>
      ))}
    </>
  );
}

function CheckList({ title, hint, items, granted, onToggle, onAll, disabled, testId }: {
  title: string;
  hint: string;
  items: { full: string; label: string; description?: string }[];
  granted: Set<string>;
  onToggle: (key: string, on: boolean) => void;
  onAll: (keys: string[], on: boolean) => void;
  disabled: boolean;
  testId: string;
}) {
  const n = items.filter(i => granted.has(i.full)).length;
  const all = n === items.length && n > 0;
  const state: boolean | 'indeterminate' = all ? true : n > 0 ? 'indeterminate' : false;
  return (
    <Section
      title={title}
      hint={hint}
      testId={testId}
      actions={items.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <Checkbox checked={state} onCheckedChange={v => onAll(items.map(i => i.full), v === true)} disabled={disabled} data-testid={`${testId}-all`} />
          {t('perm.selectAll')} <span className="tabular">({n}/{items.length})</span>
        </label>
      )}
    >
      {items.length === 0 && <p className="px-3 py-2.5 text-sm text-fg-muted">{t('perm.none')}</p>}
      {items.map(i => (
        <label key={i.full} className={cn('flex items-start gap-3 px-3 py-2.5', !disabled && 'cursor-pointer hover:bg-subtle')}>
          <Checkbox className="mt-0.5" checked={granted.has(i.full)} onCheckedChange={v => onToggle(i.full, v === true)} disabled={disabled} data-testid={`perm-${i.full}`} />
          <span className="min-w-0">
            <span className="block">{i.label}</span>
            {i.description && <span className="block text-sm text-fg-muted">{i.description}</span>}
          </span>
        </label>
      ))}
    </Section>
  );
}

// ------------------------------------------------------------------------------------------------ user editor

function UserTabEditor({ tab, draft, onChange, disabled, effective, effectiveLoading, isTenantAdmin, inheritedGranted, roleFieldModes }: {
  tab: RegistryTab;
  draft: UserDraft;
  onChange: (d: Draft) => void;
  disabled: boolean;
  effective: EffectivePermissions | undefined;
  effectiveLoading: boolean;
  isTenantAdmin: boolean;
  inheritedGranted: (key: string) => boolean;
  roleFieldModes: (formKey: string, fieldKey: string) => { role: string; mode: RoleFieldMode }[];
}) {
  const setOverride = (key: string, v: 'inherit' | 'allow' | 'deny') => {
    const overrides = new Map(draft.overrides);
    if (v === 'inherit') overrides.delete(key); else overrides.set(key, v);
    onChange({ ...draft, overrides });
  };
  const setField = (id: string, mode: 'inherit' | UserFieldMode) => {
    const fields = new Map(draft.fields);
    if (mode === 'inherit') fields.delete(id); else fields.set(id, mode);
    onChange({ ...draft, fields });
  };
  const clearAll = (keys: string[]) => {
    const overrides = new Map(draft.overrides);
    keys.forEach(k => overrides.delete(k));
    onChange({ ...draft, overrides });
  };

  const rows = (list: { key: string; label: string; description?: string }[], toKey: (k: string) => string) =>
    list.map(a => ({ ...a, full: toKey(a.key) }));
  const actions = rows(tab.actions, k => actionKey(tab, k));
  const views = rows(tab.views, k => viewKey(tab, k));

  const block = (title: string, hint: string, items: typeof actions, testId: string) => (
    <Section
      title={title}
      hint={hint}
      testId={testId}
      actions={items.some(i => draft.overrides.has(i.full)) && !disabled && (
        <Button size="sm" variant="ghost" onClick={() => clearAll(items.map(i => i.full))}><X aria-hidden />{t('perm.user.clearOverrides')}</Button>
      )}
    >
      {items.length === 0 && <p className="px-3 py-2.5 text-sm text-fg-muted">{t('perm.none')}</p>}
      {items.map(i => {
        const roles = roleSources(effective, i.full);
        const inherited = inheritedGranted(i.full);
        const ov = draft.overrides.get(i.full);
        const result = effectiveFor(inherited, ov, isTenantAdmin);
        return (
          <div key={i.full} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]" data-testid={`perm-${i.full}`} data-effective={result}>
            <ResultMark on={result} />
            <div className="min-w-0">
              <p>{i.label}</p>
              <p className="text-sm text-fg-muted">
                {effectiveLoading ? <Skeleton className="inline-block h-3 w-24 align-middle" /> : roles.length
                  ? <span data-testid={`perm-${i.full}-inherited`}><Check className="mr-1 inline size-3.5 text-success" aria-hidden />{t('perm.user.fromRoles', { roles: roles.join(', ') })}</span>
                  : t('perm.user.notFromRoles')}
              </p>
            </div>
            <Segmented
              className="col-span-2 justify-self-start sm:col-span-1 sm:justify-self-end"
              label={t('perm.user.overrideFor', { name: i.label })}
              value={ov ?? 'inherit'}
              onChange={v => setOverride(i.full, v)}
              disabled={disabled}
              data-testid={`perm-${i.full}-override`}
              options={[
                { value: 'inherit', label: t('perm.user.inherit') },
                { value: 'allow', label: t('perm.user.allow'), tone: 'success' },
                { value: 'deny', label: t('perm.user.deny'), tone: 'danger' },
              ]}
            />
          </div>
        );
      })}
    </Section>
  );

  return (
    <>
      {block(t('perm.buttons'), t('perm.user.buttonsHint'), actions, 'perm-actions')}
      {views.length > 0 && block(t('perm.views'), t('perm.user.viewsHint'), views, 'perm-views')}
      {tab.forms.map(form => (
        <Section key={form.formKey} title={t('perm.fields', { form: form.label })} hint={t('perm.user.fieldsHint')} testId={`perm-form-${form.formKey}`}>
          {form.fields.map(f => {
            const id = fieldId(form.formKey, f.key);
            const mode = draft.fields.get(id) ?? 'inherit';
            const fromRoles = roleFieldModes(form.formKey, f.key);
            return (
              <div key={f.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p>{f.label}{f.system && <Badge className="ml-2">{t('perm.systemField')}</Badge>}</p>
                  <p className="text-sm text-fg-muted">
                    {fromRoles.length
                      ? fromRoles.map(r => `${r.role}: ${t(r.mode === 'hidden' ? 'perm.field.hidden' : 'perm.field.readonly')}`).join(', ')
                      : t('perm.user.fieldRoleVisible')}
                  </p>
                </div>
                <Segmented
                  label={t('perm.fieldAccessFor', { field: f.label })}
                  value={mode}
                  onChange={m => setField(id, m)}
                  disabled={disabled}
                  data-testid={`field-${form.formKey}-${f.key}`}
                  options={[
                    { value: 'inherit', label: t('perm.user.asRole') },
                    { value: 'editable', label: t('perm.field.editable'), tone: 'success', title: t('perm.field.editableHint') },
                    { value: 'readonly', label: t('perm.field.readonly'), tone: 'warning' },
                    { value: 'hidden', label: t('perm.field.hidden'), tone: 'danger' },
                  ]}
                />
              </div>
            );
          })}
        </Section>
      ))}
    </>
  );
}

function ResultMark({ on }: { on: boolean }) {
  return on ? (
    <span className="grid size-5 place-items-center rounded-full bg-success-soft text-success" title={t('perm.user.granted')}>
      <Check className="size-3.5" strokeWidth={3} aria-hidden /><span className="sr-only">{t('perm.user.granted')}</span>
    </span>
  ) : (
    <span className="grid size-5 place-items-center rounded-full bg-muted text-fg-subtle" title={t('perm.user.notGranted')}>
      <Minus className="size-3.5" strokeWidth={3} aria-hidden /><span className="sr-only">{t('perm.user.notGranted')}</span>
    </span>
  );
}
