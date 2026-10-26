'use client';
import { Badge, Card, CardBody, CardHeader, cn, Input, Skeleton, SkeletonGroup } from '@procure/ui';
import { Search, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import en from '@/i18n/en.json';

const DEFAULTS = en as Record<string, string>;
const ALL_KEYS = Object.keys(DEFAULTS);
/** Keys shown before searching: the words people rename most (navigation and module names). */
const FEATURED = ALL_KEYS.filter(k => k.startsWith('nav.') && !k.startsWith('nav.section') && !['nav.primary', 'nav.sidebar', 'nav.menu', 'nav.open', 'nav.tenants', 'nav.plans', 'nav.platformUsage', 'nav.audit'].includes(k));
const PREVIEW_KEYS = ['nav.dashboard', 'nav.indent', 'nav.purchase', 'nav.grn', 'nav.store', 'nav.users', 'nav.locations'].filter(k => k in DEFAULTS);
const SAMPLE: Record<string, string> = { name: 'Asha', count: '3', tenant: 'Acme', email: 'asha@acme.test', level: 'Store', tab: 'Users' };
const fill = (s: string) => s.replace(/\{(\w+)\}/g, (m, v: string) => SAMPLE[v] ?? m);

/** Tenant wording overrides for i18n keys: search keys, set your own wording, see a preview. */
export function LabelsEditor({ saved, loading, loadError, draft, onChange, disabled }: {
  saved: Record<string, string>;
  loading: boolean;
  loadError: string | null;
  draft: Record<string, string | null>;
  onChange: (d: Record<string, string | null>) => void;
  disabled: boolean;
}) {
  const [q, setQ] = useState('');
  const [onlyOverridden, setOnlyOverridden] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const current = (k: string) => (k in draft ? draft[k] ?? '' : saved[k] ?? '');
  const effective = (k: string) => current(k).trim() || DEFAULTS[k] || k;

  const keys = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const overridden = new Set([...Object.keys(saved), ...Object.keys(draft).filter(k => draft[k])]);
    let list = onlyOverridden ? ALL_KEYS.filter(k => overridden.has(k)) : needle ? ALL_KEYS : [...new Set([...ALL_KEYS.filter(k => overridden.has(k)), ...FEATURED])];
    if (needle) list = list.filter(k => k.toLowerCase().includes(needle) || DEFAULTS[k]!.toLowerCase().includes(needle) || (saved[k] ?? '').toLowerCase().includes(needle));
    return list;
  }, [q, onlyOverridden, saved, draft]);
  const shown = keys.slice(0, 60);
  const overriddenCount = Object.keys(saved).length;

  return (
    <Card data-testid="labels-editor">
      <CardHeader title={t('settings.labels.title')} description={t('settings.labels.hint')} />
      <CardBody className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0 space-y-3">
          {loadError && <InlineAlert>{loadError}</InlineAlert>}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder={t('settings.labels.search')} aria-label={t('settings.labels.search')} className="pl-8" data-testid="labels-search" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[rgb(var(--c-accent))]" checked={onlyOverridden} onChange={e => setOnlyOverridden(e.target.checked)} data-testid="labels-only-overridden" />
              {t('settings.labels.onlyChanged', { count: overriddenCount })}
            </label>
          </div>
          {loading ? (
            <SkeletonGroup className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-12" />)}</SkeletonGroup>
          ) : !shown.length ? (
            <p className="py-6 text-center text-fg-muted">{t('settings.labels.noMatch')}</p>
          ) : (
            <ul className="divide-y divide-border rounded border border-border">
              {shown.map(k => {
                const val = current(k);
                const isSet = !!val.trim();
                const pending = k in draft && (saved[k] ?? '') !== (draft[k] ?? '');
                return (
                  <li key={k} className={cn('grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center', focusKey === k && 'bg-subtle')} data-testid={`label-row-${k}`}>
                    <div className="min-w-0">
                      <p className="truncate">{DEFAULTS[k]}</p>
                      <p className="truncate font-mono text-xs text-fg-subtle">{k}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        value={val}
                        placeholder={t('settings.labels.placeholder')}
                        onChange={e => onChange({ ...draft, [k]: e.target.value })}
                        onFocus={() => setFocusKey(k)}
                        disabled={disabled}
                        maxLength={200}
                        aria-label={t('settings.labels.inputFor', { text: DEFAULTS[k]! })}
                        className={cn(isSet && 'border-accent/60')}
                        data-testid={`label-input-${k}`}
                      />
                      {isSet && !disabled && (
                        <button type="button" onClick={() => onChange({ ...draft, [k]: null })} className="rounded p-1.5 text-fg-subtle hover:bg-muted hover:text-fg" aria-label={t('settings.labels.useDefault', { text: DEFAULTS[k]! })} title={t('settings.labels.useDefaultShort')}>
                          <Undo2 className="size-4" aria-hidden />
                        </button>
                      )}
                      {pending && <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label={t('perm.unsaved')} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {keys.length > shown.length && <p className="text-sm text-fg-muted">{t('settings.labels.more', { count: keys.length - shown.length })}</p>}
        </div>

        <aside aria-label={t('settings.labels.preview')} className="space-y-3 lg:sticky lg:top-24 lg:self-start" data-testid="labels-preview">
          <p className="text-sm font-medium">{t('settings.labels.preview')}</p>
          <div className="rounded-lg border border-border bg-subtle p-2">
            <ul className="space-y-0.5">
              {PREVIEW_KEYS.map(k => (
                <li key={k} className={cn('truncate rounded px-2.5 py-1.5 text-sm', k === focusKey ? 'bg-accent-soft font-medium text-accent' : 'text-fg-muted')}>{effective(k)}</li>
              ))}
            </ul>
          </div>
          {focusKey && !PREVIEW_KEYS.includes(focusKey) && (
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-fg-subtle">{t('settings.labels.previewAs')}</p>
              <p className="mt-1 break-words">{fill(effective(focusKey))}</p>
            </div>
          )}
          {focusKey && current(focusKey).trim() && <Badge tone="accent">{t('settings.labels.overridden')}</Badge>}
        </aside>
      </CardBody>
    </Card>
  );
}
