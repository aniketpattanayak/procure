'use client';
import type { FormDefinition, FormDefinitionIssue } from '@procure/schema';
import { cn } from '@procure/ui';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { t } from '@/i18n';
import type { Selection } from './state';

/** 'fields.5.columns.2.expr' -> { key, col } using the definition the issue was computed for. */
export function selectionForPath(def: FormDefinition, path: string): Selection | null {
  const m = path.match(/^fields\.(\d+)(?:\.columns\.(\d+))?/);
  if (!m) return null;
  const f = def.fields[Number(m[1])];
  if (!f) return null;
  if (m[2] !== undefined && f.type === 'grid') {
    const c = f.columns[Number(m[2])];
    return c ? { key: f.key, col: c.key } : { key: f.key };
  }
  return { key: f.key };
}

export function labelForPath(def: FormDefinition, path: string): string {
  const s = selectionForPath(def, path);
  if (!s) return t('fb.issues.form');
  const f = def.fields.find(x => x.key === s.key);
  const fl = f && 'label' in f && f.label ? f.label : s.key;
  if (s.col && f?.type === 'grid') return `${fl} › ${f.columns.find(c => c.key === s.col)?.label ?? s.col}`;
  return fl;
}

export function IssuesList({ def, issues, checking, onSelect }: { def: FormDefinition; issues: FormDefinitionIssue[]; checking: boolean; onSelect: (s: Selection) => void }) {
  return (
    <section aria-labelledby="issues-heading" data-testid="builder-issues" data-count={issues.length}>
      <h2 id="issues-heading" className="flex items-center gap-2 px-4 pb-1.5 pt-3 text-sm font-semibold">
        {issues.length ? <AlertCircle className="size-4 text-danger" aria-hidden /> : <CheckCircle2 className="size-4 text-success" aria-hidden />}
        {issues.length ? t('fb.issues.count', { n: issues.length }) : t('fb.issues.none')}
        {checking && <Loader2 className="size-3.5 animate-spin text-fg-subtle" aria-label={t('fb.issues.checking')} />}
      </h2>
      {issues.length > 0 && (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto px-2 pb-2">
          {issues.map((i, n) => {
            const sel = selectionForPath(def, i.path);
            return (
              <li key={`${i.path}-${i.code}-${n}`}>
                <button
                  type="button"
                  disabled={!sel}
                  onClick={() => sel && onSelect(sel)}
                  className={cn('w-full rounded px-2 py-1.5 text-left text-sm hover:bg-danger-soft focus-visible:outline-2 focus-visible:outline-ring', !sel && 'cursor-default')}
                  data-testid="builder-issue"
                  data-code={i.code}
                >
                  <span className="block text-xs font-medium text-fg-muted">{labelForPath(def, i.path)}</span>
                  <span className="text-danger">{i.message}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
