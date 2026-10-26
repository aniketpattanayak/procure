import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('rounded-lg border border-border bg-surface', className)} {...props} />;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3.5', className)}>
      <div className="min-w-0">
        <h2 className="text-md font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function CardBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}
