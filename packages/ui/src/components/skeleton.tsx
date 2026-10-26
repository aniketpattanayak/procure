import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('animate-[pulse_1.6s_ease-in-out_infinite] rounded bg-muted', className)} {...props} />;
}

/** Wrap a skeleton block so screen readers hear one "Loading" instead of nothing. */
export function SkeletonGroup({ label = 'Loading', className, children }: { label?: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-3 rounded-lg border border-border bg-surface p-5', className)}>
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} className={cn('h-4', i % 2 ? 'w-2/3' : 'w-full')} />)}
    </div>
  );
}
