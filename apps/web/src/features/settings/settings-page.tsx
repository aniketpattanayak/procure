'use client';
import { SettingsRegistry, type SettingRow } from '@procure/schema';
import { Button, Card, CardBody, CardHeader, cn, Input, NativeSelect, Skeleton, SkeletonGroup, Switch, Tabs, TabsContent, TabsList, TabsTrigger, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { t, type MessageKey } from '@/i18n';
import { perm, usePermissions } from '@/lib/permissions';
import { useSession } from '@/lib/session';
import { settingsApi, settingsKeys } from './api';
import { LabelsEditor } from './labels-editor';
import { LevelsEditor } from './levels-editor';

type GroupId = 'security' | 'flow' | 'procurement' | 'stock' | 'labels' | 'other';
const GROUPS: { id: GroupId; label: MessageKey; hint: MessageKey; match: (k: string) => boolean }[] = [
  { id: 'security', label: 'settings.group.security', hint: 'settings.group.securityHint', match: k => k.startsWith('security.') },
  { id: 'flow', label: 'settings.group.flow', hint: 'settings.group.flowHint', match: k => k.startsWith('flow.') },
  { id: 'procurement', label: 'settings.group.procurement', hint: 'settings.group.procurementHint', match: k => ['selection.', 'grn.', 'po.', 'indent.', 'procurement.', 'rtv.'].some(p => k.startsWith(p)) },
  { id: 'stock', label: 'settings.group.stock', hint: 'settings.group.stockHint', match: k => k.startsWith('stock.') },
  { id: 'labels', label: 'settings.group.labels', hint: 'settings.group.labelsHint', match: k => k.startsWith('labels.') },
];
const groupOf = (key: string): GroupId => GROUPS.find(g => g.match(key))?.id ?? 'other';
const LEVELS_KEY = 'labels.location_levels';

type Kind =
  | { type: 'boolean' }
  | { type: 'number'; min?: number; max?: number; int: boolean }
  | { type: 'enum'; options: string[] }
  | { type: 'strings' }
  | { type: 'string'; min?: number; max?: number }
  | { type: 'json' };

type ZodDef = { typeName?: string; minValue?: number | null; maxValue?: number | null; isInt?: boolean; options?: string[]; minLength?: number | null; maxLength?: number | null; innerType?: { _def: ZodDef }; schema?: { _def: ZodDef } };

/** Unwrap ZodDefault / ZodOptional / ZodNullable to reach the real inner type. */
function unwrapDef(def: ZodDef | undefined): ZodDef | undefined {
  if (!def) return undefined;
  if (def.typeName === 'ZodDefault' || def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
    return unwrapDef(def.innerType?._def ?? def.schema?._def);
  }
  return def;
}

/** Control type from the shared registry schema (falls back to the default's JS type for unknown keys). */
function kindOf(row: SettingRow): Kind {
  const reg = (SettingsRegistry as Record<string, { schema: { _def: ZodDef; minValue?: number | null; maxValue?: number | null; isInt?: boolean; options?: string[]; minLength?: number | null; maxLength?: number | null } }>)[row.key];
  const s = unwrapDef(reg?.schema?._def) ?? reg?.schema;
  switch (s?.typeName) {
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodNumber': return { type: 'number', min: s.minValue ?? undefined, max: s.maxValue ?? undefined, int: !!s.isInt };
    case 'ZodEnum': return { type: 'enum', options: s.options ?? [] };
    case 'ZodArray': return { type: 'strings' };
    case 'ZodString': return { type: 'string', min: s.minLength ?? undefined, max: s.maxLength ?? undefined };
  }
  const d = row.default ?? row.value;
  if (typeof d === 'boolean') return { type: 'boolean' };
  if (typeof d === 'number') return { type: 'number', int: Number.isInteger(d) };
  if (typeof d === 'string') return { type: 'string' };
  if (Array.isArray(d)) return { type: 'strings' };
  return { type: 'json' };
}

function validate(key: string, value: unknown): string | null {
  const reg = (SettingsRegistry as Record<string, { schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } } }>)[key];
  if (!reg) return null;
  const r = reg.schema.safeParse(value);
  return r.success ? null : r.error?.issues[0]?.message ?? t('settings.invalid');
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function display(v: unknown, kind: Kind): string {
  if (kind.type === 'boolean') return v ? t('settings.on') : t('settings.off');
  if (kind.type === 'enum') return t(`settings.enum.${String(v)}` as MessageKey) === `settings.enum.${String(v)}` ? String(v) : t(`settings.enum.${String(v)}` as MessageKey);
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export function SettingsPage() {
  const qc = useQueryClient();
  const { reloadMe } = useSession();
  const p = usePermissions();
  const canEdit = p.has(perm.action('admin.settings', 'edit'));
  const settings = useQuery({ queryKey: settingsKeys.list, queryFn: settingsApi.list });
  const labels = useQuery({ queryKey: settingsKeys.labels('en'), queryFn: () => settingsApi.labels('en') });

  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [labelDraft, setLabelDraft] = useState<Record<string, string | null>>({});
  const [tab, setTab] = useState<GroupId>('security');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft({}); }, [settings.data]);
  useEffect(() => { setLabelDraft({}); }, [labels.data]);

  const rows = settings.data ?? [];
  const byGroup = useMemo(() => {
    const m = new Map<GroupId, SettingRow[]>();
    for (const r of rows) { const g = groupOf(r.key); m.set(g, [...(m.get(g) ?? []), r]); }
    return m;
  }, [rows]);

  const valueOf = (r: SettingRow) => (r.key in draft ? draft[r.key] : r.value);
  const changed = rows.filter(r => r.key in draft && !same(draft[r.key], r.value));
  const errors = Object.fromEntries(changed.map(r => [r.key, validate(r.key, draft[r.key])]).filter(([, e]) => e)) as Record<string, string>;
  const labelChanges = Object.entries(labelDraft).filter(([k, v]) => (labels.data?.[k] ?? null) !== (v || null));
  const dirtyCount = changed.length + labelChanges.length;
  const dirtyGroups = new Set(changed.map(r => groupOf(r.key)));
  if (labelChanges.length) dirtyGroups.add('labels');

  useEffect(() => {
    if (!dirtyCount) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirtyCount]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (changed.length) {
        // A value equal to the default is sent as null, which resets the key (it then follows future default changes).
        const patch = Object.fromEntries(changed.map(r => [r.key, same(draft[r.key], r.default) ? null : draft[r.key]]));
        qc.setQueryData(settingsKeys.list, await settingsApi.save(patch));
      }
      if (labelChanges.length) {
        qc.setQueryData(settingsKeys.labels('en'), await settingsApi.saveLabels(Object.fromEntries(labelChanges.map(([k, v]) => [k, v || null])), 'en'));
      }
      await reloadMe(); // labels + location level names + flow flags come from /auth/me
      void qc.invalidateQueries({ queryKey: ['locations'] });
      void qc.invalidateQueries({ queryKey: ['permissions', 'registry'] });
      toast.success(t('settings.saved'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const discard = () => { setDraft({}); setLabelDraft({}); setError(null); };
  const set = (key: string, v: unknown) => setDraft(d => ({ ...d, [key]: v }));
  const groups = [...GROUPS.filter(g => g.id === 'labels' || byGroup.has(g.id)), ...(byGroup.has('other') ? [{ id: 'other' as const, label: 'settings.group.other' as MessageKey, hint: 'settings.group.otherHint' as MessageKey, match: () => false }] : [])];

  return (
    <PageBody className="max-w-4xl pb-24">
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      {settings.isLoading ? (
        <SkeletonGroup label={t('common.loading')} className="space-y-4">
          <Skeleton className="h-9 w-full max-w-md" />
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-16" />)}
        </SkeletonGroup>
      ) : settings.isError ? (
        <InlineAlert>{(settings.error as Error).message}</InlineAlert>
      ) : (
        <Tabs value={tab} onValueChange={v => setTab(v as GroupId)}>
          <TabsList aria-label={t('settings.groups')}>
            {groups.map(g => (
              <TabsTrigger key={g.id} value={g.id} data-testid={`settings-tab-${g.id}`}>
                {t(g.label)}
                {dirtyGroups.has(g.id) && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-warning align-middle" aria-label={t('perm.unsaved')} />}
              </TabsTrigger>
            ))}
          </TabsList>
          {groups.map(g => (
            <TabsContent key={g.id} value={g.id} className="space-y-4">
              {g.id !== 'labels' || (byGroup.get('labels') ?? []).some(r => r.key !== LEVELS_KEY) ? (
                <Card>
                  <CardHeader title={t(g.label)} description={t(g.hint)} />
                  <CardBody className="divide-y divide-border py-0">
                    {(byGroup.get(g.id) ?? []).filter(r => r.key !== LEVELS_KEY).map(r => (
                      <SettingControl key={r.key} row={r} value={valueOf(r)} onChange={v => set(r.key, v)} disabled={!canEdit} error={errors[r.key]} />
                    ))}
                  </CardBody>
                </Card>
              ) : null}
              {g.id === 'labels' && (
                <>
                  {rows.some(r => r.key === LEVELS_KEY) && (() => {
                    const r = rows.find(x => x.key === LEVELS_KEY)!;
                    return (
                      <LevelsEditor
                        value={(valueOf(r) as string[]) ?? []}
                        defaultValue={(r.default as string[]) ?? []}
                        onChange={v => set(LEVELS_KEY, v)}
                        disabled={!canEdit}
                        error={errors[LEVELS_KEY]}
                      />
                    );
                  })()}
                  <LabelsEditor
                    saved={labels.data ?? {}}
                    loading={labels.isLoading}
                    loadError={labels.isError ? (labels.error as Error).message : null}
                    draft={labelDraft}
                    onChange={setLabelDraft}
                    disabled={!canEdit}
                  />
                </>
              )}
            </TabsContent>
          ))}
        </Tabs>
      )}

      {dirtyCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 px-4 py-3 shadow-pop backdrop-blur lg:left-sidebar" role="region" aria-label={t('settings.saveBar')} data-testid="settings-savebar">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3">
            <p className="flex-1 text-sm" role="status">{t('settings.unsavedCount', { count: dirtyCount })}</p>
            {error && <p className="w-full text-sm text-danger sm:order-none sm:w-auto" role="alert">{error}</p>}
            <Button variant="secondary" onClick={discard} disabled={saving} data-testid="settings-discard">{t('settings.discard')}</Button>
            <Button onClick={() => void save()} loading={saving} disabled={Object.keys(errors).length > 0} data-testid="settings-save">{t('common.saveChanges')}</Button>
          </div>
        </div>
      )}
    </PageBody>
  );
}

function SettingControl({ row, value, onChange, disabled, error }: { row: SettingRow; value: unknown; onChange: (v: unknown) => void; disabled: boolean; error?: string }) {
  const kind = kindOf(row);
  const isDefault = same(value, row.default);
  const id = `setting-${row.key.replace(/\./g, '-')}`;
  const helpKey = `settings.help.${row.key}` as MessageKey;
  const help = t(helpKey) === helpKey ? null : t(helpKey);

  let control: ReactNode;
  if (kind.type === 'boolean') {
    control = <Switch id={id} checked={!!value} onCheckedChange={onChange} disabled={disabled} data-testid={id} />;
  } else if (kind.type === 'number') {
    control = (
      <Input
        id={id}
        type="number"
        inputMode={kind.int ? 'numeric' : 'decimal'}
        className="w-28 text-right tabular"
        min={kind.min}
        max={kind.max}
        step={kind.int ? 1 : 'any'}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
        disabled={disabled}
        aria-invalid={!!error || undefined}
        aria-describedby={`${id}-meta`}
        data-testid={id}
      />
    );
  } else if (kind.type === 'enum') {
    control = (
      <NativeSelect id={id} className="w-44" value={String(value)} onChange={e => onChange(e.target.value)} disabled={disabled} data-testid={id}>
        {kind.options.map(o => <option key={o} value={o}>{display(o, kind)}</option>)}
      </NativeSelect>
    );
  } else if (kind.type === 'string') {
    const isLong = kind.max !== undefined && kind.max > 80;
    control = isLong ? (
      <textarea
        id={id}
        className="w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        rows={4}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={e => onChange(e.target.value === '' ? null : e.target.value)}
        minLength={kind.min}
        maxLength={kind.max}
        disabled={disabled}
        aria-invalid={!!error || undefined}
        aria-describedby={`${id}-meta`}
        data-testid={id}
      />
    ) : (
      <Input
        id={id}
        type="text"
        className="w-72 font-mono text-sm"
        value={value === null || value === undefined ? '' : String(value)}
        onChange={e => onChange(e.target.value === '' ? null : e.target.value)}
        minLength={kind.min}
        maxLength={kind.max}
        disabled={disabled}
        aria-invalid={!!error || undefined}
        aria-describedby={`${id}-meta`}
        data-testid={id}
      />
    );
  } else {
    control = <code className="text-sm">{JSON.stringify(value)}</code>;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5" data-testid={`setting-row-${row.key}`} data-default={isDefault}>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="font-medium">{row.label}</label>
        {help && <p className="text-sm text-fg-muted">{help}</p>}
        <p id={`${id}-meta`} className={cn('text-xs', error ? 'font-medium text-danger' : 'text-fg-subtle')} role={error ? 'alert' : undefined}>
          {error ?? (kind.type === 'number' && (kind.min !== undefined || kind.max !== undefined) ? t('settings.range', { min: kind.min ?? '−∞', max: kind.max ?? '∞', def: display(row.default, kind) }) : t('settings.default', { value: display(row.default, kind) }))}
        </p>
      </div>
      <div className={cn('flex items-center gap-1', kind.type === 'string' && (kind.max !== undefined && kind.max > 80) && 'w-full')}>
        {control}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(row.default)}
          disabled={disabled || isDefault}
          className={cn(isDefault && 'invisible')}
          aria-label={t('settings.resetFor', { name: row.label })}
          title={t('settings.reset')}
          data-testid={`${id}-reset`}
        >
          <RotateCcw aria-hidden />
        </Button>
      </div>
    </div>
  );
}
