'use client';
import type { ComparisonSheet as Sheet } from '@procure/schema';
import { Badge, Button, cn, Input, Sparkline } from '@procure/ui';
import { AlertTriangle, Award, Printer } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { t } from '@/i18n';
import { fmtDate } from '@/lib/format';
import { fmtQty } from '@/features/documents/decimal';
import { fmtPct, fmtRate, fmtShortDate, num } from '../calc';

type Vendor = Sheet['vendors'][number];

interface Metric {
  key: string;
  label: string;
  cell: (v: Vendor) => ReactNode;
  /** Visual weight: the landed rows are what the decision rests on. */
  strong?: boolean;
  /** Lower is better: mark the minimum among valid quotes. */
  lowest?: (v: Vendor) => number | null;
}

/**
 * Comparative statement: vendors side by side (columns on wide screens, cards on phones). The best value column
 * (server `isBest`: lowest landed cost among valid quotes meeting MOQ) carries a marker and a tinted column.
 */
export function ComparisonSheetView({ sheet, currency, qty, onQtyChange, footer }: {
  sheet: Sheet;
  currency: string;
  /** Qty the sheet is evaluated at (editable). */
  qty: string;
  onQtyChange?: (q: string) => void;
  footer?: ReactNode;
}) {
  const [q, setQ] = useState(qty);
  const uom = sheet.uom ?? '';
  const vendors = sheet.vendors;
  const best = vendors.find(v => v.isBest) ?? null;
  const cheapestLanded = best ? num(best.landedCostPerUnit) : null;

  const warn = (v: Vendor) => v.warnings.length === 0 ? <span className="text-fg-subtle">—</span> : (
    <ul className="space-y-0.5" data-testid={`compare-warning-${v.vendor.code}`}>
      {v.warnings.map(w => <li key={w} className="flex items-center gap-1 text-xs font-medium text-warning"><AlertTriangle className="size-3.5 shrink-0" aria-hidden />{t(`proc.cmp.warn.${w}` as 'proc.cmp.warn.expired')}</li>)}
    </ul>
  );
  const metrics: Metric[] = [
    { key: 'quoted', label: t('proc.cmp.quoted'), cell: v => fmtRate(v.quotedRate, currency) },
    { key: 'effective', label: t('proc.cmp.effective', { qty: fmtQty(sheet.qty), uom }), cell: v => (
      <span>{fmtRate(v.effectiveRate, currency)}{num(v.effectiveRate) < num(v.quotedRate) && <span className="ml-1.5 text-xs text-success">{t('proc.cmp.slabApplied')}</span>}</span>
    ) },
    { key: 'freight', label: t('proc.cmp.freightPerUnit'), cell: v => fmtRate(v.freightPerUnit, currency) },
    { key: 'tax', label: t('proc.cmp.tax'), cell: v => fmtPct(v.taxPct) },
    { key: 'landed', label: t('proc.cmp.landedPerUnit'), strong: true, cell: v => (
      <span className="inline-flex items-baseline gap-1.5">
        {fmtRate(v.landedCostPerUnit, currency)}
        {cheapestLanded !== null && !v.isBest && num(v.landedCostPerUnit) > cheapestLanded && (
          <span className="text-xs font-normal text-fg-subtle">+{fmtPct(((num(v.landedCostPerUnit) - cheapestLanded) / cheapestLanded) * 100)}</span>
        )}
      </span>
    ) },
    { key: 'total', label: t('proc.cmp.landedTotal', { qty: fmtQty(sheet.qty), uom }), strong: true, cell: v => fmtRate(v.landedTotal, currency) },
    { key: 'lead', label: t('proc.cmp.leadTime'), cell: v => v.leadTimeDays === null ? '—' : t('proc.cmp.days', { n: v.leadTimeDays }) },
    { key: 'moq', label: t('proc.cmp.moq'), cell: v => v.moq ? `${fmtQty(v.moq)} ${uom}` : '—' },
    { key: 'valid', label: t('proc.cmp.validUntil'), cell: v => <span className={cn(v.expired && 'text-danger')}>{v.validUntil ? fmtDate(v.validUntil) : '—'}</span> },
    { key: 'terms', label: t('proc.cmp.paymentTerms'), cell: v => v.paymentTerms ?? '—' },
    { key: 'logged', label: t('proc.cmp.logged'), cell: v => <span className="text-fg-muted">{t('proc.cmp.loggedN', { n: v.quotesLogged, when: fmtShortDate(v.lastLoggedAt) })}</span> },
    { key: 'warnings', label: t('proc.cmp.warnings'), cell: warn },
  ];

  const qtyControl = onQtyChange && (
    <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); onQtyChange(q); }}>
      <label htmlFor="compare-qty" className="text-sm text-fg-muted">{t('proc.cmp.evaluateAt')}</label>
      <Input id="compare-qty" inputMode="decimal" value={q} onChange={e => setQ(e.target.value)} onBlur={() => q !== qty && onQtyChange(q)} className="h-8 w-24" data-testid="compare-qty" />
      <span className="text-sm text-fg-muted">{uom}</span>
    </form>
  );

  return (
    <div className="space-y-4" data-testid="compare-sheet" data-vendors={vendors.length}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-fg-muted">
            {best
              ? <span data-testid="compare-best" data-vendor={best.vendor.code}>{t('proc.cmp.bestIs', { vendor: best.vendor.name, rate: fmtRate(best.landedCostPerUnit, currency), uom: uom || t('proc.unit') })}</span>
              : t('proc.cmp.noBest')}
          </p>
          {sheet.lines.length > 1 && <p className="text-xs text-fg-subtle">{t('proc.cmp.acrossLines', { n: sheet.lines.length })}</p>}
        </div>
        <div className="flex items-center gap-2">
          {qtyControl}
          <Button variant="secondary" size="sm" disabled title={t('proc.cmp.printSoon')} data-testid="compare-print"><Printer aria-hidden />{t('proc.cmp.print')}</Button>
        </div>
      </div>

      {vendors.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-8 text-center text-fg-muted" data-testid="compare-empty">{t('proc.cmp.empty')}</p>
      ) : (
        <>
          {/* Wide: metrics down, vendors across */}
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
            <table className="w-full border-collapse text-base">
              <caption className="sr-only">{t('proc.cmp.caption', { item: sheet.itemName ?? '' })}</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-10 w-48 bg-subtle px-3 py-3 text-left text-sm font-medium text-fg-muted">{t('proc.cmp.vendor')}</th>
                  {vendors.map(v => (
                    <th key={v.vendor.id} scope="col" data-testid={`compare-vendor-${v.vendor.code}`} data-best={v.isBest ? 'true' : 'false'}
                      className={cn('min-w-44 border-l border-border px-3 py-3 text-left align-top', v.isBest ? 'bg-success-soft' : 'bg-subtle')}>
                      {v.isBest && <span className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-success"><Award className="size-3.5" aria-hidden />{t('proc.cmp.best')}</span>}
                      <span className="block font-semibold leading-snug">{v.vendor.name}</span>
                      <span className="block text-xs font-normal text-fg-subtle">{v.vendor.code}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.map(m => (
                  <tr key={m.key} data-testid={`compare-row-${m.key}`} className={cn('border-t border-border', m.strong && 'border-t-border-strong')}>
                    <th scope="row" className={cn('sticky left-0 z-10 bg-surface px-3 py-2 text-left text-sm font-normal text-fg-muted', m.strong && 'font-medium text-fg')}>{m.label}</th>
                    {vendors.map(v => (
                      <td key={v.vendor.id} data-testid={`compare-cell-${v.vendor.code}-${m.key}`}
                        className={cn('border-l border-border px-3 py-2 tabular-nums', v.isBest && 'bg-success-soft/40', m.strong && 'font-semibold', m.strong && v.isBest && 'text-success')}>
                        {m.cell(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phones: one card per vendor, best first */}
          <ul className="space-y-2 md:hidden" data-testid="compare-cards">
            {[...vendors].sort((a, b) => Number(b.isBest) - Number(a.isBest)).map(v => (
              <li key={v.vendor.id} className={cn('rounded-lg border p-3', v.isBest ? 'border-success/50 bg-success-soft/50' : 'border-border bg-surface')} data-best={v.isBest ? 'true' : 'false'}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold">{v.vendor.name}</p>
                    <p className="text-xs text-fg-subtle">{v.vendor.code}</p>
                  </div>
                  {v.isBest && <Badge tone="success"><Award className="size-3" aria-hidden />{t('proc.cmp.best')}</Badge>}
                </div>
                <p className="mt-2 text-lg font-semibold tabular-nums">{fmtRate(v.landedCostPerUnit, currency)}<span className="ml-1 text-sm font-normal text-fg-muted">{t('proc.cmp.landedShort', { uom: uom || t('proc.unit') })}</span></p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  {metrics.filter(m => m.key !== 'landed').map(m => (
                    <div key={m.key} className="min-w-0"><dt className="text-xs text-fg-subtle">{m.label}</dt><dd className="tabular-nums">{m.cell(v)}</dd></div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}

      {footer}
      <RateHistory history={sheet.history} currency={currency} />
    </div>
  );
}

function RateHistory({ history, currency }: { history: Sheet['history']; currency: string }) {
  const [open, setOpen] = useState(false);
  if (!history.length) return <p className="text-sm text-fg-subtle" data-testid="compare-history-empty">{t('proc.cmp.historyEmpty')}</p>;
  const byVendor = new Map<string, { name: string; rows: Sheet['history'] }>();
  for (const h of history) {
    const g = byVendor.get(h.vendorId) ?? { name: h.vendorName, rows: [] };
    g.rows.push(h);
    byVendor.set(h.vendorId, g);
  }
  return (
    <section className="rounded-lg border border-border" data-testid="compare-history" aria-labelledby="rate-history-h">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 id="rate-history-h" className="text-sm font-medium">{t('proc.cmp.history')}</h3>
        <Button variant="ghost" size="sm" onClick={() => setOpen(o => !o)} aria-expanded={open} data-testid="compare-history-toggle">{open ? t('proc.cmp.hideOrders') : t('proc.cmp.showOrders')}</Button>
      </div>
      <ul className="divide-y divide-border">
        {[...byVendor.entries()].map(([id, g]) => {
          const rows = [...g.rows].sort((a, b) => a.date.localeCompare(b.date));
          const first = rows[0]!; const last = rows[rows.length - 1]!;
          const delta = num(last.rate) - num(first.rate);
          return (
            <li key={id} className="px-3 py-2.5" data-testid={`compare-history-${id}`}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="min-w-40 font-medium">{g.name}</span>
                <Sparkline values={rows.map(r => num(r.rate))} className={delta > 0 ? 'text-danger' : 'text-success'}
                  label={t('proc.cmp.trend', { from: fmtRate(first.rate, currency), to: fmtRate(last.rate, currency) })} />
                <span className="text-sm tabular-nums">{t('proc.cmp.lastRate', { rate: fmtRate(last.rate, currency), date: fmtShortDate(last.date) })}</span>
                <span className={cn('text-xs tabular-nums', delta > 0 ? 'text-danger' : delta < 0 ? 'text-success' : 'text-fg-subtle')}>
                  {delta === 0 ? t('proc.cmp.flat') : t(delta > 0 ? 'proc.cmp.up' : 'proc.cmp.down', { pct: fmtPct(Math.abs(delta / (num(first.rate) || 1)) * 100), n: rows.length })}
                </span>
              </div>
              {open && (
                <table className="mt-2 w-full max-w-lg text-sm">
                  <thead className="text-xs text-fg-subtle"><tr><th scope="col" className="text-left font-medium">{t('proc.cmp.po')}</th><th scope="col" className="text-left font-medium">{t('proc.cmp.date')}</th><th scope="col" className="text-right font-medium">{t('proc.cmp.rate')}</th></tr></thead>
                  <tbody>
                    {[...rows].reverse().map(r => (
                      <tr key={r.poNumber + r.date} className="border-t border-border"><td className="py-1 tabular-nums">{r.poNumber}</td><td className="py-1">{fmtDate(r.date)}</td><td className="py-1 text-right tabular-nums">{fmtRate(r.rate, currency)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
