'use client';
import { useId, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when label is an icon or abbreviated. */
  ariaLabel?: string;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  title?: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  /** Accessible group label. */
  label: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

const toneOn: Record<NonNullable<SegmentedOption<string>['tone']>, string> = {
  neutral: 'peer-checked:bg-surface peer-checked:text-fg peer-checked:shadow-sm',
  accent: 'peer-checked:bg-accent peer-checked:text-accent-fg',
  success: 'peer-checked:bg-success-soft peer-checked:text-success peer-checked:ring-1 peer-checked:ring-success/40',
  warning: 'peer-checked:bg-warning-soft peer-checked:text-warning peer-checked:ring-1 peer-checked:ring-warning/40',
  danger: 'peer-checked:bg-danger-soft peer-checked:text-danger peer-checked:ring-1 peer-checked:ring-danger/40',
};

/** Segmented control built on native radios: arrow keys move the choice, one tab stop, works with screen readers. */
export function Segmented<T extends string>({ value, onChange, options, label, size = 'sm', disabled, className, ...rest }: SegmentedProps<T>) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex shrink-0 rounded bg-muted p-0.5', disabled && 'opacity-60', className)} data-testid={rest['data-testid']}>
      {options.map(o => (
        <label key={o.value} className="relative" title={o.title}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
            aria-label={o.ariaLabel}
            className="peer sr-only"
            data-testid={rest['data-testid'] ? `${rest['data-testid']}-${o.value}` : undefined}
          />
          <span
            className={cn(
              'flex cursor-pointer items-center justify-center whitespace-nowrap rounded-sm font-medium text-fg-muted transition-colors hover:text-fg',
              'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-ring peer-disabled:cursor-not-allowed',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              toneOn[o.tone ?? 'neutral'],
            )}
          >
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}
