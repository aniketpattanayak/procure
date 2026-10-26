'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Combobox, type ComboOption } from '@/engines/form-renderer/combobox';
import { fetchOptions } from '@/engines/form-renderer/lookup-api';
import { t } from '@/i18n';
import { useDebounced } from '@/lib/use-debounced';

export interface PickedOption { id: string; code?: string; name: string }

/** Single-select lookup over a master (`/masters/:key/options`), with optional fixed suggestions shown first. */
export function MasterPicker({ masterKey, value, onChange, placeholder, testId, ariaLabel, invalid, compact, suggestions = [], disabled, id }: {
  masterKey: string;
  value: PickedOption | null;
  onChange: (v: PickedOption | null) => void;
  placeholder?: string;
  testId?: string;
  ariaLabel: string;
  invalid?: boolean;
  compact?: boolean;
  /** Shown before search results (e.g. vendors who quoted). */
  suggestions?: (PickedOption & { hint?: string })[];
  disabled?: boolean;
  id?: string;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [open, setOpen] = useState(false);
  const opts = useQuery({
    queryKey: ['master-options', masterKey, dq],
    queryFn: ({ signal }) => fetchOptions({ kind: 'master', masterKey }, { q: dq, limit: 20, signal }),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const seen = new Set<string>();
  const options: ComboOption[] = [];
  for (const s of suggestions) {
    if (dq && !`${s.name} ${s.code ?? ''}`.toLowerCase().includes(dq.toLowerCase())) continue;
    seen.add(s.id);
    options.push({ value: s.id, label: s.name, secondary: s.hint ?? s.code });
  }
  for (const o of opts.data ?? []) if (!seen.has(o.id)) options.push({ value: o.id, label: o.name, secondary: o.code, inactive: !o.isActive });
  const lookup = new Map([...suggestions.map(s => [s.id, s] as const), ...(opts.data ?? []).map(o => [o.id, { id: o.id, code: o.code, name: o.name }] as const)]);
  return (
    <Combobox
      id={id}
      options={options}
      selected={value ? [{ value: value.id, label: value.name, secondary: value.code }] : []}
      onSelect={o => onChange(lookup.get(o.value) ?? { id: o.value, name: o.label })}
      onRemove={() => onChange(null)}
      onClear={() => onChange(null)}
      query={q}
      onQueryChange={setQ}
      onOpenChange={setOpen}
      loading={opts.isFetching}
      placeholder={placeholder ?? t('proc.pick.search')}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      errorText={opts.isError ? t('proc.pick.error') : null}
      compact={compact}
      disabled={disabled}
      testId={testId}
    />
  );
}
