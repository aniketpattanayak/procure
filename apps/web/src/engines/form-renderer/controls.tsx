'use client';
import type { DataField, GridColumn, OptionRow } from '@procure/schema';
import { Checkbox, cn, inputClass, Input, NativeSelect, Switch, Textarea } from '@procure/ui';
import { CheckCircle2, Sigma } from 'lucide-react';
import { useState } from 'react';
import { FileUpload, SignaturePad } from '@/components/file-upload';
import { t } from '@/i18n';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Combobox } from './combobox';
import { useRenderer, type FieldScope } from './context';
import { evaluate } from './formula';
import { LookupControl } from './lookup-control';
import { gstinValid, isEmpty, PAN_RE, precisionOf, sanitizeDecimal, toFixedDecimal, formatDecimal, currencySymbol } from './values';

export type ControlField = Exclude<DataField, { type: 'grid' }> | GridColumn;

export interface ControlProps {
  field: ControlField;
  value: unknown;
  onChange: (v: unknown, option?: OptionRow | null) => void;
  onBlur?: () => void;
  scope: FieldScope;
  id: string;
  describedBy?: string;
  invalid?: boolean;
  required?: boolean;
  readOnly?: boolean;
  /** Grid cell: borderless, single line, label only for screen readers. */
  compact?: boolean;
  testId: string;
  ariaLabel?: string;
}

const cellInput = 'h-8 rounded-none border-transparent bg-transparent px-2 focus-visible:outline-1 focus-visible:-outline-offset-1 aria-[invalid=true]:border-danger aria-[invalid=true]:bg-danger-soft/40';

// ----------------------------------------------------------------------------- formula (computed) value

export function ComputedValue({ field, value, error, compact, id, testId }: { field: Extract<ControlField, { type: 'formula' }>; value: unknown; error?: string; compact?: boolean; id: string; testId: string }) {
  let text: string;
  if (value === null || value === undefined || value === '') text = '—';
  else if (field.resultType === 'number') text = formatDecimal(value, field.precision ?? 2);
  else if (field.resultType === 'boolean') text = value === true ? t('fr.yes') : t('fr.no');
  else if (field.resultType === 'date') text = fmtDate(String(value));
  else text = String(value);
  return (
    <output
      id={id}
      aria-live="polite"
      title={field.expr}
      data-testid={testId}
      data-value={value === null || value === undefined ? '' : String(value)}
      className={cn(
        'flex items-center gap-2 rounded border border-dashed border-accent/40 bg-accent-soft/50 px-3 text-fg',
        compact ? 'h-8 rounded-none border-0 bg-accent-soft/40 px-2' : 'h-9',
        field.resultType === 'number' && 'justify-end tabular-nums',
        error && 'border-danger/50 bg-danger-soft/50',
      )}
    >
      {!compact && <Sigma className="size-3.5 shrink-0 text-accent" aria-hidden />}
      <span className={cn('min-w-0 truncate', field.resultType === 'number' && 'ml-auto')}>{error ? <span className="text-danger">{t('fr.formulaError')}</span> : text}</span>
      <span className="sr-only">{t('fr.computed')}</span>
    </output>
  );
}

// ----------------------------------------------------------------------------- number

function NumberInput({ field, value, onChange, onBlur, id, describedBy, invalid, required, readOnly, compact, testId, ariaLabel }: ControlProps & { field: Extract<ControlField, { type: 'number' | 'decimal' | 'currency' | 'percentage' }> }) {
  const { currency } = useRenderer();
  const [focused, setFocused] = useState(false);
  const places = precisionOf(field);
  const raw = value === null || value === undefined ? '' : String(value);
  const cur = field.type === 'currency' ? (field.currency ?? currency) : undefined;
  const display = focused ? raw : formatDecimal(raw, places);
  const allowNegative = field.min === undefined || field.min < 0;
  return (
    <div className="relative">
      {cur && <span className={cn('pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle', compact && 'left-2')} aria-hidden>{currencySymbol(cur)}</span>}
      <Input
        id={id}
        inputMode={places > 0 ? 'decimal' : 'numeric'}
        autoComplete="off"
        value={display}
        readOnly={readOnly}
        placeholder={field.placeholder}
        onFocus={() => setFocused(true)}
        onChange={e => onChange(sanitizeDecimal(e.target.value, allowNegative) || null)}
        onBlur={() => {
          setFocused(false);
          if (raw && raw !== '-' && raw !== '.') onChange(toFixedDecimal(raw, places));
          else if (raw) onChange(null);
          onBlur?.();
        }}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn('text-right tabular-nums', cur && (compact ? 'pl-6' : 'pl-7'), field.type === 'percentage' && 'pr-7', compact && cellInput, readOnly && 'bg-subtle')}
      />
      {field.type === 'percentage' && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden>%</span>}
    </div>
  );
}

// ----------------------------------------------------------------------------- dates

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${v}:00${sign}${p(off / 60)}:${p(off % 60)}`;
}

function useDateBound(expr: string | undefined): string | undefined {
  const { computed, today } = useRenderer();
  if (!expr) return undefined;
  const r = evaluate(expr, { values: computed, today });
  return typeof r.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.value) ? r.value : undefined;
}

function DateInput({ field, value, onChange, onBlur, id, describedBy, invalid, required, readOnly, compact, testId, ariaLabel }: ControlProps & { field: Extract<ControlField, { type: 'date' }> }) {
  const min = useDateBound(field.minDate);
  const max = useDateBound(field.maxDate);
  return (
    <Input type="date" id={id} value={typeof value === 'string' ? value : ''} min={min} max={max} readOnly={readOnly}
      onChange={e => onChange(e.target.value || null)} onBlur={onBlur}
      aria-describedby={describedBy} aria-invalid={invalid || undefined} aria-required={required || undefined} aria-label={ariaLabel}
      data-testid={testId} className={cn(compact && cellInput)} />
  );
}

// ----------------------------------------------------------------------------- text-like with inline validity marks

function TextLike({ field, value, onChange, onBlur, id, describedBy, invalid, required, readOnly, compact, testId, ariaLabel }: ControlProps) {
  const v = typeof value === 'string' ? value : '';
  const upper = field.type === 'gstin' || field.type === 'pan';
  const type = field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'url' ? 'url' : 'text';
  const maxLength = field.type === 'gstin' ? 15 : field.type === 'pan' ? 10 : ('maxLength' in field ? field.maxLength : undefined);
  const valid = (field.type === 'gstin' && gstinValid(v)) || (field.type === 'pan' && PAN_RE.test(v));
  return (
    <div className="relative">
      <Input
        id={id}
        type={type}
        value={v}
        readOnly={readOnly}
        maxLength={maxLength}
        placeholder={'placeholder' in field ? field.placeholder : undefined}
        autoComplete="off"
        spellCheck={upper ? false : undefined}
        onChange={e => onChange(upper ? e.target.value.toUpperCase().replace(/\s/g, '') : e.target.value)}
        onBlur={() => { if (v !== v.trim()) onChange(v.trim()); onBlur?.(); }}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn(upper && 'font-medium tracking-wide', valid && 'pr-8', compact && cellInput)}
      />
      {valid && <CheckCircle2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-success" aria-label={t('fr.validId')} />}
    </div>
  );
}

// ----------------------------------------------------------------------------- dispatcher

export function FieldControl(props: ControlProps) {
  const { field, value, onChange, onBlur, id, describedBy, invalid, required, readOnly, compact, testId, scope, ariaLabel } = props;
  const ctx = useRenderer();
  const common = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid || undefined, 'aria-required': required || undefined, 'aria-label': ariaLabel };

  switch (field.type) {
    case 'formula': {
      const path = scope.grid ? `${scope.grid}.${scope.rowIndex}.${field.key}` : field.key;
      const err = ctx.evalErrors[path] ?? ctx.evalErrors[field.key];
      return <ComputedValue field={field} value={value} error={err?.message} compact={compact} id={id} testId={testId} />;
    }
    case 'text': case 'email': case 'phone': case 'url': case 'gstin': case 'pan': case 'regex':
      return <TextLike {...props} />;
    case 'textarea':
      return compact ? <TextLike {...props} /> : (
        <Textarea {...common} rows={field.rows} value={typeof value === 'string' ? value : ''} readOnly={readOnly} placeholder={field.placeholder}
          maxLength={field.maxLength} onChange={e => onChange(e.target.value)} onBlur={onBlur} data-testid={testId} />
      );
    case 'number': case 'decimal': case 'currency': case 'percentage':
      return <NumberInput {...props} field={field} />;
    case 'date':
      return <DateInput {...props} field={field} />;
    case 'time':
      return <Input type="time" {...common} value={typeof value === 'string' ? value : ''} readOnly={readOnly} onChange={e => onChange(e.target.value || null)} onBlur={onBlur} data-testid={testId} className={cn(compact && cellInput)} />;
    case 'datetime':
      return <Input type="datetime-local" {...common} value={toLocalInput(value as string)} readOnly={readOnly} onChange={e => onChange(fromLocalInput(e.target.value))} onBlur={onBlur} data-testid={testId} className={cn(compact && cellInput)} />;
    case 'daterange': {
      const r = (value && typeof value === 'object' ? value : {}) as { from?: string; to?: string };
      const set = (patch: Partial<{ from: string; to: string }>) => {
        const next = { from: r.from ?? '', to: r.to ?? '', ...patch };
        onChange(next.from || next.to ? next : null);
      };
      return (
        <div className="flex items-center gap-2" role="group" aria-describedby={describedBy} data-testid={testId}>
          <Input type="date" id={id} value={r.from ?? ''} max={r.to || undefined} readOnly={readOnly} onChange={e => set({ from: e.target.value })} onBlur={onBlur} aria-label={t('fr.range.from')} aria-invalid={invalid || undefined} className={cn(compact && cellInput)} />
          <span className="text-fg-subtle" aria-hidden>–</span>
          <Input type="date" value={r.to ?? ''} min={r.from || undefined} readOnly={readOnly} onChange={e => set({ to: e.target.value })} onBlur={onBlur} aria-label={t('fr.range.to')} aria-invalid={invalid || undefined} className={cn(compact && cellInput)} />
        </div>
      );
    }
    case 'select': {
      const opts = field.options.filter(o => !o.inactive || o.value === value);
      return (
        <NativeSelect {...common} value={typeof value === 'string' ? value : ''} disabled={readOnly} onChange={e => onChange(e.target.value || null)} onBlur={onBlur} data-testid={testId} className={cn(compact && cellInput)}>
          <option value="">{field.placeholder ?? t('fr.select.placeholder')}</option>
          {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </NativeSelect>
      );
    }
    case 'multiselect': {
      const vals = Array.isArray(value) ? (value as string[]) : [];
      const opts = field.options.filter(o => !o.inactive || vals.includes(o.value)).map(o => ({ value: o.value, label: o.label }));
      if (!compact && opts.length <= 8) {
        return (
          <fieldset className="flex flex-wrap gap-x-4 gap-y-2 py-1" aria-describedby={describedBy} data-testid={testId} id={id}>
            <legend className="sr-only">{field.label}</legend>
            {opts.map(o => {
              const checked = vals.includes(o.value);
              const atMax = !checked && field.maxSelected !== undefined && vals.length >= field.maxSelected;
              return (
                <label key={o.value} className="inline-flex items-center gap-2 text-base">
                  <Checkbox checked={checked} disabled={readOnly || atMax} onCheckedChange={c => onChange(c ? [...vals, o.value] : vals.filter(x => x !== o.value))} onBlur={onBlur} aria-invalid={invalid || undefined} data-testid={`${testId}-${o.value}`} />
                  {o.label}
                </label>
              );
            })}
          </fieldset>
        );
      }
      return (
        <Combobox id={id} multiple options={opts} selected={opts.filter(o => vals.includes(o.value))} readOnly={readOnly} compact={compact} testId={testId}
          onSelect={o => onChange([...vals, o.value])} onRemove={v => onChange(vals.filter(x => x !== v))}
          aria-describedby={describedBy} aria-invalid={invalid} aria-label={ariaLabel} placeholder={t('fr.select.placeholder')} />
      );
    }
    case 'radio': {
      const opts = field.options.filter(o => !o.inactive || o.value === value);
      return (
        <div role="radiogroup" id={id} aria-describedby={describedBy} aria-required={required || undefined} aria-invalid={invalid || undefined} aria-label={ariaLabel} className={cn('flex flex-wrap gap-x-4 gap-y-2', !compact && 'py-1')} data-testid={testId}>
          {opts.map(o => (
            <label key={o.value} className="inline-flex items-center gap-2 text-base">
              <input type="radio" name={id} value={o.value} checked={value === o.value} disabled={readOnly} onChange={() => onChange(o.value)} onBlur={onBlur}
                className="size-4 accent-[rgb(var(--c-accent))]" data-testid={`${testId}-${o.value}`} />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case 'checkbox':
      return (
        <div className={cn('flex items-center', compact ? 'h-8 justify-center' : 'h-9')}>
          <Checkbox {...common} checked={value === true} disabled={readOnly} onCheckedChange={c => onChange(c === true)} onBlur={onBlur} data-testid={testId} />
        </div>
      );
    case 'toggle':
      return (
        <div className={cn('flex items-center', compact ? 'h-8 justify-center' : 'h-9')}>
          <Switch {...common} checked={value === true} disabled={readOnly} onCheckedChange={c => onChange(c)} data-testid={testId} />
        </div>
      );
    case 'lookup': case 'multilookup':
      return <LookupControl field={field} value={value} onChange={onChange} scope={scope} id={id} readOnly={readOnly} compact={compact} testId={testId} describedBy={describedBy} invalid={invalid} required={required} ariaLabel={ariaLabel} />;
    case 'file': case 'image': case 'files':
      return (
        <FileUpload id={id} fieldKey={scope.grid ? `${scope.grid}.${field.key}` : field.key} formKey={ctx.formKey} value={value as string | string[] | null}
          onChange={v => onChange(v)} multiple={field.type === 'files'} maxFiles={field.maxFiles} accept={field.accept} maxSizeMb={field.maxSizeMb}
          image={field.type === 'image'} metas={ctx.files} onMeta={ctx.rememberFile} readOnly={readOnly}
          aria-describedby={describedBy} aria-invalid={invalid || undefined} />
      );
    case 'signature':
      return <SignaturePad id={id} fieldKey={field.key} formKey={ctx.formKey} value={value as string | null} onChange={v => onChange(v)} meta={typeof value === 'string' ? ctx.files[value] : undefined} onMeta={ctx.rememberFile} readOnly={readOnly} aria-describedby={describedBy} />;
    default:
      return <div className={inputClass}>{String(value ?? '')}</div>;
  }
}

// ----------------------------------------------------------------------------- view mode

/** Read-only presentation of a value (mode="view"). */
export function ReadValue({ field, value, scope, testId }: { field: ControlField; value: unknown; scope: FieldScope; testId: string }) {
  const ctx = useRenderer();
  const empty = <span className="text-fg-subtle">—</span>;
  if (field.type === 'formula') return <ComputedValue field={field} value={value} id={`${testId}-v`} testId={testId} />;
  if (field.type === 'file' || field.type === 'image' || field.type === 'files') {
    return <FileUpload fieldKey={field.key} value={value as string | string[] | null} onChange={() => undefined} multiple={field.type === 'files'} image={field.type === 'image'} metas={ctx.files} onMeta={ctx.rememberFile} readOnly />;
  }
  if (field.type === 'signature') return <SignaturePad fieldKey={field.key} value={value as string | null} onChange={() => undefined} meta={typeof value === 'string' ? ctx.files[value] : undefined} readOnly />;
  if (isEmpty(value)) return <p data-testid={testId}>{empty}</p>;
  let text: string;
  switch (field.type) {
    case 'number': case 'decimal': case 'percentage':
      text = formatDecimal(value, precisionOf(field), { percent: field.type === 'percentage' }); break;
    case 'currency':
      text = formatDecimal(value, precisionOf(field), { currency: field.currency ?? ctx.currency }); break;
    case 'date': text = fmtDate(String(value)); break;
    case 'datetime': text = fmtDateTime(String(value)); break;
    case 'daterange': { const r = value as { from?: string; to?: string }; text = `${fmtDate(r.from)} – ${fmtDate(r.to)}`; break; }
    case 'checkbox': case 'toggle': text = value === true ? t('fr.yes') : t('fr.no'); break;
    case 'select': case 'radio': text = field.options.find(o => o.value === value)?.label ?? String(value); break;
    case 'multiselect': text = (value as string[]).map(v => field.options.find(o => o.value === v)?.label ?? v).join(', '); break;
    case 'lookup': case 'multilookup': {
      const ids = Array.isArray(value) ? (value as string[]) : [value as string];
      const path = scope.grid ? `${scope.grid}.${field.key}` : field.key;
      const labels = ids.map(id => ctx.optionFor(id)?.label ?? ctx.labelFromRefs(path, id));
      // Unknown labels: let the lookup control hydrate them (read-only).
      if (labels.some(l => !l)) return <LookupControl field={field} value={value} onChange={() => undefined} scope={scope} id={`${testId}-v`} readOnly testId={testId} />;
      text = labels.join(', ');
      break;
    }
    default: text = String(value);
  }
  const numeric = ['number', 'decimal', 'currency', 'percentage'].includes(field.type);
  return <p className={cn('min-h-9 break-words py-1.5', numeric && 'tabular-nums')} data-testid={testId}>{field.type === 'url' && /^https?:\/\//i.test(String(value)) ? <a className="text-accent underline-offset-4 hover:underline" href={String(value)} target="_blank" rel="noreferrer">{text}</a> : text}</p>;
}
