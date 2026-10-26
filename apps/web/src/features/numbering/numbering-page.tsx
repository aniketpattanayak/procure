'use client';
import type { NumberingSeriesRow } from '@procure/schema';
import { Badge, Button, EmptyState, FormField, NativeSelect, Skeleton, SkeletonGroup, StatusBadge, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Hash, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useDocTypes } from '@/features/workflows/api';
import { numberingApi } from './api';
import { LocationPicker, locationPath, useLocationTree } from './location-picker';
import { SeriesDialog } from './series-dialog';

/** Which active series numbers a document at `locationId`: nearest series at the location or an ancestor, else the default. */
export function resolveSeries(series: NumberingSeriesRow[], locationId: string | null, parentOf: (id: string) => string | null): NumberingSeriesRow | null {
  const active = series.filter(s => s.isActive);
  for (let id = locationId; id; id = parentOf(id)) {
    const hit = active.find(s => s.locationNodeId === id);
    if (hit) return hit;
  }
  return active.find(s => s.locationNodeId === null) ?? null;
}

export function NumberingPage() {
  const p = usePermissions();
  const qc = useQueryClient();
  const canEdit = p.has('config.numbering:action.edit');
  const types = useDocTypes();
  const [docType, setDocType] = useState<string>('');
  useEffect(() => {
    if (docType || !types.data?.length) return;
    let want: string | null = null;
    try { want = new URLSearchParams(window.location.search).get('docType'); } catch { /* ignore */ }
    setDocType(types.data.find(d => d.key === want)?.key ?? types.data[0]!.key);
  }, [types.data, docType]);
  const dt = types.data?.find(d => d.key === docType);

  const list = useQuery({ queryKey: ['numbering', docType], queryFn: () => numberingApi.list(docType), enabled: !!docType });
  const { tree } = useLocationTree();
  const [dialog, setDialog] = useState<{ series: NumberingSeriesRow | null } | null>(null);
  const [probe, setProbe] = useState<string | null>(null);

  const rows = useMemo(() => [...(list.data ?? [])].sort((a, b) => Number(b.isActive) - Number(a.isActive) || Number(a.locationNodeId !== null) - Number(b.locationNodeId !== null) || a.name.localeCompare(b.name)), [list.data]);
  const parentOf = (id: string) => tree?.byId.get(id)?.node.parentId ?? null;
  const resolved = probe !== undefined && rows.length ? resolveSeries(rows, probe, parentOf) : null;
  const where = (s: NumberingSeriesRow) => {
    if (!s.locationNodeId) return t('num.coverDefault');
    const n = tree?.byId.get(s.locationNodeId)?.node;
    return t('num.coverLocation', { name: n ? locationPath(n) : s.locationName ?? '—' });
  };

  async function toggle(s: NumberingSeriesRow) {
    try {
      await numberingApi.update(s.id, { docTypeKey: s.docTypeKey, name: s.name, locationNodeId: s.locationNodeId, pattern: s.pattern, reset: s.reset, isActive: !s.isActive, version: s.version });
      void qc.invalidateQueries({ queryKey: ['numbering', docType] });
      toast.success(s.isActive ? t('num.deactivated', { name: s.name }) : t('num.activated', { name: s.name }));
    } catch (e) {
      toast.error(t('num.toggleFailed'), isApiError(e) ? e.message : undefined);
    }
  }

  return (
    <PageBody>
      <PageHeader title={t('num.title')} description={t('num.description')}
        actions={canEdit && docType && <Button onClick={() => setDialog({ series: null })} data-testid="numbering-add"><Plus aria-hidden />{t('num.add')}</Button>} />

      <div className="mb-4 max-w-xs">
        <FormField label={t('num.docType')}>
          <NativeSelect value={docType} onChange={e => { setDocType(e.target.value); setProbe(null); }} disabled={types.isLoading} data-testid="numbering-doctype">
            {types.isLoading && <option>{t('common.loading')}</option>}
            {(types.data ?? []).map(d => <option key={d.key} value={d.key}>{d.pluralName}</option>)}
          </NativeSelect>
        </FormField>
      </div>

      {!docType && !types.isLoading ? (
        <EmptyState icon={<Hash />} title={t('num.noDocTypes')} />
      ) : list.isLoading || !docType ? (
        <SkeletonGroup className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-14" />)}</SkeletonGroup>
      ) : list.error ? (
        <EmptyState title={t('table.error')} description={isApiError(list.error) ? list.error.message : undefined} action={<Button variant="secondary" onClick={() => void list.refetch()}>{t('common.retry')}</Button>} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            {!rows.length ? (
              <EmptyState icon={<Hash />} title={t('num.empty')} description={t('num.emptyHint')}
                action={canEdit ? <Button onClick={() => setDialog({ series: null })}>{t('num.add')}</Button> : undefined} />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border bg-surface">
                <table className="w-full min-w-[40rem]" data-testid="numbering-table">
                  <thead className="bg-subtle text-left text-sm text-fg-muted">
                    <tr>
                      <th className="min-w-52 px-4 py-2 font-medium">{t('num.col.series')}</th>
                      <th className="px-4 py-2 font-medium">{t('num.col.pattern')}</th>
                      <th className="px-4 py-2 font-medium">{t('num.col.next')}</th>
                      <th className="px-4 py-2 font-medium">{t('num.col.reset')}</th>
                      <th className="px-4 py-2"><span className="sr-only">{t('common.actions')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(s => (
                      <tr key={s.id} className="border-t border-border align-top" data-testid={`numbering-row-${s.id}`} data-name={s.name} data-active={s.isActive}>
                        <td className="px-4 py-2.5">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            {s.name}
                            {!s.isActive && <StatusBadge>{t('num.inactive')}</StatusBadge>}
                            {resolved?.id === s.id && <Badge tone="accent" data-testid="numbering-applies-badge">{t('num.appliesBadge')}</Badge>}
                          </p>
                          <p className="text-sm text-fg-muted">{where(s)}</p>
                        </td>
                        <td className="px-4 py-2.5"><code className="whitespace-nowrap font-mono text-sm">{s.pattern}</code></td>
                        <td className="px-4 py-2.5"><span className="whitespace-nowrap font-mono text-sm font-semibold" data-testid={`numbering-next-${s.id}`}>{s.preview}</span></td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-sm text-fg-muted">{t(`num.resetShort.${s.reset}` as 'num.resetShort.fy')}</td>
                        <td className="px-2 py-2">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setDialog({ series: s })} data-testid={`numbering-edit-${s.id}`}>{canEdit ? t('common.edit') : t('num.view')}</Button>
                            {canEdit && <Button size="sm" variant="ghost" onClick={() => void toggle(s)} data-testid={`numbering-toggle-${s.id}`}>{s.isActive ? t('num.deactivate') : t('num.activate')}</Button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <aside className="space-y-3 rounded-lg border border-border bg-surface p-4" aria-labelledby="num-rule" data-testid="numbering-rules">
            <h2 id="num-rule" className="font-semibold">{t('num.ruleTitle')}</h2>
            <p className="text-sm text-fg-muted">{t('num.ruleBody', { name: dt?.pluralName ?? '' })}</p>
            <FormField label={t('num.probe')}>
              <LocationPicker value={probe} onChange={setProbe} testId="numbering-resolve-location" allLabel={t('num.noLocation')} />
            </FormField>
            <p className="flex items-start gap-2 rounded bg-subtle px-3 py-2 text-sm" aria-live="polite" data-testid="numbering-resolve-result">
              <ArrowRight className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
              {resolved ? (
                <span>{t('num.resolvesTo', { name: resolved.name })} <code className="font-mono font-semibold">{resolved.preview}</code></span>
              ) : (
                <span className="text-warning">{t('num.resolvesNone')}</span>
              )}
            </p>
          </aside>
        </div>
      )}

      {dialog && docType && <SeriesDialog docType={docType} series={dialog.series} onClose={() => setDialog(null)} canEdit={canEdit} />}
    </PageBody>
  );
}
