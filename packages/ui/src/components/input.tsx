import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

// A11Y8-002: Chrome keeps :focus-visible off a date/time input while focus is in its inner segments, so those
// types also show the ring on :focus (WCAG 2.4.7).
export const inputClass =
  'flex h-9 w-full rounded border border-border-strong bg-surface px-3 text-base text-fg placeholder:text-fg-subtle transition-colors focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring [&[type^=date]:focus]:outline [&[type^=date]:focus]:outline-2 [&[type^=date]:focus]:outline-ring [&[type=time]:focus]:outline [&[type=time]:focus]:outline-2 [&[type=time]:focus]:outline-ring disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-70 aria-[invalid=true]:border-danger';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input type={type} className={cn(inputClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(inputClass, 'h-auto min-h-20 py-2', className)} {...props} />;
}

/** Native select: best for forms (keyboard + mobile pickers for free). */
export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <select className={cn(inputClass, 'appearance-none bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pr-8', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23707885' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}
      {...props}
    >
      {children}
    </select>
  );
}
