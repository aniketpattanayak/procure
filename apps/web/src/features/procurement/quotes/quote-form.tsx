'use client';
import type { VendorQuoteRow } from '@procure/schema';
import { VendorQuoteInput } from '@procure/schema';
import { Button, Checkbox, Dialog, DialogContent, FormField, Input, Segmented, Textarea } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtQty } from '@/features/documents/decimal';
import { procApi, type QuoteBody } from '../api';
import { effectiveRate, fmtRate, freightPerUnit, landedPerUnit, num, slabIssues } from '../calc';
import { MasterPicker, type PickedOption } from '../components/master-picker';
import { SlabEditor, slabsFromInput, slabsToInput, type SlabDraft } from './slab-editor';

export interface QuoteLineContext {
  lineId: string;
  itemId: string | null;
  itemName: string;
  qty: string;
  uom: string;
  docNumber: string | null;
  lineNo: number;
}

interface Draft {
  vendor: PickedOption | null;
  quotedRate: string;
  currency: string;
  taxPct: string;
  freight: string;
  freightBasis: 'lump_sum' | 'per_unit';
  moq: string;
  leadTimeDays: string;
  validUntil: string;
  paymentTerms: PickedOption | null;
  notes: string;
  fileIds: string[];
  slabs: SlabDraft[];
  also: string[];
}

function fromRow(r: VendorQuoteRow | null): Draft {
  return {
    vendor: r ? { id: r.vendor.id, code: r.vendor.code, name: r.vendor.name } : null,
    quotedRate: r?.quotedRate ?? '',
    currency: r?.currency ?? 'INR',
    taxPct: r?.taxPct ?? '18',
    freight: r?.freight && r.freight !== '0' ? r.freight : '',
    freightBasis: r?.freightBasis ?? 'lump_sum',
    moq: r?.moq ?? '',
    leadTimeDays: r?.leadTimeDays !== undefined && r?.leadTimeDays !== null ? String(r.leadTimeDays) : '',
    validUntil: r?.validUntil ?? '',
    paymentTerms: r?.paymentTermsId ? { id: r.paymentTermsId, name: t('proc.quote.termsSaved') } : null,
    notes: r?.notes ?? '',
    fileIds: r?.fileIds ?? [],
    slabs: slabsFromInput(r?.slabs),
    also: [],
  };
}

/** Log a quote (POST) or edit one (PUT → new version, the old one is kept in history). */
export function QuoteFormDialog({ open, onOpenChange, line, editing, vendorSuggestions, onSaved, currency: tenantCurrency }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  line: QuoteLineContext;
  editing: VendorQuoteRow | null;
  vendorSuggestions: PickedOption[];
  onSaved: (rows: VendorQuoteRow[]) => void;
  currency: string;
}) {
  const [d, setD] = useState<Draft>(() => ({ ...fromRow(editing), currency: editing?.currency ?? tenantCurrency }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(x => ({ ...x, [k]: v }));

  // Other open lines of the same item (across indents) to log the same quote on.
  const others = useQuery({
    queryKey: ['procurement', 'also-lines', line.itemId],
    queryFn: () => procApi.selectableLines({ item: line.itemId ?? undefined, limit: 50 }),
    enabled: open && !editing && !!line.itemId,
    staleTime: 30_000,
    retry: false,
  });
  const otherLines = (others.data?.data ?? []).filter(o => o.indentLineId !== line.lineId);

  const q = num(line.qty);
  const preview = useMemo(() => {
    const slabs = slabsToInput(d.slabs);
    const eff = effectiveRate(d.quotedRate, Object.keys(slabIssues(slabs)).length ? [] : slabs, q);
    const fpu = freightPerUnit(d.freight, d.freightBasis, q);
    return { eff, fpu, landed: landedPerUnit(eff, d.taxPct, fpu) };
  }, [d, q]);

  const submit = async () => {
    setFormError(null);
    const slabs = slabsToInput(d.slabs);
    const body: QuoteBody = {
      vendorId: d.vendor?.id ?? '',
      quotedRate: d.quotedRate.trim(),
      currency: d.currency.trim().toUpperCase() || 'INR',
      taxPct: d.taxPct.trim() || '0',
      freight: d.freight.trim() || '0',
      freightBasis: d.freightBasis,
      ...(d.moq.trim() ? { moq: d.moq.trim() } : {}),
      ...(d.leadTimeDays.trim() ? { leadTimeDays: Number(d.leadTimeDays) } : {}),
      ...(d.validUntil ? { validUntil: d.validUntil } : {}),
      ...(d.paymentTerms ? { paymentTermsId: d.paymentTerms.id } : {}),
      ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
      fileIds: d.fileIds,
      slabs: slabs as QuoteBody['slabs'],
      alsoForLineIds: editing ? [] : d.also,
    };
    const parsed = VendorQuoteInput.safeParse(body);
    const errs: Record<string, string> = {};
    if (!d.vendor) errs.vendorId = t('proc.quote.err.vendor');
    if (!parsed.success) for (const i of parsed.error.issues) { const k = String(i.path[0] ?? 'form'); if (!errs[k]) errs[k] = k === 'slabs' ? t('proc.quote.err.slabs') : i.message === 'Decimal string' ? t('proc.quote.err.decimal') : i.message; }
    if (Object.keys(slabIssues(slabs)).length) errs.slabs = t('proc.quote.err.slabs');
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const rows = editing ? [await procApi.editQuote(editing.id, body)] : await procApi.logQuote(line.lineId, body);
      onSaved(rows);
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e)) {
        const fe: Record<string, string> = {};
        for (const x of e.errors) if (x.path) fe[x.path.split('.')[0]!] = x.message;
        setErrors(fe);
        setFormError(e.message);
      } else setFormError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const cur = d.currency || 'INR';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="quote-form"
        title={editing ? t('proc.quote.editTitle', { vendor: editing.vendor.name }) : t('proc.quote.logTitle')}
        description={t('proc.quote.forLine', { item: line.itemName, qty: fmtQty(line.qty), uom: line.uom, number: line.docNumber ?? '—', n: line.lineNo })}
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button onClick={submit} loading={saving} data-testid="quote-save">{editing ? t('proc.quote.saveVersion', { n: editing.version + 1 }) : t('proc.quote.save')}</Button>
          </>
        }>
        <div className="space-y-5">
          {formError && <InlineAlert data-testid="quote-error">{formError}</InlineAlert>}
          {editing && <p className="rounded bg-subtle px-3 py-2 text-sm text-fg-muted">{t('proc.quote.versionNote', { n: editing.version })}</p>}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('proc.quote.vendor')} required error={errors.vendorId} className="sm:col-span-2">
              <div>
                <MasterPicker masterKey="vendor" value={d.vendor} onChange={v => set('vendor', v)} ariaLabel={t('proc.quote.vendor')} testId="quote-vendor" invalid={!!errors.vendorId}
                  suggestions={vendorSuggestions} disabled={!!editing} />
              </div>
            </FormField>
            <FormField label={t('proc.quote.rate', { uom: line.uom || t('proc.unit') })} required error={errors.quotedRate}>
              <Input inputMode="decimal" value={d.quotedRate} onChange={e => set('quotedRate', e.target.value)} data-testid="quote-rate" />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label={t('proc.quote.currency')} error={errors.currency}>
                <Input value={d.currency} maxLength={3} onChange={e => set('currency', e.target.value.toUpperCase())} data-testid="quote-currency" />
              </FormField>
              <FormField label={t('proc.quote.taxPct')} error={errors.taxPct}>
                <Input inputMode="decimal" value={d.taxPct} onChange={e => set('taxPct', e.target.value)} data-testid="quote-tax" />
              </FormField>
            </div>
            <FormField label={t('proc.quote.freight')} error={errors.freight} hint={d.freightBasis === 'lump_sum' ? t('proc.quote.freightLumpHint') : t('proc.quote.freightUnitHint', { uom: line.uom || t('proc.unit') })}>
              <Input inputMode="decimal" value={d.freight} placeholder="0" onChange={e => set('freight', e.target.value)} data-testid="quote-freight" />
            </FormField>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('proc.quote.freightBasis')}</span>
              <Segmented<'lump_sum' | 'per_unit'> label={t('proc.quote.freightBasis')} value={d.freightBasis} onChange={v => set('freightBasis', v)} size="md" data-testid="quote-freight-basis"
                options={[{ value: 'lump_sum', label: t('proc.quote.lumpSum') }, { value: 'per_unit', label: t('proc.quote.perUnit') }]} />
            </div>
            <FormField label={t('proc.quote.moq', { uom: line.uom })} error={errors.moq}>
              <Input inputMode="decimal" value={d.moq} onChange={e => set('moq', e.target.value)} data-testid="quote-moq" />
            </FormField>
            <FormField label={t('proc.quote.leadTime')} error={errors.leadTimeDays}>
              <Input inputMode="numeric" value={d.leadTimeDays} onChange={e => set('leadTimeDays', e.target.value.replace(/\D/g, ''))} data-testid="quote-lead" />
            </FormField>
            <FormField label={t('proc.quote.validUntil')} error={errors.validUntil}>
              <Input type="date" value={d.validUntil} onChange={e => set('validUntil', e.target.value)} data-testid="quote-valid" />
            </FormField>
            <FormField label={t('proc.quote.paymentTerms')} error={errors.paymentTermsId}>
              <div><MasterPicker masterKey="payment_terms" value={d.paymentTerms} onChange={v => set('paymentTerms', v)} ariaLabel={t('proc.quote.paymentTerms')} testId="quote-terms" /></div>
            </FormField>
          </div>

          <section aria-labelledby="slab-h" className="space-y-2 border-t border-border pt-4">
            <div>
              <h3 id="slab-h" className="font-medium">{t('proc.slab.title')}</h3>
              <p className="text-sm text-fg-muted">{t('proc.slab.hint')}</p>
            </div>
            <SlabEditor value={d.slabs} onChange={v => set('slabs', v)} baseRate={d.quotedRate} qty={line.qty} uom={line.uom} currency={cur} />
            {errors.slabs && <p className="text-sm text-danger">{errors.slabs}</p>}
          </section>

          <div className="grid gap-x-4 gap-y-1 rounded border border-border px-3 py-2.5 text-sm sm:grid-cols-3" data-testid="quote-preview">
            <PreviewStat label={t('proc.cmp.effective', { qty: fmtQty(line.qty), uom: line.uom })} value={fmtRate(preview.eff, cur)} />
            <PreviewStat label={t('proc.cmp.freightPerUnit')} value={fmtRate(preview.fpu, cur)} />
            <PreviewStat label={t('proc.cmp.landedPerUnit')} value={fmtRate(preview.landed, cur)} strong testId="quote-preview-landed" />
          </div>

          <FormField label={t('proc.quote.notes')} error={errors.notes}>
            <Textarea rows={2} value={d.notes} onChange={e => set('notes', e.target.value)} data-testid="quote-notes" />
          </FormField>
          <div className="space-y-1.5" data-testid="quote-files">
            <span className="text-sm font-medium">{t('proc.quote.files')}</span>
            <FileUpload value={d.fileIds} onChange={v => set('fileIds', Array.isArray(v) ? v : v ? [v] : [])} multiple maxFiles={20} maxSizeMb={25} fieldKey="quote_files" />
          </div>

          {!editing && otherLines.length > 0 && (
            <fieldset className="space-y-2 border-t border-border pt-4" data-testid="quote-also">
              <legend className="font-medium">{t('proc.quote.alsoTitle', { item: line.itemName })}</legend>
              <p className="text-sm text-fg-muted">{t('proc.quote.alsoHint')}</p>
              <ul className="space-y-1.5">
                {otherLines.map(o => (
                  <li key={o.indentLineId}>
                    <label className="flex items-center gap-2.5 text-sm">
                      <Checkbox checked={d.also.includes(o.indentLineId)} data-testid={`quote-also-${o.indentLineId}`}
                        onCheckedChange={c => set('also', c ? [...d.also, o.indentLineId] : d.also.filter(x => x !== o.indentLineId))} />
                      <span className="font-medium tabular-nums">{o.indentNumber ?? '—'}</span>
                      <span className="text-fg-muted">{o.location.name} · {fmtQty(o.pendingOrder)} {o.uom ?? ''}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewStat({ label, value, strong, testId }: { label: string; value: string; strong?: boolean; testId?: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-fg-subtle">{label}</p>
      <p className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'} data-testid={testId}>{value}</p>
    </div>
  );
}
