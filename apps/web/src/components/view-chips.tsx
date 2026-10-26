'use client';
import { cn } from '@procure/ui';
import { useEffect } from 'react';
import { perm, usePermissions } from '@/lib/permissions';

export interface ViewOption<T extends string> { value: T; label: string }

/**
 * Status view chips for a list. Only views the user holds (`<tab>:view.<value>`) are shown; when the current value
 * isn't permitted it falls back to the first permitted view (the server does the same). Renders nothing for 0 views.
 */
export function ViewChips<T extends string>({ tab, options, value, onChange, label, testId = 'view-chips', extra }: {
  tab: string;
  options: ViewOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  testId?: string;
  /** Options that don't need a view key (e.g. "All" when every view is permitted). */
  extra?: ViewOption<T>[];
}) {
  const p = usePermissions();
  const allowed = options.filter(o => p.has(perm.view(tab, o.value)));
  const shown = [...allowed, ...(extra && allowed.length === options.length ? extra : [])];
  const first = shown[0]?.value;
  useEffect(() => {
    if (first && !shown.some(o => o.value === value)) onChange(first);
  }, [first, value, shown, onChange]);
  // A single permitted view still shows its chip, so the user can tell the list is filtered.
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5" data-testid={testId}>
      {shown.map(o => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            data-testid={`${testId}-${o.value}`}
            className={cn(
              'h-8 rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              on ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-muted hover:text-fg',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** First view of `options` the user may see (for initial state). */
export function useDefaultView<T extends string>(tab: string, options: readonly T[], fallback: T): T {
  const p = usePermissions();
  return options.find(v => p.has(perm.view(tab, v))) ?? fallback;
}
