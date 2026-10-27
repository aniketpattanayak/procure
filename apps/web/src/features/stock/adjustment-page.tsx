'use client';
import type { DocumentRow } from '@procure/schema';
import { Button, Card, EmptyState, FormField, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { dec, fmtQty, isDecimal } from '@/features/documents/decimal';
import { MasterPicker } from '@/features/procurement/components/master-picker';
import { invApi, stockError, stockKeys } from './api';
import { LocationSelect } from './components';

type AdjustmentType = 'write_off' | 'positive' | 'negative';

interface AdjLine {
  id: string;
  itemId: string;
  itemName: string;
  qty: string;
  unitCost: string;
  reason: string;
  adjustmentType: AdjustmentType;
}

let _id = 0;
const nextId = () => String(++_id);

const ADJUSTMENT_TYPES: { value: AdjustmentType; label: string; hint: string }[] = [
  { value: 'write_off', label: 'Write-off', hint: 'Damaged / expired / lost' },
  { value: 'positive', label: 'Stock gain', hint: 'Found / received' },
  { value: 'negative', label: 'Stock correction', hint: 'Decrease adjustment' },
];

const emptyLine = (): AdjLine => ({
  id: nextId(),
  itemId: '',
  itemName: '',
  qty: '',
  unitCost: '',
  reason: '',
  adjustmentType: 'write_off',
});

function lineError(l: AdjLine): string | null {
  if (!l.itemId) return 'Select an item';
  if (!isDecimal(l.qty) || !dec.gt0(l.qty)) return 'Enter a valid quantity';
  if (l.unitCost && !isDecimal(l.unitCost)) return 'Unit cost must be a number';
  return null;
}

export function AdjustmentPage() {
  const qc = useQueryClient();
  const router = useRouter();

  const [locationId, setLocationId] = useState('');
  const [lines, setLines] = useState<AdjLine[]>([emptyLine()]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);

  const setLine = (id: string, patch: Partial<AdjLine>) =>
    setLines(ls => ls.map(l => (l.id === id ? { ...l, ...patch } : l)));

  const removeLine = (id: string) =>
    setLines(ls => (ls.length > 1 ? ls.filter(l => l.id !== id) : ls));

  const addLine = () => setLines(ls => [...ls, emptyLine()]);

  const badLines = lines.filter(l => lineError(l));

  const create = async (submit: boolean) => {
    setError(null);
    if (!locationId) { setError('Select a location'); return; }
    if (lines.length === 0) { setError('Add at least one line'); return; }
    if (badLines.length) { setError(`Fix ${badLines.length} line error${badLines.length > 1 ? 's' : ''} before saving`); return; }

    setSaving(submit ? 'submit' : 'draft');
    try {
      const doc = await invApi.stockAdjustment({
        locationId,
        lines: lines.map(l => ({
          itemId: l.itemId,
          qty: dec.norm(l.qty),
          adjustmentType: l.adjustmentType,
          ...(l.reason.trim() ? { reason: l.reason.trim() } : {}),
          ...(l.unitCost.trim() ? { unitCost: dec.norm(l.unitCost) } : {}),
        })),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        submit,
      });
      void qc.invalidateQueries({ queryKey: stockKeys.inventory });
      toast.success('Adjustment created');
      router.push(`/docs/stock_adjustment/${doc.id}`);
    } catch (e) {
      const se = stockError(e);
      setError(se.message);
      setSaving(null);
    }
  };

  return (
    <PageBody>
      <PageHeader
        back={
          <Link href="/stock" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
            <ArrowLeft className="size-3.5" aria-hidden />
            Stock
          </Link>
        }
        title="Stock Write-off / Adjustment"
        description="Record stock write-offs, gains, or corrections against a location."
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Main form */}
        <div className="min-w-0 space-y-4">
          {/* Location */}
          <FormField label="Location" required>
            <LocationSelect
              value={locationId}
              onChange={setLocationId}
              label="Select location"
              testId="adj-location"
              required
            />
          </FormField>

          {/* Lines table */}
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border bg-subtle px-3 py-2">
              <h2 className="font-semibold text-sm">Adjustment lines</h2>
            </div>

            {lines.length === 0 ? (
              <EmptyState icon={<AlertTriangle />} title="No lines" description="Add at least one item to adjust." />
            ) : (
              <ul className="divide-y divide-border">
                {lines.map((l, i) => {
                  const err = lineError(l);
                  return (
                    <li key={l.id} className="px-3 py-3 space-y-2" data-testid={`adj-line-${i + 1}`}>
                      <div className="flex items-start gap-2">
                        <span className="mt-2 w-5 shrink-0 text-xs text-fg-muted tabular-nums">{i + 1}</span>
                        <div className="min-w-0 flex-1 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_8rem_10rem_1fr]">
                          {/* Item picker */}
                          <MasterPicker
                            masterKey="item"
                            value={l.itemId ? { id: l.itemId, name: l.itemName } : null}
                            onChange={v => setLine(l.id, { itemId: v?.id ?? '', itemName: v?.name ?? '' })}
                            placeholder="Search item…"
                            aria-label="Item"
                            data-testid={`adj-item-${i + 1}`}
                          />
                          {/* Qty */}
                          <Input
                            inputMode="decimal"
                            placeholder="Qty"
                            className="h-8"
                            value={l.qty}
                            onChange={e => setLine(l.id, { qty: e.target.value })}
                            aria-label="Quantity"
                            data-testid={`adj-qty-${i + 1}`}
                          />
                          {/* Unit cost */}
                          <Input
                            inputMode="decimal"
                            placeholder="Unit cost (opt.)"
                            className="h-8"
                            value={l.unitCost}
                            onChange={e => setLine(l.id, { unitCost: e.target.value })}
                            aria-label="Unit cost"
                            data-testid={`adj-cost-${i + 1}`}
                          />
                          {/* Type */}
                          <Select
                            value={l.adjustmentType}
                            onValueChange={v => setLine(l.id, { adjustmentType: v as AdjustmentType })}
                          >
                            <SelectTrigger className="h-8" aria-label="Adjustment type" data-testid={`adj-type-${i + 1}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ADJUSTMENT_TYPES.map(t => (
                                <SelectItem key={t.value} value={t.value}>
                                  {t.label} <span className="text-fg-muted">· {t.hint}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLine(l.id)}
                          className="mt-1.5 shrink-0 rounded p-1 text-fg-muted hover:bg-danger-soft hover:text-danger"
                          aria-label={`Remove line ${i + 1}`}
                          data-testid={`adj-remove-${i + 1}`}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </button>
                      </div>
                      {/* Per-line reason */}
                      <div className="pl-7">
                        <Input
                          placeholder="Reason (optional)"
                          className="h-8"
                          value={l.reason}
                          maxLength={200}
                          onChange={e => setLine(l.id, { reason: e.target.value })}
                          aria-label="Reason"
                          data-testid={`adj-reason-${i + 1}`}
                        />
                      </div>
                      {err && (
                        <p className="pl-7 text-sm text-danger" role="alert">{err}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="border-t border-border px-3 py-2">
              <Button type="button" variant="ghost" size="sm" onClick={addLine} data-testid="adj-add-line">
                <Plus className="size-4" aria-hidden />
                Add item
              </Button>
            </div>
          </div>

          {/* Overall notes */}
          <FormField label="Notes">
            <Textarea
              placeholder="Optional notes for this adjustment…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              maxLength={1000}
              rows={3}
              data-testid="adj-notes"
            />
          </FormField>
        </div>

        {/* Sidebar summary */}
        <Card className="h-fit space-y-3 p-4 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)]">
          <h2 className="font-semibold">Summary</h2>
          <p className="text-sm text-fg-muted">
            {lines.length > 0
              ? `${lines.length} line${lines.length > 1 ? 's' : ''}`
              : 'No lines added yet'}
          </p>
          {locationId ? (
            <p className="text-xs text-fg-muted">Location selected</p>
          ) : (
            <p className="text-xs text-warning flex items-center gap-1"><AlertTriangle className="size-3.5" aria-hidden />Select a location</p>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="adj-error">{error}</p>
          )}
          <Button
            className="w-full"
            variant="secondary"
            disabled={!locationId || lines.length === 0 || !!saving}
            loading={saving === 'draft'}
            onClick={() => create(false)}
            data-testid="adj-save-draft"
          >
            Save as draft
          </Button>
          <Button
            className="w-full"
            disabled={!locationId || lines.length === 0 || !!saving}
            loading={saving === 'submit'}
            onClick={() => create(true)}
            data-testid="adj-submit"
          >
            Create Adjustment
          </Button>
          <p className="text-xs text-fg-subtle">
            Submitted adjustments post immediately to the stock ledger.
          </p>
        </Card>
      </div>
    </PageBody>
  );
}
