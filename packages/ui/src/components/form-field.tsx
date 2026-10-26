'use client';
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Label } from './label';

export interface FormFieldProps {
  label: ReactNode;
  /** Single control; receives id, aria-invalid and aria-describedby. */
  children: ReactElement<Record<string, unknown>>;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  id?: string;
}

/** Label + control + hint + error text, wired for screen readers. */
export function FormField({ label, children, error, hint, required, className, id }: FormFieldProps) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: fieldId,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        'aria-required': required || undefined,
      })
    : children;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={fieldId}>
        {label}
        {required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
      </Label>
      {control}
      {hint && !error && <p id={hintId} className="text-xs text-fg-subtle">{hint}</p>}
      {error && <p id={errorId} role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}
