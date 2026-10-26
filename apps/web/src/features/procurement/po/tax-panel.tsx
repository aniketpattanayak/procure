'use client';
import type { DocumentRow, TaxLine } from '@procure/schema';
import { Badge, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert } from '@/components/page';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { lineItemLabel } from '@/features/documents/lines-table';
import { procApi, procKeys } from '../api';
import { fmtPct, fmtRate, num } from '../calc';

const COMPONENTS: TaxLine['component'][] = ['cgst', 'sgst', 'igst', 'cess'];

/** GST breakdown per PO line (CGST + SGST within the state, IGST across states) with document totals. */
export function PoTaxPanel({ doc }: { doc: DocumentRow }) {
  const { currency: tenantCurrency } = useTenantLocale();
  const currency = typeof doc.values.currency === 'string' && doc.values.currency.length === 3 ? doc.values.currency : tenantCurrency;
  const q = useQuery({ queryKey: procKeys.taxes(doc.id), queryFn: () => procApi.taxes(doc.id), retry: false });
  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.isError) return <InlineAlert>{isApiError(q.error) ? q.error.message : t('po.tax.failed')}</InlineAlert>;
  const data = q.data!;
  const lines = [...doc.lines].sort((a, b) => a.lineNo - b.lineNo);
  const entries = Object.values(data.lines);
  const taxesOf = (id: string, i: number) => data.lines[id] ?? entries[i] ?? [];
  const used = COMPONENTS.filter(c => lines.some((l, i) => taxesOf(l.id, i).some(x => x.component === c)) || num(data.totals[c]) > 0);
  const interState = used.includes('igst') && !used.includes('cgst');
  const totalsRows: { key: keyof typeof data.totals; label: string; strong?: boolean }[] = [
    { key: 'taxable', label: t('po.tax.taxable') },
    ...used.map(c => ({ key: c, label: t(`po.tax.${c}` as 'po.tax.cgst') })),
    ...(data.totals.freight !== undefined ? [{ key: 'freight' as const, label: t('po.tax.freight') }] : []),
    ...(data.totals.otherCharges !== undefined ? [{ key: 'otherCharges' as const, label: t('po.tax.other') }] : []),
    ...(data.totals.discount !== undefined ? [{ key: 'discount' as const, label: t('po.tax.discount') }] : []),
    { key: 'grand', label: t('po.tax.grand'), strong: true },
  ];

  return (
    <div className="space-y-3" data-testid="po-tax-panel">
      {used.length === 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <Badge tone="neutral" data-testid="po-tax-mode" data-mode="none">{t('po.tax.none')}</Badge>{t('po.tax.noneHint')}
        </p>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
          <Badge tone={interState ? 'warning' : 'accent'} data-testid="po-tax-mode" data-mode={interState ? 'igst' : 'cgst_sgst'}>{interState ? t('po.tax.inter') : t('po.tax.intra')}</Badge>
          {interState ? t('po.tax.interHint') : t('po.tax.intraHint')}
        </p>
      )}
      {/* Phones: one card per line */}
      <ul className="space-y-2 md:hidden">
        {lines.map((l, i) => {
          const tx = taxesOf(l.id, i);
          const taxable = tx[0]?.taxableAmount ?? (typeof l.values.amount === 'string' ? l.values.amount : '0');
          return (
            <li key={l.id} className="rounded border border-border p-3">
              <p className="truncate font-medium"><span className="mr-1.5 text-sm text-fg-subtle tabular-nums">{l.lineNo}</span>{lineItemLabel(l)}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <div><dt className="text-xs text-fg-subtle">{t('po.tax.taxable')}</dt><dd className="tabular-nums">{fmtRate(taxable, currency)}</dd></div>
                {tx.map(x => <div key={x.component}><dt className="text-xs text-fg-subtle">{t(`po.tax.${x.component}` as 'po.tax.cgst')} @{fmtPct(x.ratePct)}</dt><dd className="tabular-nums">{fmtRate(x.taxAmount, currency)}</dd></div>)}
              </dl>
            </li>
          );
        })}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
        <table className="w-full min-w-[36rem] text-base">
          <thead className="bg-subtle text-sm text-fg-muted">
            <tr>
              <th scope="col" className="w-10 px-3 py-2 text-right font-medium">#</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('docs.col.item')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('po.tax.taxable')}</th>
              {used.map(c => <th key={c} scope="col" className="px-3 py-2 text-right font-medium">{t(`po.tax.${c}` as 'po.tax.cgst')}</th>)}
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('po.tax.lineTax')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const tx = taxesOf(l.id, i);
              const taxable = tx[0]?.taxableAmount ?? (typeof l.values.amount === 'string' ? l.values.amount : '0');
              const sum = tx.reduce((s, x) => s + num(x.taxAmount), 0);
              return (
                <tr key={l.id} className="border-t border-border" data-testid={`po-tax-line-${l.lineNo}`}>
                  <td className="px-3 py-2 text-right text-sm text-fg-subtle tabular-nums">{l.lineNo}</td>
                  <td className="max-w-64 truncate px-3 py-2">{lineItemLabel(l)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtRate(taxable, currency)}</td>
                  {used.map(c => {
                    const x = tx.find(y => y.component === c);
                    return (
                      <td key={c} className="px-3 py-2 text-right tabular-nums" data-testid={`po-tax-${c}-${l.lineNo}`} data-value={x?.taxAmount ?? '0'}>
                        {x ? <>{fmtRate(x.taxAmount, currency)} <span className="text-xs text-fg-subtle">@{fmtPct(x.ratePct)}</span></> : <span className="text-fg-subtle">—</span>}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{fmtRate(sum, currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <dl className="ml-auto w-full max-w-sm space-y-1 rounded-lg border border-border p-3" data-testid="po-tax-totals">
        {totalsRows.map(r => (
          <div key={r.key} className={r.strong ? 'flex justify-between border-t border-border pt-2 font-semibold' : 'flex justify-between text-sm'} data-testid={`po-tax-total-${r.key}`} data-value={data.totals[r.key] ?? '0'}>
            <dt className={r.strong ? '' : 'text-fg-muted'}>{r.label}</dt>
            <dd className="tabular-nums">{fmtRate(data.totals[r.key] ?? '0', currency)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
