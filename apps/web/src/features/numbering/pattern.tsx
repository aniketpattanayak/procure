'use client';
import { cn, Input } from '@procure/ui';
import { useId, useRef } from 'react';
import { t } from '@/i18n';
import { useMe } from '@/lib/permissions';

export const TOKENS = ['{PREFIX}', '{LOC}', '{FY}', '{FYS}', '{YYYY}', '{YY}', '{MM}', '{SEQ:4}'] as const;

export interface PreviewContext { prefix?: string; loc?: string | null; date?: Date; fyStartMonth?: number; seq?: number }

/** Fiscal year containing `d` for a year starting in `startMonth` (1–12): [startYear, endYear]. */
export function fiscalYear(d: Date, startMonth: number): [number, number] {
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  const start = startMonth <= 1 ? y : m >= startMonth ? y : y - 1;
  return [start, startMonth <= 1 ? start : start + 1];
}

/** Client-side rendering of a numbering pattern (the server is the source of truth: see /config/numbering/:id/preview). */
export function renderPattern(pattern: string, ctx: PreviewContext = {}): string {
  const d = ctx.date ?? new Date();
  const [fy1, fy2] = fiscalYear(d, ctx.fyStartMonth ?? 4);
  const two = (n: number) => String(n % 100).padStart(2, '0');
  const fy = fy1 === fy2 ? String(fy1) : `${fy1}-${two(fy2)}`;
  const fys = fy1 === fy2 ? two(fy1) : `${two(fy1)}-${two(fy2)}`;
  return pattern
    .replace(/\{PREFIX\}/g, (ctx.prefix ?? 'DOC').toUpperCase())
    .replace(/\{LOC\}/g, ctx.loc ?? 'LOC')
    .replace(/\{FY\}/g, fy)
    .replace(/\{FYS\}/g, fys)
    .replace(/\{YYYY\}/g, String(d.getFullYear()))
    .replace(/\{YY\}/g, two(d.getFullYear()))
    .replace(/\{MM\}/g, String(d.getMonth() + 1).padStart(2, '0'))
    .replace(/\{SEQ:([1-9])\}/g, (_, n: string) => String(ctx.seq ?? 1).padStart(Number(n), '0'));
}

export function patternProblem(p: string): string | null {
  if (!p.trim()) return t('num.pattern.required');
  if (!/\{SEQ:[1-9]\}/.test(p)) return t('num.pattern.needSeq');
  const unknown = p.match(/\{[^}]*\}/g)?.find(tok => !/^\{(PREFIX|LOC|FY|FYS|YYYY|YY|MM|SEQ:[1-9])\}$/.test(tok));
  if (unknown) return t('num.pattern.unknownToken', { token: unknown });
  if (p.length > 80) return t('num.pattern.tooLong');
  return null;
}

export function useFyStartMonth(): number {
  const v = useMe()?.settings?.['tenant.fy_start_month'];
  return typeof v === 'number' && v >= 1 && v <= 12 ? v : 4;
}

/** Pattern input with token chips that insert at the cursor, plus a live preview line. */
export function PatternEditor({ value, onChange, testId, previewCtx, label, error, describe }: {
  value: string; onChange: (v: string) => void; testId: string; previewCtx: PreviewContext; label: string; error?: string | null; describe?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const problem = error ?? patternProblem(value);
  function insert(token: string) {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    // One sequence per pattern: the chip moves the cursor to the existing one instead of adding a second.
    const seqAt = value.search(/\{SEQ:[1-9]\}/);
    if (token.startsWith('{SEQ') && seqAt >= 0) { el?.focus(); el?.setSelectionRange(seqAt, seqAt + 7); return; }
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next.slice(0, 80));
    requestAnimationFrame(() => { el?.focus(); const p = start + token.length; el?.setSelectionRange(p, p); });
  }
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <Input ref={ref} id={id} value={value} onChange={e => onChange(e.target.value)} maxLength={80} className="font-mono" spellCheck={false}
        aria-invalid={problem ? true : undefined} aria-describedby={`${id}-preview ${id}-help`} data-testid={testId} />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('num.pattern.tokens')}>
        {TOKENS.map(tok => (
          <button key={tok} type="button" onClick={() => insert(tok)} title={t(`num.token.${tok.replace(/[{}]|:4/g, '')}` as 'num.token.LOC')}
            className="rounded border border-border bg-subtle px-2 py-0.5 font-mono text-xs text-fg-muted hover:border-accent hover:bg-accent-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-ring"
            data-testid={`${testId}-token-${tok.replace(/[{}]/g, '').replace(':', '-')}`}>
            {tok}
          </button>
        ))}
      </div>
      <p id={`${id}-help`} className="text-xs text-fg-subtle">{describe ?? t('num.pattern.help')}</p>
      <div id={`${id}-preview`} className={cn('flex items-baseline gap-2 rounded border px-3 py-2', problem ? 'border-danger/30 bg-danger-soft' : 'border-border bg-subtle')} aria-live="polite">
        <span className="text-xs text-fg-muted">{problem ? t('num.pattern.fix') : t('num.pattern.preview')}</span>
        {problem
          ? <span className="text-sm text-danger" data-testid={`${testId}-error`}>{problem}</span>
          : <span className="font-mono text-md font-semibold tracking-wide" data-testid={`${testId}-preview`}>{renderPattern(value, previewCtx)}</span>}
      </div>
    </div>
  );
}
