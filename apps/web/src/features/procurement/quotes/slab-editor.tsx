'use client';
import { Button, cn, Input, NativeSelect } from '@procure/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { t } from '@/i18n';
import { effectiveRate, fmtRate, num, slabAt, slabIssues, type SlabLike } from '../calc';

export interface SlabDraft { fromQty: string; toQty: string; mode: 'rate' | 'discount'; value: string }

export function slabsToInput(rows: SlabDraft[]): SlabLike[] {
  return rows.map(r => ({
    fromQty: r.fromQty.trim() || '0',
    ...(r.toQty.trim() ? { toQty: r.toQty.trim() } : {}),
    ...(r.mode === 'rate' ? { rate: r.value.trim() } : { discountPct: r.value.trim() }),
  }));
}
export function slabsFromInput(rows: SlabLike[] | undefined): SlabDraft[] {
  return (rows ?? []).map(s => ({
    fromQty: s.fromQty, toQty: s.toQty ?? '',
    mode: s.rate !== undefined && s.rate !== '' ? 'rate' : 'discount',
    value: (s.rate !== undefined && s.rate !== '' ? s.rate : s.discountPct) ?? '',
  }));
}

/** Quantity slabs with a live "rate at qty" preview and a step chart of the price curve. */
export function SlabEditor({ value, onChange, baseRate, qty, uom, currency }: {
  value: SlabDraft[];
  onChange: (v: SlabDraft[]) => void;
  baseRate: string;
  qty: string;
  uom: string;
  currency: string;
}) {
  const id = useId();
  const [previewQty, setPreviewQty] = useState(qty || '1');
  const slabs = useMemo(() => slabsToInput(value), [value]);
  const issues = slabIssues(slabs);
  const q = num(previewQty);
  const applied = slabAt(slabs, q);
  const eff = effectiveRate(baseRate, slabs, q);
  const set = (i: number, patch: Partial<SlabDraft>) => onChange(value.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const add = () => {
    const last = value[value.length - 1];
    const nextFrom = last ? (last.toQty ? String(num(last.toQty) + 1) : String(num(last.fromQty) + 1000)) : '0';
    onChange([...value, { fromQty: nextFrom, toQty: '', mode: 'discount', value: '' }]);
  };

  return (
    <div className="space-y-3" data-testid="slab-editor">
      {value.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('proc.slab.none')}</p>
      ) : (
        <div>
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_minmax(0,1fr)_2rem] gap-2 pb-1 text-xs text-fg-subtle sm:grid" aria-hidden>
            <span>{t('proc.slab.from', { uom })}</span><span>{t('proc.slab.to', { uom })}</span><span>{t('proc.slab.pricing')}</span><span>{t('proc.slab.value')}</span><span />
          </div>
          <ol className="space-y-2 sm:space-y-1">
            {value.map((r, i) => {
              const on = !!applied && slabs[i] === applied;
              return (
                <li key={i} data-testid={`slab-row-${i}`} data-applies={on ? 'true' : undefined}
                  className={cn('grid grid-cols-2 gap-2 rounded p-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_minmax(0,1fr)_2rem] sm:items-center', on && 'bg-accent-soft/60', 'max-sm:border max-sm:border-border')}>
                  <Input inputMode="decimal" className="h-8" value={r.fromQty} placeholder={t('proc.slab.from', { uom })} onChange={e => set(i, { fromQty: e.target.value })} aria-label={t('proc.slab.fromN', { n: i + 1 })} aria-invalid={issues[i] === 'range' || issues[i] === 'overlap' || undefined} data-testid={`slab-from-${i}`} />
                  <Input inputMode="decimal" className="h-8" value={r.toQty} placeholder={t('proc.slab.andAbove')} onChange={e => set(i, { toQty: e.target.value })} aria-label={t('proc.slab.toN', { n: i + 1 })} aria-invalid={issues[i] === 'range' || undefined} data-testid={`slab-to-${i}`} />
                  <NativeSelect className="h-8" value={r.mode} onChange={e => set(i, { mode: e.target.value as SlabDraft['mode'] })} aria-label={t('proc.slab.pricingN', { n: i + 1 })} data-testid={`slab-mode-${i}`}>
                    <option value="rate">{t('proc.slab.mode.rate')}</option>
                    <option value="discount">{t('proc.slab.mode.discount')}</option>
                  </NativeSelect>
                  <div className="flex items-center gap-1 sm:contents">
                    <div className="relative min-w-0 flex-1">
                      <Input inputMode="decimal" className="h-8 pr-10" value={r.value} onChange={e => set(i, { value: e.target.value })} aria-label={t('proc.slab.valueN', { n: i + 1 })} aria-invalid={issues[i] === 'value' || undefined} data-testid={`slab-value-${i}`} />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-fg-subtle">{r.mode === 'rate' ? currency : '%'}</span>
                    </div>
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, k) => k !== i))} aria-label={t('proc.slab.removeN', { n: i + 1 })} data-testid={`slab-del-${i}`}><Trash2 aria-hidden /></Button>
                  </div>
                </li>
              );
            })}
          </ol>
          {Object.keys(issues).length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-danger" data-testid="slab-error">
              {Object.entries(issues).map(([i, kind]) => <li key={i}>{t(`proc.slab.issue.${kind}` as 'proc.slab.issue.range', { n: Number(i) + 1 })}</li>)}
            </ul>
          )}
        </div>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={add} data-testid="slab-add"><Plus aria-hidden />{t('proc.slab.add')}</Button>

      {value.length > 0 && (
        <div className="grid gap-3 rounded border border-border bg-subtle p-3 sm:grid-cols-[12rem_minmax(0,1fr)]" data-testid="slab-preview">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-pq`} className="text-xs text-fg-muted">{t('proc.slab.previewAt')}</label>
            <div className="flex items-center gap-1.5">
              <Input id={`${id}-pq`} inputMode="decimal" className="h-8 w-28" value={previewQty} onChange={e => setPreviewQty(e.target.value)} data-testid="slab-preview-qty" />
              <span className="text-sm text-fg-muted">{uom}</span>
            </div>
            <p className="text-lg font-semibold tabular-nums" data-testid="slab-preview-rate" data-value={eff.toFixed(2)}>{fmtRate(eff, currency)}<span className="ml-1 text-sm font-normal text-fg-muted">/ {uom || t('proc.unit')}</span></p>
            <p className="text-xs text-fg-muted" aria-live="polite">
              {applied ? t('proc.slab.applies', { from: applied.fromQty, to: applied.toQty ?? '∞' }) : t('proc.slab.baseApplies')}
              {' · '}{t('proc.slab.total', { amount: fmtRate(eff * q, currency) })}
            </p>
          </div>
          <SlabCurve baseRate={num(baseRate)} slabs={slabs} at={q} currency={currency} />
        </div>
      )}
    </div>
  );
}

/** Step chart: rate (y) against quantity (x), marker at the preview qty. */
function SlabCurve({ baseRate, slabs, at, currency }: { baseRate: number; slabs: SlabLike[]; at: number; currency: string }) {
  const W = 320; const H = 84; const P = 6;
  const breaks = [...new Set([0, ...slabs.flatMap(s => [num(s.fromQty), s.toQty ? num(s.toQty) + 1 : null]).filter((x): x is number => x !== null)])].sort((a, b) => a - b);
  const maxX = Math.max(at * 1.15, (breaks[breaks.length - 1] ?? 0) * 1.35, 10);
  const pts = breaks.filter(x => x <= maxX).map(x => ({ x, r: effectiveRate(baseRate, slabs, x) }));
  const rates = pts.map(p => p.r).concat(effectiveRate(baseRate, slabs, at));
  const lo = Math.min(...rates) * 0.97; const hi = Math.max(...rates) * 1.02 || 1;
  const sx = (x: number) => P + (x / maxX) * (W - P * 2);
  const sy = (r: number) => H - P - ((r - lo) / (hi - lo || 1)) * (H - P * 2);
  let d = '';
  pts.forEach((p, i) => {
    const next = pts[i + 1]?.x ?? maxX;
    d += `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.r).toFixed(1)} L${sx(next).toFixed(1)},${sy(p.r).toFixed(1)} `;
  });
  const atR = effectiveRate(baseRate, slabs, at);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full text-accent" role="img" preserveAspectRatio="none">
      <title>{t('proc.slab.curve', { rate: fmtRate(atR, currency), qty: String(at) })}</title>
      <line x1={P} x2={W - P} y1={H - P} y2={H - P} className="stroke-border" strokeWidth={1} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {at > 0 && at <= maxX && (
        <>
          <line x1={sx(at)} x2={sx(at)} y1={P} y2={H - P} className="stroke-fg-subtle" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <circle cx={sx(at)} cy={sy(atR)} r={3.5} className="fill-accent" />
        </>
      )}
    </svg>
  );
}
