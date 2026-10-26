'use client';
import type { NumberingSeriesRow } from '@procure/schema';
import { Button, Dialog, DialogContent, FormField, Input, NativeSelect, Switch, Label, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { numberingApi } from './api';
import { LocationPicker, useLocationTree } from './location-picker';
import { PatternEditor, patternProblem, useFyStartMonth } from './pattern';

const today = () => new Date().toISOString().slice(0, 10);

/** Add or edit a numbering series. The preview is computed live; for a saved series the server's next number is shown too. */
export function SeriesDialog({ docType, series, onClose, canEdit }: { docType: string; series: NumberingSeriesRow | null; onClose: () => void; canEdit: boolean }) {
  const qc = useQueryClient();
  const fy = useFyStartMonth();
  const { tree } = useLocationTree();
  const [name, setName] = useState(series?.name ?? '');
  const [loc, setLoc] = useState<string | null>(series?.locationNodeId ?? null);
  const [pattern, setPattern] = useState(series?.pattern ?? '{PREFIX}/{LOC}/{FYS}/{SEQ:4}');
  const [reset, setReset] = useState<'never' | 'fy' | 'month'>(series?.reset ?? 'fy');
  const [active, setActive] = useState(series?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewLoc, setPreviewLoc] = useState<string | null>(series?.locationNodeId ?? null);
  const [previewDate, setPreviewDate] = useState(today());
  const dDate = useDebounced(previewDate, 300);

  const server = useQuery({
    queryKey: ['numbering-preview', series?.id, series?.version, previewLoc, dDate],
    queryFn: () => numberingApi.preview(series!.id, { locationId: previewLoc, date: dDate }),
    enabled: !!series,
    retry: false,
  });
  const locCode = (id: string | null) => (id ? tree?.byId.get(id)?.node.code ?? null : null);
  const patternChanged = !!series && pattern !== series.pattern;

  async function save() {
    if (!name.trim()) { setError(t('num.nameRequired')); return; }
    if (patternProblem(pattern)) return;
    setBusy(true);
    setError(null);
    const body = { docTypeKey: docType, name: name.trim(), locationNodeId: loc, pattern, reset, isActive: active };
    try {
      if (series) await numberingApi.update(series.id, { ...body, version: series.version });
      else await numberingApi.create(body);
      void qc.invalidateQueries({ queryKey: ['numbering', docType] });
      toast.success(series ? t('num.saved', { name: body.name }) : t('num.created', { name: body.name }));
      onClose();
    } catch (e) {
      setError(isApiError(e) && (e.status === 409 && e.is('VERSION_CONFLICT')) ? t('num.conflict') : isApiError(e) ? [e.message, ...e.errors.map(x => x.message)].join(' · ') : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={series ? t('num.editTitle', { name: series.name }) : t('num.addTitle')} size="lg" closeLabel={t('common.close')} data-testid="numbering-dialog"
        footer={<>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          {canEdit && <Button onClick={() => void save()} loading={busy} disabled={!!patternProblem(pattern)} data-testid="numbering-save">{series ? t('common.saveChanges') : t('num.add')}</Button>}
        </>}>
        <fieldset disabled={!canEdit} className="space-y-4">
          {error && <InlineAlert data-testid="numbering-error">{error}</InlineAlert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('num.name')} required>
              <Input value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder={t('num.namePlaceholder')} data-testid="numbering-name" />
            </FormField>
            <FormField label={t('num.location')} hint={t('num.locationHint')}>
              <LocationPicker value={loc} onChange={id => { setLoc(id); setPreviewLoc(id); }} testId="numbering-location" allLabel={t('num.allLocationsDefault')} />
            </FormField>
          </div>
          <PatternEditor value={pattern} onChange={setPattern} testId="numbering-pattern" label={t('num.pattern')}
            previewCtx={{ prefix: docType, loc: locCode(previewLoc) ?? locCode(loc) ?? 'LOC', fyStartMonth: fy, date: new Date(`${previewDate}T12:00:00`) }} />
          {patternChanged && <p className="text-sm text-warning" data-testid="numbering-renumber-note">{t('num.noRenumber')}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('num.reset')} hint={t(`num.resetHint.${reset}` as 'num.resetHint.fy')}>
              <NativeSelect value={reset} onChange={e => setReset(e.target.value as typeof reset)} data-testid="numbering-reset">
                <option value="fy">{t('num.resetOpt.fy')}</option>
                <option value="month">{t('num.resetOpt.month')}</option>
                <option value="never">{t('num.resetOpt.never')}</option>
              </NativeSelect>
            </FormField>
            <div className="flex items-start gap-2.5 pt-6">
              <Switch id="num-active" checked={active} onCheckedChange={setActive} data-testid="numbering-active" className="mt-0.5" />
              <div><Label htmlFor="num-active" className="font-normal">{t('num.active')}</Label><p className="text-sm text-fg-muted">{t('num.activeHint')}</p></div>
            </div>
          </div>
        </fieldset>
        <section className="mt-5 space-y-2 rounded-lg border border-border p-3" aria-labelledby="num-try">
          <h3 id="num-try" className="text-sm font-semibold">{t('num.tryTitle')}</h3>
          <p className="text-sm text-fg-muted">{t('num.tryHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('num.tryLocation')}><LocationPicker value={previewLoc} onChange={setPreviewLoc} testId="numbering-preview-location" allLabel={t('num.noLocation')} /></FormField>
            <FormField label={t('num.tryDate')}><Input type="date" value={previewDate} onChange={e => setPreviewDate(e.target.value)} data-testid="numbering-preview-date" /></FormField>
          </div>
          {series && (
            <p className="text-sm" aria-live="polite">
              <span className="text-fg-muted">{patternChanged ? t('num.serverNextSaved') : t('num.serverNext')} </span>
              {server.isFetching ? <span className="text-fg-subtle">{t('common.loading')}</span>
                : server.error ? <span className="text-danger" data-testid="numbering-preview-error">{isApiError(server.error) ? server.error.message : t('num.previewFailed')}</span>
                  : <span className="font-mono font-semibold" data-testid="numbering-preview">{server.data?.number ?? '—'}</span>}
            </p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
