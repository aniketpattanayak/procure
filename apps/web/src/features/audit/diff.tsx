'use client';
import { cn, Segmented } from '@procure/ui';
import { useMemo, useState } from 'react';
import { t } from '@/i18n';

export type ChangeKind = 'added' | 'removed' | 'changed' | 'same';
export interface DiffRow { path: string; kind: ChangeKind; before: unknown; after: unknown }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isScalarArray = (v: unknown) => Array.isArray(v) && v.every(x => x === null || typeof x !== 'object');

/**
 * Flatten before/after into per-key rows. Objects recurse (`a.b`); arrays of objects recurse by index (`lines.2.qty`);
 * arrays of scalars compare as one value. Keys present on one side only are added/removed.
 */
export function diffValues(before: unknown, after: unknown, prefix = ''): DiffRow[] {
  if (isObj(before) || isObj(after)) {
    const b = isObj(before) ? before : {};
    const a = isObj(after) ? after : {};
    if (!isObj(before) && before !== null && before !== undefined) return [{ path: prefix || '(value)', kind: 'changed', before, after }];
    if (!isObj(after) && after !== null && after !== undefined) return [{ path: prefix || '(value)', kind: 'changed', before, after }];
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    return keys.flatMap(k => {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!(k in b)) return [{ path: p, kind: 'added' as const, before: undefined, after: a[k] }];
      if (!(k in a)) return [{ path: p, kind: 'removed' as const, before: b[k], after: undefined }];
      return diffValues(b[k], a[k], p);
    });
  }
  if (Array.isArray(before) && Array.isArray(after) && !isScalarArray(before) && !isScalarArray(after)) {
    const n = Math.max(before.length, after.length);
    return Array.from({ length: n }, (_, i) => {
      const p = prefix ? `${prefix}.${i}` : String(i);
      if (i >= before.length) return [{ path: p, kind: 'added' as const, before: undefined, after: after[i] }];
      if (i >= after.length) return [{ path: p, kind: 'removed' as const, before: before[i], after: undefined }];
      return diffValues(before[i], after[i], p);
    }).flat();
  }
  const same = JSON.stringify(before) === JSON.stringify(after);
  return [{ path: prefix || '(value)', kind: same ? 'same' : before === undefined || before === null ? (after === undefined || after === null ? 'same' : 'added') : after === undefined || after === null ? 'removed' : 'changed', before, after }];
}

function show(v: unknown): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 1);
}

const KIND_STYLE: Record<ChangeKind, string> = {
  added: 'border-l-success bg-success-soft/50',
  removed: 'border-l-danger bg-danger-soft/50',
  changed: 'border-l-warning bg-warning-soft/50',
  same: 'border-l-transparent',
};

/** Before/after viewer: one row per key, changed keys highlighted (and marked in text, not by colour alone). */
export function DiffViewer({ before, after }: { before: unknown; after: unknown }) {
  const rows = useMemo(() => diffValues(before ?? null, after ?? null), [before, after]);
  const changed = rows.filter(r => r.kind !== 'same');
  const [mode, setMode] = useState<'changes' | 'all'>(changed.length ? 'changes' : 'all');
  const visible = mode === 'changes' ? changed : rows;
  if (before == null && after == null) return <p className="text-sm text-fg-muted" data-testid="audit-diff">{t('auditlog.noData')}</p>;
  return (
    <div className="space-y-2" data-testid="audit-diff" data-changes={changed.length}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{t('auditlog.changedN', { n: changed.length, total: rows.length })}</p>
        <Segmented<'changes' | 'all'> value={mode} onChange={setMode} label={t('auditlog.diffShow')} data-testid="audit-diff-mode"
          options={[{ value: 'changes', label: t('auditlog.onlyChanges') }, { value: 'all', label: t('auditlog.allKeys') }]} />
      </div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full min-w-[32rem] text-sm">
          <thead className="bg-subtle text-left text-xs text-fg-muted">
            <tr>
              <th className="w-1/3 px-3 py-1.5 font-medium">{t('auditlog.key')}</th>
              <th className="px-3 py-1.5 font-medium">{t('auditlog.before')}</th>
              <th className="px-3 py-1.5 font-medium">{t('auditlog.after')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.path} className={cn('border-t border-border border-l-4 align-top', KIND_STYLE[r.kind])} data-testid={`audit-diff-key-${r.path}`} data-change={r.kind}>
                <td className="px-3 py-1.5 font-mono text-xs">
                  <span className="break-all">{r.path}</span>
                  {r.kind !== 'same' && <span className="block font-sans text-xs font-medium text-fg-muted">{t(`auditlog.kind.${r.kind}` as 'auditlog.kind.added')}</span>}
                </td>
                <td className={cn('px-3 py-1.5 font-mono text-xs', r.kind === 'changed' || r.kind === 'removed' ? 'text-danger line-through decoration-danger/40' : 'text-fg-muted')}>
                  <pre className="whitespace-pre-wrap break-all">{show(r.before)}</pre>
                </td>
                <td className={cn('px-3 py-1.5 font-mono text-xs', r.kind === 'changed' || r.kind === 'added' ? 'font-semibold text-fg' : 'text-fg-muted')}>
                  <pre className="whitespace-pre-wrap break-all">{show(r.after)}</pre>
                </td>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan={3} className="px-3 py-3 text-center text-fg-muted">{t('auditlog.noChanges')}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
