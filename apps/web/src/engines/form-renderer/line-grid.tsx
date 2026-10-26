'use client';
import type { DataField, GridColumn } from '@procure/schema';
import { Button, cn, useVirtualizer } from '@procure/ui';
import { Copy, Plus, Rows3, Trash2 } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { t } from '@/i18n';
import { fieldDomId, useRenderer } from './context';
import { FieldControl, ReadValue, type ControlField } from './controls';
import { formatDecimal, newRowId, NUMERIC_TYPES, precisionOf } from './values';

type GridField = Extract<DataField, { type: 'grid' }>;
type Row = Record<string, unknown>;

const VIRTUAL_AFTER = 50;
const ROW_H = 41;

function colWidth(c: GridColumn): number {
  switch (c.type) {
    case 'checkbox': case 'toggle': return 72;
    case 'number': case 'decimal': case 'percentage': return 120;
    case 'currency': case 'formula': return 140;
    case 'date': case 'time': return 150;
    case 'datetime': case 'daterange': return 230;
    case 'lookup': case 'multilookup': case 'multiselect': return 230;
    case 'file': case 'image': case 'files': case 'signature': return 240;
    case 'textarea': return 240;
    default: return 180;
  }
}

function aggregatedColumns(def: { fields: unknown[]; validations?: { expr: string }[] }, grid: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(`\\b${grid}\\.([a-z][a-z0-9_]*)`, 'g');
  const scan = (src: unknown) => { if (typeof src === 'string') for (const m of src.matchAll(re)) out.add(m[1]!); };
  for (const f of def.fields as Record<string, unknown>[]) {
    scan(f.expr); scan(f.visibleWhen); scan(f.requiredWhen); scan(f.readOnlyWhen);
  }
  def.validations?.forEach(v => scan(v.expr));
  return out;
}

/** Exact sum of decimal strings at a fixed number of places (BigInt, no float drift). */
function sumDecimals(values: unknown[], places: number): string {
  const scale = 10n ** BigInt(places);
  let total = 0n;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const s = String(v);
    if (!/^-?\d+(\.\d+)?$/.test(s)) continue;
    const neg = s.startsWith('-');
    const [i = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
    const n = BigInt(i) * scale + BigInt((f + '0'.repeat(places)).slice(0, places) || '0');
    total += neg ? -n : n;
  }
  const neg = total < 0n;
  const abs = neg ? -total : total;
  const int = abs / scale;
  const frac = (abs % scale).toString().padStart(places, '0');
  return `${neg ? '-' : ''}${int}${places ? `.${frac}` : ''}`;
}

/** Line-item grid: add/duplicate/remove rows, arrow-key row navigation, live per-row formulas and column totals. */
export function LineGrid({ field, readOnly }: { field: GridField; readOnly: boolean }) {
  const ctx = useRenderer();
  const rows: Row[] = Array.isArray(ctx.values[field.key]) ? (ctx.values[field.key] as Row[]) : [];
  const computedRows: Row[] = Array.isArray(ctx.computed[field.key]) ? (ctx.computed[field.key] as Row[]) : rows;
  const view = ctx.mode === 'view';
  const editable = !view && !readOnly;

  const cols = field.columns.filter(c => !c.removed && !c.hidden && ctx.state[`${field.key}.${c.key}`]?.visible !== false);
  // Totals for computed columns and for columns the form aggregates (SUM(lines.qty)); summing rates would mislead.
  const aggregated = aggregatedColumns(ctx.def, field.key);
  const totals = cols.map(c => {
    const numeric = (c.type === 'formula' && c.resultType === 'number') || (NUMERIC_TYPES.has(c.type) && c.type !== 'percentage' && aggregated.has(c.key));
    if (!numeric) return null;
    const places = c.type === 'formula' ? (c.precision ?? 2) : precisionOf(c);
    const src = c.type === 'formula' ? computedRows : rows;
    return { places, sum: sumDecimals(src.map(r => r[c.key]), places), currency: c.type === 'currency' ? (c.currency ?? ctx.currency) : undefined };
  });
  const hasTotals = rows.length > 1 && totals.some(Boolean);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUAL_AFTER;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
    enabled: virtual,
  });
  const items = virtual ? virtualizer.getVirtualItems() : null;
  const padTop = items && items.length ? items[0]!.start : 0;
  const padBottom = items && items.length ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;
  const indexes = items ? items.map(i => i.index) : rows.map((_, i) => i);

  const atMax = rows.length >= field.maxRows;
  const atMin = rows.length <= field.minRows;

  function focusCell(row: number, col: string) {
    const go = () => document.getElementById(fieldDomId(ctx.idPrefix, `${field.key}.${row}.${col}`))?.focus();
    if (virtual) { virtualizer.scrollToIndex(row, { align: 'auto' }); setTimeout(go, 40); } else setTimeout(go, 0);
  }

  function addRow(at = rows.length, from?: Row) {
    if (atMax) return;
    const fresh: Row = from ? { ...from, _row: newRowId() } : { _row: newRowId() };
    if (!from) for (const c of field.columns) {
      const d = (c as { default?: unknown }).default;
      if (d !== undefined) fresh[c.key] = c.type === 'date' && d === 'today' ? ctx.today : NUMERIC_TYPES.has(c.type) && typeof d === 'number' ? String(d) : d;
    }
    const next = [...rows];
    next.splice(at, 0, fresh);
    ctx.setRows(field.key, next);
    const firstEditable = cols.find(c => c.type !== 'formula');
    if (firstEditable) focusCell(at, firstEditable.key);
  }
  function removeRow(i: number) {
    if (atMin) return;
    ctx.setRows(field.key, rows.filter((_, j) => j !== i));
  }

  function onKeyDown(e: KeyboardEvent<HTMLTableSectionElement>) {
    const el = e.target as HTMLElement;
    const cell = el.closest('[data-cell]') as HTMLElement | null;
    if (!cell) return;
    const r = Number(cell.dataset.row);
    const c = cell.dataset.col!;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && editable) { e.preventDefault(); addRow(r + 1); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && editable) { e.preventDefault(); addRow(r + 1, rows[r]); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.getAttribute('role') === 'combobox' && el.getAttribute('aria-expanded') === 'true') return;
    if (el.getAttribute('type') === 'date' || el.getAttribute('type') === 'time') return;
    const target = e.key === 'ArrowDown' ? r + 1 : r - 1;
    if (target < 0 || target >= rows.length) return;
    e.preventDefault();
    focusCell(target, c);
  }

  if (rows.length === 0 && !editable) return <p className="rounded border border-dashed border-border px-3 py-4 text-center text-sm text-fg-subtle">{t('fr.grid.empty')}</p>;

  const firstCol = cols[0]?.key;

  return (
    <div className="min-w-0 space-y-2" data-testid={`grid-${field.key}`}>
      <div ref={scrollRef} className="overflow-auto rounded border border-border" style={{ maxHeight: virtual ? 520 : undefined }}>
        <table className="w-full border-separate border-spacing-0 text-base" aria-rowcount={rows.length + 1}>
          <thead className="sticky top-0 z-20 bg-subtle">
            <tr>
              <th scope="col" className="sticky left-0 z-30 w-10 min-w-10 border-b border-r border-border bg-subtle px-2 py-2 text-right text-xs font-medium text-fg-subtle">#</th>
              {cols.map(c => {
                const st = ctx.state[`${field.key}.${c.key}`];
                const req = c.type !== 'formula' && (c.required || st?.required);
                return (
                  <th key={c.key} scope="col" style={{ minWidth: colWidth(c), width: colWidth(c) }}
                    className={cn('border-b border-border px-2 py-2 text-left text-sm font-medium text-fg-muted', c.key === firstCol && 'sticky left-10 z-30 border-r bg-subtle', (NUMERIC_TYPES.has(c.type) || c.type === 'formula') && 'text-right')}>
                    <span className="inline-flex items-center gap-1">
                      {c.type === 'formula' && <span className="rounded-sm bg-accent-soft px-1 text-[0.7rem] font-semibold text-accent" aria-hidden>ƒx</span>}
                      {c.label}
                      {req && editable && <span className="text-danger" aria-hidden>*</span>}
                    </span>
                  </th>
                );
              })}
              {editable && <th scope="col" className="w-20 min-w-20 border-b border-border bg-subtle"><span className="sr-only">{t('common.actions')}</span></th>}
            </tr>
          </thead>
          <tbody onKeyDown={onKeyDown}>
            {padTop > 0 && <tr aria-hidden><td style={{ height: padTop }} colSpan={cols.length + 2} /></tr>}
            {indexes.map(i => {
              const row = rows[i]!;
              const crow = computedRows[i] ?? row;
              const scope = { grid: field.key, rowIndex: i, row };
              return (
                <tr key={String(row._row ?? i)} aria-rowindex={i + 2} className="group" style={{ height: ROW_H }} data-testid={`grid-${field.key}-row-${i}`}>
                  <th scope="row" data-testid={ctx.gridTestIds?.[field.key]?.row?.(i)} className="sticky left-0 z-10 border-b border-r border-border bg-surface px-2 text-right text-xs font-normal tabular-nums text-fg-subtle group-hover:bg-subtle">{i + 1}</th>
                  {cols.map(c => {
                    const path = `${field.key}.${i}.${c.key}`;
                    const id = fieldDomId(ctx.idPrefix, path);
                    const err = ctx.errors[path];
                    const st = ctx.state[`${field.key}.${c.key}`];
                    const ro = !editable || c.readOnly || !!st?.readOnly || ctx.readOnly.has(`${field.key}.${c.key}`) || c.type === 'formula';
                    const value = c.type === 'formula' ? crow[c.key] : row[c.key];
                    return (
                      <td key={c.key} data-cell data-row={i} data-col={c.key} data-testid={`field-${field.key}-${i}-${c.key}`}
                        className={cn('border-b border-border p-0 align-top', c.key === firstCol && 'sticky left-10 z-10 border-r bg-surface group-hover:bg-subtle', err && 'bg-danger-soft/40')}>
                        {view ? (
                          <div className="px-2 py-1"><ReadValue field={c as ControlField} value={value} scope={scope} testId={`field-${field.key}-${i}-${c.key}-value`} /></div>
                        ) : (
                          <FieldControl
                            field={c as ControlField}
                            value={value}
                            onChange={(v, opt) => ctx.setCell(field.key, i, c.key, v, opt)}
                            onBlur={() => ctx.touch(path)}
                            scope={scope}
                            id={id}
                            describedBy={err ? `${id}-error` : undefined}
                            invalid={!!err}
                            required={c.required || !!st?.required}
                            readOnly={ro}
                            compact
                            ariaLabel={t('fr.grid.cellLabel', { col: c.label, row: i + 1 })}
                            testId={`field-${field.key}-${i}-${c.key}-input`}
                          />
                        )}
                        {err && <p id={`${id}-error`} role="alert" className="px-2 pb-1 text-xs font-medium text-danger">{err}</p>}
                      </td>
                    );
                  })}
                  {editable && (
                    <td className="border-b border-border px-1 text-right">
                      <div className="flex justify-end gap-0.5 opacity-70 group-focus-within:opacity-100 group-hover:opacity-100">
                        <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => addRow(i + 1, row)} disabled={atMax} aria-label={t('fr.grid.duplicate', { n: i + 1 })} data-testid={`grid-${field.key}-dup-${i}`}><Copy /></Button>
                        <Button variant="ghost" size="icon-sm" className="size-7 hover:text-danger" onClick={() => removeRow(i)} disabled={atMin} aria-label={t('fr.grid.remove', { n: i + 1 })} data-testid={`grid-${field.key}-del-${i}`}><Trash2 /></Button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {padBottom > 0 && <tr aria-hidden><td style={{ height: padBottom }} colSpan={cols.length + 2} /></tr>}
            {rows.length === 0 && (
              <tr><td colSpan={cols.length + 2} className="px-3 py-6 text-center text-sm text-fg-subtle"><Rows3 className="mx-auto mb-1 size-5" aria-hidden />{t('fr.grid.empty')}</td></tr>
            )}
          </tbody>
          {hasTotals && (
            <tfoot className="sticky bottom-0 z-20 bg-subtle" data-testid={`grid-${field.key}-totals`}>
              <tr>
                <th scope="row" className="sticky left-0 z-30 border-r border-t border-border bg-subtle px-2 text-right text-xs font-medium text-fg-subtle">Σ</th>
                {cols.map((c, j) => (
                  <td key={c.key} className={cn('border-t border-border px-2 py-2 text-right text-sm font-semibold tabular-nums', c.key === firstCol && 'sticky left-10 z-30 border-r bg-subtle text-left font-medium text-fg-muted')} data-testid={totals[j] ? `grid-${field.key}-total-${c.key}` : undefined}>
                    {c.key === firstCol && !totals[j] ? t('fr.grid.total') : totals[j] ? formatDecimal(totals[j]!.sum, totals[j]!.places, { currency: totals[j]!.currency }) : ''}
                  </td>
                ))}
                {editable && <td className="border-t border-border" />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => addRow()} disabled={atMax} data-testid={ctx.gridTestIds?.[field.key]?.add ?? `grid-${field.key}-add`}><Plus aria-hidden />{t('fr.grid.add')}</Button>
          <span className="text-xs text-fg-subtle">{t('fr.grid.keys')}</span>
          {atMax && <span className="text-xs text-fg-muted">{t('fr.grid.maxReached', { n: field.maxRows })}</span>}
        </div>
      )}
    </div>
  );
}
