import { cn } from '../lib/cn';

/** Usage meter: amber from 80%, red at 100%. `max` null = unlimited. */
export function UsageBar({ used, max, label, className }: { used: number; max: number | null; label: string; className?: string }) {
  const pct = max === null ? 0 : max === 0 ? (used > 0 ? 100 : 0) : Math.min(100, (used / max) * 100);
  const level = max === null ? 'ok' : pct >= 100 ? 'full' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max ?? undefined}
      aria-valuenow={used}
      aria-valuetext={max === null ? `${used}, unlimited` : `${used} of ${max}`}
      data-level={level}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width]', level === 'full' ? 'bg-danger' : level === 'warn' ? 'bg-warning-bar' : 'bg-accent')}
        style={{ width: max === null ? '0%' : `${pct}%` }}
      />
    </div>
  );
}

export function usageLevel(used: number, max: number | null): 'ok' | 'warn' | 'full' {
  if (max === null) return 'ok';
  const pct = max === 0 ? (used > 0 ? 100 : 0) : (used / max) * 100;
  return pct >= 100 ? 'full' : pct >= 80 ? 'warn' : 'ok';
}
