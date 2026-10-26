'use client';
import { Checkbox, cn, Input, Label, NativeSelect, Switch, Textarea } from '@procure/ui';
import { useId, useState, type ReactNode } from 'react';

/** Labelled property controls for the designer panel (data-testid = wf-prop-<name>). */

export function Row({ label, hint, children, htmlFor, error }: { label: ReactNode; hint?: ReactNode; children: ReactNode; htmlFor?: string; error?: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-fg-subtle">{hint}</p>}
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}

export function TextIn({ name, label, value, onChange, hint, disabled, placeholder, multiline, mono, error, maxLength }: {
  name: string; label: ReactNode; value: string | undefined; onChange: (v: string) => void; hint?: ReactNode; disabled?: boolean; placeholder?: string; multiline?: boolean; mono?: boolean; error?: string | null; maxLength?: number;
}) {
  const id = useId();
  const common = { id, value: value ?? '', disabled, placeholder, maxLength, 'data-testid': `wf-prop-${name}`, 'aria-invalid': error ? true : undefined };
  return (
    <Row label={label} hint={hint} htmlFor={id} error={error}>
      {multiline
        ? <Textarea {...common} rows={2} className={cn('min-h-14 text-sm', mono && 'font-mono')} onChange={e => onChange(e.target.value)} />
        : <Input {...common} className={cn('h-8', mono && 'font-mono text-sm')} onChange={e => onChange(e.target.value)} />}
    </Row>
  );
}

export function NumberIn({ name, label, value, onChange, min, max, hint, disabled, placeholder, suffix }: {
  name: string; label: ReactNode; value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; hint?: ReactNode; disabled?: boolean; placeholder?: string; suffix?: string;
}) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="decimal" className="h-8 w-28" value={value ?? ''} min={min} max={max} step="any" disabled={disabled} placeholder={placeholder}
          onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))} data-testid={`wf-prop-${name}`} />
        {suffix && <span className="text-sm text-fg-muted">{suffix}</span>}
      </div>
    </Row>
  );
}

export function BoolIn({ name, label, value, onChange, hint, disabled, toggle }: { name: string; label: ReactNode; value: boolean | undefined; onChange: (v: boolean) => void; hint?: ReactNode; disabled?: boolean; toggle?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      {toggle
        ? <Switch id={id} checked={!!value} disabled={disabled} onCheckedChange={onChange} data-testid={`wf-prop-${name}`} className="mt-0.5" />
        : <Checkbox id={id} checked={!!value} disabled={disabled} onCheckedChange={c => onChange(c === true)} data-testid={`wf-prop-${name}`} className="mt-0.5" />}
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-normal">{label}</Label>
        {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
      </div>
    </div>
  );
}

export function SelectIn<T extends string>({ name, label, value, onChange, options, hint, disabled, placeholder }: {
  name: string; label: ReactNode; value: T | undefined | ''; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[]; hint?: ReactNode; disabled?: boolean; placeholder?: string;
}) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <NativeSelect id={id} className="h-8 text-sm" value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value as T)} data-testid={`wf-prop-${name}`}>
        {placeholder !== undefined && <option value="" disabled>{placeholder}</option>}
        {options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </NativeSelect>
    </Row>
  );
}

/** A set of checkboxes in a fieldset (data-testid = wf-prop-<name>, each box wf-prop-<name>-<value>). */
export function CheckGroup<T extends string>({ name, legend, hint, options, value, onChange, disabled }: {
  name: string; legend: ReactNode; hint?: ReactNode; options: { value: T; label: string; disabled?: boolean }[]; value: readonly T[]; onChange: (v: T[]) => void; disabled?: boolean;
}) {
  const base = useId();
  return (
    <fieldset className="space-y-1.5" data-testid={`wf-prop-${name}`}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {options.map(o => {
          const id = `${base}-${o.value}`;
          const on = value.includes(o.value);
          return (
            <div key={o.value} className="flex items-center gap-2">
              <Checkbox id={id} checked={on} disabled={disabled || o.disabled}
                onCheckedChange={c => onChange(c === true ? [...value, o.value] : value.filter(v => v !== o.value))}
                data-testid={`wf-prop-${name}-${o.value}`} />
              <Label htmlFor={id} className="text-sm font-normal">{o.label}</Label>
            </div>
          );
        })}
      </div>
      {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
    </fieldset>
  );
}

/** Collapsible group in the panel; `defaultOpen` only seeds the state. */
export function Group({ title, children, defaultOpen = true, testId, badge }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string; badge?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group border-b border-border" data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-semibold marker:hidden hover:bg-subtle [&::-webkit-details-marker]:hidden">
        <span className="flex-1">{title}</span>
        {badge}
        <span aria-hidden className="text-fg-subtle transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="space-y-3 px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}
