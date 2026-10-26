'use client';
import { cn } from '@procure/ui';
import { t } from '@/i18n';
import { dec, fmtQty } from '@/features/documents/decimal';
import { num } from '../calc';

export type MeterState = 'empty' | 'under' | 'exact' | 'over' | 'blocked';

const SEG = ['bg-accent', 'bg-accent/60', 'bg-accent/35', 'bg-fg-muted/60', 'bg-fg-muted/35'];

/**
 * Stacked bar: each allocation as a segment against the available qty. Unallocated space is hatched; anything past
 * the available qty is drawn in red past a marker line. The text line carries the same facts (colour is never the
 * only signal).
 */
export function AllocationMeter({ parts, available, uom, state, testId, overAllowed }: {
  parts: { label: string; qty: string }[];
  available: string;
  uom: string;
  state: MeterState;
  testId?: string;
  /** Extra qty permitted above available (over-approval), drawn as a dashed zone. */
  overAllowed?: string | null;
}) {
  const avail = num(available);
  const total = parts.reduce((s, p) => s + num(p.qty), 0);
  const scale = Math.max(avail + num(overAllowed ?? 0), total, 1);
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / scale) * 100))}%`;
  let acc = 0;
  const totalS = dec.add(...parts.map(p => p.qty));
  const leftS = dec.sub(available, totalS);
  return (
    <div className="space-y-1" data-testid={testId} data-state={state} data-total={totalS}>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-[repeating-linear-gradient(135deg,rgb(var(--c-muted))_0_4px,rgb(var(--c-subtle))_4px_8px)]" aria-hidden>
        {overAllowed && num(overAllowed) > 0 && (
          <div className="absolute inset-y-0 border-l border-dashed border-warning bg-warning-soft" style={{ left: pct(avail), width: pct(num(overAllowed)) }} />
        )}
        {parts.map((p, i) => {
          const start = acc; acc += num(p.qty);
          const within = Math.max(0, Math.min(acc, avail) - start);
          const over = Math.max(0, acc - Math.max(start, avail));
          return (
            <span key={i}>
              {within > 0 && <span className={cn('absolute inset-y-0', SEG[i % SEG.length])} style={{ left: pct(start), width: pct(within) }} title={`${p.label}: ${fmtQty(p.qty)}`} />}
              {over > 0 && <span className={cn('absolute inset-y-0', state === 'blocked' ? 'bg-danger' : 'bg-warning-bar')} style={{ left: pct(Math.max(start, avail)), width: pct(over) }} />}
            </span>
          );
        })}
        <span className="absolute inset-y-0 w-px bg-fg" style={{ left: pct(avail) }} />
      </div>
      <p className={cn('text-xs tabular-nums', state === 'blocked' ? 'font-medium text-danger' : state === 'over' ? 'font-medium text-warning' : state === 'exact' ? 'text-success' : 'text-fg-muted')} aria-live="polite">
        {state === 'empty' && t('proc.meter.empty', { avail: fmtQty(available), uom })}
        {state === 'under' && t('proc.meter.under', { total: fmtQty(totalS), avail: fmtQty(available), left: fmtQty(leftS), uom })}
        {state === 'exact' && t('proc.meter.exact', { total: fmtQty(totalS), uom })}
        {(state === 'over' || state === 'blocked') && t('proc.meter.over', { total: fmtQty(totalS), avail: fmtQty(available), over: fmtQty(dec.sub(totalS, available)), uom })}
      </p>
    </div>
  );
}
