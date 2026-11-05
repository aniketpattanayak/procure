'use client';
import { cn, inputClass } from '@procure/ui';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/i18n';

export interface ComboOption { value: string; label: string; secondary?: string; inactive?: boolean }

export interface ComboboxProps {
  id?: string;
  options: ComboOption[];
  /** Currently selected options (labels needed for display). */
  selected: ComboOption[];
  multiple?: boolean;
  onSelect: (o: ComboOption) => void;
  onRemove: (value: string) => void;
  onClear?: () => void;
  /** Async mode: the parent filters by query (debounced) and passes `options`. */
  query?: string;
  onQueryChange?: (q: string) => void;
  onOpenChange?: (open: boolean) => void;
  loading?: boolean;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  emptyText?: string;
  errorText?: string | null;
  compact?: boolean;
  testId?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  'aria-label'?: string;
}

/** WAI-ARIA combobox with a listbox popup in a portal (works inside scrolling grids and dialogs). */
export function Combobox(props: ComboboxProps) {
  const {
    id, options, selected, multiple, onSelect, onRemove, onClear, query, onQueryChange, onOpenChange, loading, placeholder, disabled, readOnly,
    emptyText, errorText, compact, testId, ...aria
  } = props;
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;
  const [open, setOpenState] = useState(false);
  const [localQ, setLocalQ] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  // Portal into the enclosing dialog when there is one: Radix modals treat clicks outside their content as
  // "dismiss" and block pointer events on body. Dialog content is transformed, so coordinates are made relative.
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const q = query ?? localQ;
  const setQ = (v: string) => (onQueryChange ? onQueryChange(v) : setLocalQ(v));
  const filtered = onQueryChange ? options : options.filter(o => !q || `${o.label} ${o.secondary ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const selectedSet = new Set(selected.map(s => s.value));

  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
    if (!o) setQ('');
  };

  useLayoutEffect(() => {
    if (!open) return;
    const host = (wrapRef.current?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body;
    setContainer(host);
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      // A transformed ancestor becomes the containing block of `position: fixed`; otherwise the viewport is.
      const cs = host === document.body ? null : getComputedStyle(host);
      const contained = !!cs && (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' || cs.contain.includes('paint'));
      const c = contained ? host.getBoundingClientRect() : { left: 0, top: 0 };
      const below = window.innerHeight - r.bottom;
      const up = below < 260 && r.top > below;
      setRect({ left: r.left - c.left, top: (up ? r.top : r.bottom) - c.top, width: Math.max(r.width, 220), up });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => { setActive(0); }, [q, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function choose(o: ComboOption) {
    if (multiple && selectedSet.has(o.value)) onRemove(o.value);
    else onSelect(o);
    if (!multiple) {
      setOpen(false);
    } else {
      setQ('');
      inputRef.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (disabled || readOnly) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (!open) setOpen(true);
      else setActive(a => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      setActive(a => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && filtered[active]) { e.preventDefault(); choose(filtered[active]!); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    } else if (e.key === 'Backspace' && multiple && !q && selected.length) {
      onRemove(selected[selected.length - 1]!.value);
    }
  }

  const single = !multiple ? selected[0] : undefined;
  const showValueAsText = !multiple && !open && single;

  return (
    <div ref={wrapRef} className="relative" data-testid={testId}>
      <div
        className={cn(
          inputClass,
          'h-auto min-h-9 flex-wrap items-center gap-1 py-1 pr-14',
          // A11Y8-004: the inner <input> is outline-none, so the wrapper shows the focus ring (WCAG 2.4.7)
          'focus-within:outline focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-ring',
          compact && 'min-h-8 rounded-none border-transparent bg-transparent focus-within:border-accent focus-within:outline-1 focus-within:-outline-offset-1',
          (disabled || readOnly) && 'cursor-not-allowed bg-subtle',
          aria['aria-invalid'] && 'border-danger',
        )}
        onClick={() => { if (!disabled && !readOnly) { setOpen(true); inputRef.current?.focus(); } }}
      >
        {multiple && selected.map(s => (
          <span key={s.value} className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-sm">
            <span className="truncate">{s.label}</span>
            {!disabled && !readOnly && (
              <button type="button" className="rounded-sm text-fg-subtle hover:text-fg" aria-label={t('fr.combo.remove', { label: s.label })} onClick={e => { e.stopPropagation(); onRemove(s.value); }}>
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered[active] ? `${inputId}-opt-${active}` : undefined}
          autoComplete="off"
          disabled={disabled}
          readOnly={readOnly}
          className="min-w-[4rem] flex-1 bg-transparent py-0.5 outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed"
          placeholder={showValueAsText ? undefined : (multiple && selected.length ? '' : placeholder)}
          value={showValueAsText ? single!.label : q}
          onChange={e => { setQ(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => { /* open on click/typing, not focus, so Tab moves through grids quickly */ }}
          onKeyDown={onKey}
          {...aria}
        />
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1">
        {loading && open && <Loader2 className="size-4 animate-spin text-fg-subtle" aria-hidden />}
        {!multiple && single && onClear && !disabled && !readOnly && (
          <button type="button" className="pointer-events-auto rounded p-0.5 text-fg-subtle hover:text-fg" aria-label={t('fr.combo.clear')} onClick={e => { e.stopPropagation(); onClear(); }}>
            <X className="size-3.5" />
          </button>
        )}
        <ChevronDown className="size-4 text-fg-subtle" aria-hidden />
      </div>
      {open && rect && container && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable={multiple || undefined}
          className="fixed z-[60] max-h-64 overflow-auto rounded border border-border bg-surface p-1 shadow-pop animate-pop-in"
          style={{ left: rect.left, width: rect.width, top: rect.up ? rect.top - 4 : rect.top + 4, transform: rect.up ? 'translateY(-100%)' : undefined, pointerEvents: 'auto' }}
          data-testid={testId ? `${testId}-options` : undefined}
        >
          {errorText ? (
            <li className="px-2 py-2 text-sm text-danger" role="presentation">{errorText}</li>
          ) : loading && filtered.length === 0 ? (
            <li className="px-2 py-2 text-sm text-fg-muted" role="presentation">{t('common.loading')}…</li>
          ) : filtered.length === 0 ? (
            <li className="px-2 py-2 text-sm text-fg-muted" role="presentation">{emptyText ?? t('fr.combo.empty')}</li>
          ) : filtered.map((o, i) => {
            const isSel = selectedSet.has(o.value);
            return (
              <li
                key={o.value}
                id={`${inputId}-opt-${i}`}
                data-index={i}
                role="option"
                aria-selected={isSel}
                onMouseDown={e => e.preventDefault()}
                onClick={() => choose(o)}
                onMouseEnter={() => setActive(i)}
                className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-base', i === active && 'bg-muted', o.inactive && 'text-fg-subtle')}
                data-testid={testId ? `${testId}-option` : 'lookup-option'}
                data-value={o.value}
              >
                <Check className={cn('size-4 shrink-0 text-accent', !isSel && 'invisible')} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.secondary && <span className="shrink-0 text-xs text-fg-subtle">{o.secondary}</span>}
                {o.inactive && <span className="shrink-0 text-xs text-fg-subtle">{t('fr.inactive')}</span>}
              </li>
            );
          })}
        </ul>,
        container,
      )}
    </div>
  );
}
