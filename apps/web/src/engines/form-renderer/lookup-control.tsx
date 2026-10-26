'use client';
import type { OptionRow } from '@procure/schema';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { Combobox, type ComboOption } from './combobox';
import { useRenderer, type FieldScope } from './context';
import { fetchOptions, type LookupSourceDef } from './lookup-api';
import { isEmpty } from './values';

interface LookupLike {
  key: string;
  type: 'lookup' | 'multilookup';
  label: string;
  placeholder?: string;
  source: LookupSourceDef;
  display?: string[];
  filterBy?: { field: string; targetField: string }[];
  maxSelected?: number;
}

export interface LookupControlProps {
  field: LookupLike;
  value: unknown;
  onChange: (v: unknown, option?: OptionRow | null) => void;
  scope: FieldScope;
  id: string;
  readOnly?: boolean;
  compact?: boolean;
  testId: string;
  describedBy?: string;
  invalid?: boolean;
  required?: boolean;
  ariaLabel?: string;
}

const sourceKey = (s: LookupSourceDef) => (s.kind === 'master' ? `m:${s.masterKey}` : s.kind);

function toCombo(o: OptionRow, display?: string[]): ComboOption {
  // `label` is built by the server from `display`; show the code as a secondary hint when it isn't already in it.
  const secondary = o.code && !o.label.includes(o.code) && display?.includes('code') ? o.code : undefined;
  return { value: o.id, label: o.label || o.name, secondary, inactive: !o.isActive };
}

/** Async lookup / multilookup with cascading filters, autofill attributes and label hydration. */
export function LookupControl({ field, value, onChange, scope, id, readOnly, compact, testId, describedBy, invalid, required, ariaLabel }: LookupControlProps) {
  const ctx = useRenderer();
  const multiple = field.type === 'multilookup';
  const ids = useMemo(() => (multiple ? (Array.isArray(value) ? (value as string[]) : []) : typeof value === 'string' && value ? [value] : []), [multiple, value]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const dq = useDebounced(q, 250);
  const attrs = ctx.attrsFor(field.key);

  // Cascading parents: grid sibling column first, then header field.
  const parents = (field.filterBy ?? []).map(fb => {
    const inRow = scope.grid && ctx.columnByKey(scope.grid, fb.field);
    const v = inRow ? scope.row?.[fb.field] : ctx.values[fb.field];
    const label = (inRow ? ctx.columnByKey(scope.grid!, fb.field)?.label : ctx.fieldByKey(fb.field)?.label) ?? fb.field;
    return { ...fb, value: v, label };
  });
  const missing = parents.find(p => isEmpty(p.value));
  const filters = parents.map(p => `${p.targetField}:${typeof p.value === 'string' ? p.value : ''}`);

  const options = useQuery({
    queryKey: ['lookup', sourceKey(field.source), dq, filters, attrs],
    queryFn: ({ signal }) => fetchOptions(field.source, { q: dq, filter: filters, attrs, signal }),
    enabled: open && !missing && !readOnly,
    staleTime: 30_000,
  });
  const remember = ctx.rememberOptions;
  useEffect(() => { if (options.data) remember(options.data); }, [options.data, remember]);

  // Hydrate labels/attrs of values we have not seen (existing records, server-side defaults).
  const unknownIds = ids.filter(x => !ctx.optionFor(x) && (attrs.length > 0 || !ctx.labelFromRefs(scopePath(scope, field.key), x)));
  const hydrate = useQuery({
    queryKey: ['lookup-ids', sourceKey(field.source), unknownIds, attrs],
    queryFn: ({ signal }) => fetchOptions(field.source, { include: unknownIds, attrs, limit: Math.min(100, Math.max(unknownIds.length, 1)), filter: [], signal }),
    enabled: unknownIds.length > 0,
    staleTime: 5 * 60_000,
  });
  useEffect(() => { if (hydrate.data) remember(hydrate.data); }, [hydrate.data, remember]);

  const selected: ComboOption[] = ids.map(x => {
    const o = ctx.optionFor(x);
    if (o) return toCombo(o, field.display);
    return { value: x, label: ctx.labelFromRefs(scopePath(scope, field.key), x) ?? (hydrate.isLoading ? '…' : t('fr.lookup.unknown')) };
  });

  const comboOptions = (options.data ?? []).filter(o => o.isActive || ids.includes(o.id)).map(o => toCombo(o, field.display));
  const atMax = multiple && field.maxSelected !== undefined && ids.length >= field.maxSelected;

  const hint = missing ? t('fr.lookup.chooseFirst', { label: missing.label }) : undefined;

  return (
    <div className="space-y-1">
      <Combobox
        id={id}
        multiple={multiple}
        options={atMax ? comboOptions.filter(o => ids.includes(o.value)) : comboOptions}
        selected={selected}
        query={q}
        onQueryChange={setQ}
        onOpenChange={setOpen}
        loading={options.isFetching}
        errorText={options.error ? (isApiError(options.error) ? options.error.message : t('fr.lookup.error')) : null}
        emptyText={dq ? t('fr.lookup.noMatch', { q: dq }) : parents.length ? t('fr.lookup.noneForParent', { label: parents.map(x => x.label).join(', ') }) : t('fr.lookup.none')}
        placeholder={missing ? hint : (field.placeholder ?? t('fr.lookup.placeholder'))}
        disabled={!!missing && ids.length === 0}
        readOnly={readOnly}
        compact={compact}
        testId={testId}
        onSelect={o => {
          const opt = ctx.optionFor(o.value) ?? null;
          if (multiple) onChange([...ids, o.value], opt);
          else onChange(o.value, opt);
        }}
        onRemove={v => (multiple ? onChange(ids.filter(x => x !== v), null) : onChange(null, null))}
        onClear={required ? undefined : () => onChange(null, null)}
        aria-describedby={[describedBy, missing ? `${id}-cascade` : null].filter(Boolean).join(' ') || undefined}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        aria-label={ariaLabel}
      />
      {/* The visible hint is the placeholder; screen readers get it through aria-describedby. */}
      {missing && <span id={`${id}-cascade`} className="sr-only" data-testid={`${testId}-hint`}>{hint}</span>}
    </div>
  );
}

function scopePath(scope: FieldScope, key: string) {
  return scope.grid ? `${scope.grid}.${key}` : key;
}
