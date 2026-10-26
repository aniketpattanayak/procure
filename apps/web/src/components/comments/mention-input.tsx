'use client';
import { cn, Textarea } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '@/i18n';
import { http } from '@/lib/api';
import { useDebounced } from '@/lib/use-debounced';
import { MENTION_RE } from './mention-text';

interface UserOption { id: string; name: string; email: string }
export interface Mention { id: string; name: string }

/** Draft text shows `@Name`; `serializeMentions` turns those into `@[Name](user:<id>)` for the API. */
export function serializeMentions(text: string, mentions: Mention[]): string {
  let out = text;
  const byLength = [...mentions].sort((a, b) => b.name.length - a.name.length);
  for (const m of byLength) {
    const esc = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\[])@${esc}(?![\\w])`, 'g'), (_s, pre: string) => `${pre}@[${m.name}](user:${m.id})`);
  }
  return out;
}

/** Stored body -> editable draft + the mentions it contains. */
export function deserializeMentions(body: string): { text: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  const text = body.replace(MENTION_RE, (_m, name: string, id: string) => { mentions.push({ id, name }); return `@${name}`; });
  return { text, mentions };
}

/**
 * Textarea with @mention autocomplete (users from `/users/options`). Typing `@` plus letters opens a listbox; Up/Down
 * move, Enter or Tab picks, Escape closes. Picked users are tracked so the body can be serialised on submit.
 */
export function MentionInput({ value, onChange, mentions, onMentionsChange, onSubmit, placeholder, disabled, label, testId = 'comment-input', rows = 3 }: {
  value: string;
  onChange: (v: string) => void;
  mentions: Mention[];
  onMentionsChange: (m: Mention[]) => void;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  label: string;
  testId?: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const dq = useDebounced(query?.q ?? '', 150);
  const users = useQuery({
    queryKey: ['users-options', dq],
    queryFn: ({ signal }) => http.get<UserOption[]>('/users/options', { q: dq || undefined, limit: 8 }, signal),
    enabled: query !== null,
    staleTime: 60_000,
  });
  const options = (users.data ?? []).slice(0, 8);
  const open = query !== null && (options.length > 0 || users.isFetching);

  function detect(text: string, caret: number) {
    const before = text.slice(0, caret);
    const m = before.match(/(^|\s)@([\p{L}\p{N}._-]{0,30})$/u);
    if (m) { setQuery({ q: m[2]!, start: caret - m[2]!.length - 1 }); setActive(0); } else setQuery(null);
  }

  function pick(u: UserOption) {
    if (!query) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const insert = `@${u.name} `;
    const next = value.slice(0, query.start) + insert + value.slice(caret);
    onChange(next);
    if (!mentions.some(m => m.id === u.id)) onMentionsChange([...mentions, { id: u.id, name: u.name }]);
    setQuery(null);
    const pos = query.start + insert.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && options.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % options.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + options.length) % options.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[active]!); return; }
    }
    if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(null); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmit) { e.preventDefault(); onSubmit(); }
  }

  return (
    <div className="relative">
      <Textarea
        ref={ref}
        rows={rows}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${options[active]!.id}` : undefined}
        onChange={e => { onChange(e.target.value); detect(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
        onKeyDown={onKeyDown}
        onClick={e => detect(value, (e.target as HTMLTextAreaElement).selectionStart ?? 0)}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
        data-testid={testId}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={t('comments.mentionList')} className="absolute left-0 top-full z-40 mt-1 max-h-60 w-72 max-w-full overflow-y-auto rounded border border-border bg-surface py-1 shadow-pop">
          {users.isFetching && !options.length && <li className="px-3 py-2 text-sm text-fg-muted">{t('common.loading')}</li>}
          {options.map((u, i) => (
            <li key={u.id} id={`${listId}-${u.id}`} role="option" aria-selected={i === active}
              onMouseDown={e => { e.preventDefault(); pick(u); }} onMouseEnter={() => setActive(i)}
              className={cn('cursor-pointer px-3 py-1.5', i === active && 'bg-accent-soft')} data-testid="mention-option">
              <span className="block font-medium">{u.name}</span>
              <span className="block truncate text-xs text-fg-subtle">{u.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
