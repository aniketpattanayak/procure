'use client';
import type { DocumentRow } from '@procure/schema';
import { Button, Card, EmptyState, FormField, Input, Skeleton, toast } from '@procure/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Repeat2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageBody, PageHeader } from '@/components/page';
import { docKeys } from '@/features/documents/api';
import { dec, isDecimal } from '@/features/documents/decimal';
import { invApi, stockError, stockKeys } from './api';
import { LocationSelect } from './components';

interface TransferLine {
  id: string;
  itemId: string;
  itemName: string;
  qty: string;
}

let _lineId = 0;
function nextId() { return String(++_lineId); }

function emptyLine(): TransferLine {
  return { id: nextId(), itemId: '', itemName: '', qty: '' };
}

function lineError(l: TransferLine): string | null {
  if (!l.itemId.trim() || !l.itemName.trim()) return 'Item is required';
  if (!isDecimal(l.qty) || !dec.gt0(l.qty)) return 'Enter a valid quantity greater than zero';
  return null;
}

/** Location-to-location stock transfer. */
export function TransferPage() {
  const qc = useQueryClient();
  const router = useRouter();

  const [fromLocation, setFromLocation] = useState('');
  const [toLocation, setToLocation] = useState('');
  const [lines, setLines] = useState<TransferLine[]>([emptyLine()]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<'draft' | 'submit' | null>(null);

  const updateLine = (id: string, patch: Partial<TransferLine>) =>
    setLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));

  const removeLine = (id: string) =>
    setLines(prev => prev.length > 1 ? prev.filter(l => l.id !== id) : prev);

  const addLine = () => setLines(prev => [...prev, emptyLine()]);

  const validate = (): string | null => {
    if (!fromLocation) return 'Select a From Location';
    if (!toLocation) return 'Select a To Location';
    if (fromLocation === toLocation) return 'From and To locations must be different';
    if (lines.length === 0) return 'Add at least one item line';
    const bad = lines.map(lineError).find(Boolean);
    if (bad) return bad;
    return null;
  };

  const create = async (submit: boolean) => {
    setError(null);
    const vErr = validate();
    if (vErr) { setError(vErr); return; }
    setSaving(submit ? 'submit' : 'draft');
    try {
      const doc: DocumentRow = await invApi.stockTransfer({
        fromLocationId: fromLocation,
        toLocationId: toLocation,
        lines: lines.map(l => ({ itemId: l.itemId, qty: dec.norm(l.qty) })),
        notes: notes.trim() || undefined,
        submit,
      });
      void qc.invalidateQueries({ queryKey: stockKeys.all });
      void qc.invalidateQueries({ queryKey: docKeys.all('stock_transfer') });
      toast.success('Stock transfer created');
      router.push(`/docs/stock_transfer/${doc.id}`);
    } catch (e) {
      const se = stockError(e);
      setError(se.message);
      setSaving(null);
    }
  };

  const hasValidLines = lines.length > 0 && lines.every(l => !lineError(l));
  const canSave = !!fromLocation && !!toLocation && fromLocation !== toLocation && hasValidLines;

  return (
    <PageBody>
      <PageHeader
        back={
          <Link href="/stock" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg">
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to Stock
          </Link>
        }
        title="Stock Transfer"
        description="Move stock from one location to another"
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* Main form */}
        <div className="min-w-0 space-y-4">
          {/* Locations row */}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="From Location" required>
              <LocationSelect
                value={fromLocation}
                onChange={setFromLocation}
                label="From Location"
                className="w-full"
                testId="transfer-from"
                required
              />
            </FormField>
            <FormField label="To Location" required>
              <LocationSelect
                value={toLocation}
                onChange={setToLocation}
                label="To Location"
                className="w-full"
                testId="transfer-to"
                required
              />
            </FormField>
          </div>
          {fromLocation && toLocation && fromLocation === toLocation && (
            <p className="text-sm text-danger" role="alert" data-testid="transfer-same-location-err">
              From and To locations must be different
            </p>
          )}

          {/* Lines table */}
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="border-b border-border bg-subtle px-3 py-2">
              <h2 className="text-sm font-semibold">Items to Transfer</h2>
            </div>

            {lines.length === 0 ? (
              <EmptyState
                icon={<Repeat2 />}
                title="No items added"
                description="Click 'Add Item' to add items to transfer"
              />
            ) : (
              <ul className="divide-y divide-border" data-testid="transfer-lines">
                {lines.map((line, idx) => {
                  const err = lineError(line);
                  return (
                    <li key={line.id} className="flex flex-wrap items-start gap-2 px-3 py-3" data-testid={`transfer-line-${idx}`}>
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_2rem]">
                          <Input
                            placeholder="Item name"
                            value={line.itemName}
                            onChange={e => updateLine(line.id, { itemName: e.target.value, itemId: e.target.value.trim() ? line.itemId || e.target.value.trim() : '' })}
                            aria-label={`Item name for line ${idx + 1}`}
                            className="h-8"
                            data-testid={`transfer-item-name-${idx}`}
                          />
                          <Input
                            placeholder="Item ID / code"
                            value={line.itemId}
                            onChange={e => updateLine(line.id, { itemId: e.target.value })}
                            aria-label={`Item ID for line ${idx + 1}`}
                            className="h-8"
                            data-testid={`transfer-item-id-${idx}`}
                          />
                          <Input
                            inputMode="decimal"
                            placeholder="Qty"
                            value={line.qty}
                            onChange={e => updateLine(line.id, { qty: e.target.value })}
                            aria-label={`Quantity for line ${idx + 1}`}
                            aria-invalid={line.qty !== '' && !isDecimal(line.qty) || undefined}
                            className="h-8"
                            data-testid={`transfer-qty-${idx}`}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-fg-muted hover:text-danger"
                            onClick={() => removeLine(line.id)}
                            aria-label={`Remove line ${idx + 1}`}
                            data-testid={`transfer-remove-${idx}`}
                            disabled={lines.length === 1}
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </div>
                        {err && line.itemName !== '' && (
                          <p className="text-xs text-danger" role="alert" data-testid={`transfer-line-err-${idx}`}>{err}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="border-t border-border px-3 py-2">
              <Button variant="ghost" size="sm" onClick={addLine} data-testid="transfer-add-line">
                <Plus className="size-4" aria-hidden />
                Add Item
              </Button>
            </div>
          </div>

          {/* Notes */}
          <FormField label="Notes / Reason">
            <textarea
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Optional reason or notes for this transfer"
              value={notes}
              maxLength={1000}
              onChange={e => setNotes(e.target.value)}
              aria-label="Notes"
              data-testid="transfer-notes"
            />
          </FormField>
        </div>

        {/* Summary sidebar */}
        <Card className="h-fit space-y-3 p-4 lg:sticky lg:top-[calc(var(--topbar-h)+1rem)]">
          <h2 className="font-semibold">Transfer Summary</h2>
          <p className="text-sm text-fg-muted">
            {lines.filter(l => !lineError(l)).length > 0
              ? `${lines.filter(l => !lineError(l)).length} item(s) ready to transfer`
              : 'Add items and select locations to continue'}
          </p>

          {fromLocation && toLocation && fromLocation !== toLocation && (
            <div className="rounded-md border border-border bg-subtle p-2 text-sm">
              <div className="flex items-center gap-1.5 text-fg-muted">
                <Repeat2 className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">Location to location</span>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="transfer-error">
              {error}
            </p>
          )}

          <Button
            className="w-full"
            variant="secondary"
            disabled={!canSave || !!saving}
            loading={saving === 'draft'}
            onClick={() => create(false)}
            data-testid="transfer-create-draft"
          >
            Save as Draft
          </Button>
          <Button
            className="w-full"
            disabled={!canSave || !!saving}
            loading={saving === 'submit'}
            onClick={() => create(true)}
            data-testid="transfer-create-submit"
          >
            Create Transfer
          </Button>
          <p className="text-xs text-fg-subtle">
            Saves a stock transfer document. Submit to post movements immediately.
          </p>
        </Card>
      </div>
    </PageBody>
  );
}
