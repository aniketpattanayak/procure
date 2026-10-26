'use client';
import { Checkbox, cn, Input, Label, NativeSelect, Switch, Textarea } from '@procure/ui';
import { useId, useState, type ReactNode } from 'react';

/** Small labelled property controls for the builder's properties panel (data-testid = prop-<name>). */

export function PropRow({ label, hint, children, htmlFor, error }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string; error?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-fg-subtle">{hint}</p>}
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}

export function TextProp({ name, label, value, onChange, hint, disabled, placeholder, multiline, mono, error, maxLength }: {
  name: string; label: ReactNode; value: string | undefined; onChange: (v: string) => void; hint?: ReactNode; disabled?: boolean; placeholder?: string; multiline?: boolean; mono?: boolean; error?: string; maxLength?: number;
}) {
  const id = useId();
  const common = {
    id, value: value ?? '', disabled, placeholder, maxLength, 'data-testid': `prop-${name}`, 'aria-invalid': error ? true : undefined,
    className: cn('h-8', mono && 'font-mono text-sm'),
  };
  return (
    <PropRow label={label} hint={hint} htmlFor={id} error={error}>
      {multiline ? <Textarea {...common} className={cn('min-h-16 text-sm', mono && 'font-mono')} onChange={e => onChange(e.target.value)} /> : <Input {...common} onChange={e => onChange(e.target.value)} />}
    </PropRow>
  );
}

export function NumberProp({ name, label, value, onChange, min, max, step, hint, disabled, placeholder }: {
  name: string; label: ReactNode; value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; hint?: ReactNode; disabled?: boolean; placeholder?: string;
}) {
  const id = useId();
  return (
    <PropRow label={label} hint={hint} htmlFor={id}>
      <Input id={id} type="number" inputMode="decimal" className="h-8" value={value ?? ''} min={min} max={max} step={step ?? 'any'} disabled={disabled} placeholder={placeholder}
        onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} data-testid={`prop-${name}`} />
    </PropRow>
  );
}

export function BoolProp({ name, label, value, onChange, hint, disabled, toggle }: { name: string; label: ReactNode; value: boolean | undefined; onChange: (v: boolean) => void; hint?: ReactNode; disabled?: boolean; toggle?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      {toggle ? (
        <Switch id={id} checked={!!value} disabled={disabled} onCheckedChange={onChange} data-testid={`prop-${name}`} className="mt-0.5" />
      ) : (
        <Checkbox id={id} checked={!!value} disabled={disabled} onCheckedChange={c => onChange(c === true)} data-testid={`prop-${name}`} className="mt-0.5" />
      )}
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-normal">{label}</Label>
        {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
      </div>
    </div>
  );
}

export function SelectProp<T extends string>({ name, label, value, onChange, options, hint, disabled }: {
  name: string; label: ReactNode; value: T | undefined; onChange: (v: T) => void; options: { value: T; label: string }[]; hint?: ReactNode; disabled?: boolean;
}) {
  const id = useId();
  return (
    <PropRow label={label} hint={hint} htmlFor={id}>
      <NativeSelect id={id} className="h-8 text-sm" value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value as T)} data-testid={`prop-${name}`}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </NativeSelect>
    </PropRow>
  );
}

/** Collapsible group in the properties panel. */
export function PropGroup({ title, children, defaultOpen = true, testId }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string }) {
  // Open state is owned here: `defaultOpen` only seeds it (a changing prop must not collapse a group mid-edit).
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group border-b border-border" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-semibold marker:hidden hover:bg-subtle [&::-webkit-details-marker]:hidden">
        {title}
        <span aria-hidden className="text-fg-subtle transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="space-y-3 px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}
