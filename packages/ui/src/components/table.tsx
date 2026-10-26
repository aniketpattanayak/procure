import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** Plain semantic table for small, non-virtualised lists. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-base', className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('bg-subtle', className)} {...props} />;
}
export function TBody(props: ComponentProps<'tbody'>) {
  return <tbody {...props} />;
}
export function TR({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('border-b border-border last:border-0', className)} {...props} />;
}
export function TH({ className, ...props }: ComponentProps<'th'>) {
  return <th scope="col" className={cn('h-9 whitespace-nowrap px-3 text-left text-sm font-medium text-fg-muted', className)} {...props} />;
}
export function TD({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />;
}
