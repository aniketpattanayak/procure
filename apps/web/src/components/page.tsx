import type { ReactNode } from 'react';
import { cn } from '@procure/ui';

export function PageHeader({ title, description, actions, back, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {back && <div className="mb-1.5">{back}</div>}
        <h1 className="truncate text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6', className)}>{children}</div>;
}

/** Definition list for read-only detail panels. */
export function DetailList({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-sm text-fg-muted">{it.label}</dt>
          <dd className="mt-0.5 break-words">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InlineAlert({ tone = 'danger', children, className, ...rest }: { tone?: 'danger' | 'warning' | 'info' | 'success'; children: ReactNode; className?: string; 'data-testid'?: string }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={rest['data-testid']}
      className={cn(
        'rounded border px-3 py-2.5 text-base',
        tone === 'danger' && 'border-danger/30 bg-danger-soft text-danger',
        tone === 'warning' && 'border-warning/30 bg-warning-soft text-warning',
        tone === 'info' && 'border-accent/25 bg-accent-soft text-accent',
        tone === 'success' && 'border-success/30 bg-success-soft text-success',
        className,
      )}
    >
      {children}
    </div>
  );
}
