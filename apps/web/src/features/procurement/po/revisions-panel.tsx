'use client';
import type { DocumentRow, RevisionDiff, RevisionRow } from '@procure/schema';
import { Badge, cn, Skeleton, type BadgeTone } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { procApi, procKeys } from '../api';

const STATUS_TONE: Record<RevisionRow['status'], BadgeTone> = { open: 'accent', approved: 'success', rejected: 'danger', withdrawn: 'neutral' };
const CHANGE_TONE = { added: 'success', removed: 'danger', changed: 'warning' } as const;

export function revNoOf(doc: DocumentRow): number {
  const r = (doc as DocumentRow & { revNo?: number }).revNo ?? doc.values.rev_no;
  const n = typeof r === 'number' ? r : Number(r ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map(show).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.rows)) return t('po.rev.rowsN', { n: o.rows.length });
    return typeof o.name === 'string' ? o.name : typeof o.label === 'string' ? o.label : JSON.stringify(v);
  }
  if (typeof v === 'boolean') return v ? t('docs.yes') : t('docs.no');
  const str = String(v);
  // Decimal strings from the DB carry their column scale ("39.2000"): trim to 2 places for money-like values.
  if (/^-?\d+\.\d+$/.test(str)) {
    const trimmed = str.replace(/0+$/, '').replace(/\.$/, '');
    const frac = trimmed.split('.')[1];
    return frac && frac.length === 1 ? `${trimmed}0` : trimmed;
  }
  return str;
}

/** PO revisions: list (Rev N, status, reason) and a before/after diff of the chosen revision. */
export function RevisionsPanel({ doc }: { doc: DocumentRow }) {
  const q = useQuery({ queryKey: procKeys.revisions(doc.id), queryFn: () => procApi.revisions(doc.id), retry: false });
  const [sel, setSel] = useState<number | null>(null);
  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.isError) return <InlineAlert>{isApiError(q.error) ? q.error.message : t('po.rev.failed')}</InlineAlert>;
  const rows = [...(q.data ?? [])].sort((a, b) => b.revNo - a.revNo);
  if (!rows.length) return <p className="rounded border border-dashed border-border px-3 py-8 text-center text-fg-muted" data-testid="revision-empty">{t('po.rev.empty')}</p>;
  const current = rows.find(r => r.revNo === sel) ?? rows.find(r => r.diff) ?? rows[0]!;

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]" data-testid="revision-panel">
      <ol className="space-y-1" aria-label={t('po.rev.list')}>
        {rows.map(r => {
          const on = r.revNo === current.revNo;
          return (
            <li key={r.revNo}>
              <button type="button" onClick={() => setSel(r.revNo)} aria-current={on ? 'true' : undefined} data-testid={`revision-row-${r.revNo}`} data-status={r.status}
                className={cn('w-full rounded border px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-ring', on ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-muted')}>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{r.revNo === 0 ? t('po.rev.original') : t('po.rev.n', { n: r.revNo })}</span>
                  <Badge tone={STATUS_TONE[r.status]}>{t(`po.rev.status.${r.status}` as 'po.rev.status.open')}</Badge>
                </span>
                {r.reason && <span className="mt-0.5 block truncate text-sm text-fg-muted">{r.reason}</span>}
                <span className="block text-xs text-fg-subtle">{[r.createdBy, fmtDateTime(r.createdAt)].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <section className="min-w-0" aria-labelledby="rev-diff-h">
        <h3 id="rev-diff-h" className="mb-1 font-semibold">{current.revNo === 0 ? t('po.rev.original') : t('po.rev.diffTitle', { n: current.revNo, prev: current.revNo - 1 === 0 ? t('po.rev.original') : t('po.rev.n', { n: current.revNo - 1 }) })}</h3>
        {current.reason && <p className="mb-3 text-sm text-fg-muted">{t('po.rev.because', { reason: current.reason })}</p>}
        {current.diff ? <DiffView diff={current.diff} /> : <p className="text-sm text-fg-muted" data-testid="revision-diff-none">{current.revNo === 0 ? t('po.rev.originalHint') : t('po.rev.noDiff')}</p>}
      </section>
    </div>
  );
}

function DiffView({ diff }: { diff: RevisionDiff }) {
  const count = diff.header.length + diff.lines.length;
  if (!count) return <p className="text-sm text-fg-muted" data-testid="revision-diff" data-changes={0}>{t('po.rev.noChanges')}</p>;
  return (
    <div className="space-y-4" data-testid="revision-diff" data-changes={count}>
      {diff.header.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <p className="border-b border-border bg-subtle px-3 py-1.5 text-sm font-medium">{t('po.rev.header')}</p>
          <table className="w-full text-base">
            <thead className="sr-only"><tr><th scope="col">{t('po.rev.field')}</th><th scope="col">{t('po.rev.before')}</th><th scope="col">{t('po.rev.after')}</th></tr></thead>
            <tbody>
              {diff.header.map(h => (
                <tr key={h.field} className="border-t border-border first:border-t-0" data-testid={`revision-header-${h.field}`}>
                  <th scope="row" className="w-40 px-3 py-2 text-left text-sm font-normal text-fg-muted">{h.label}</th>
                  <BeforeAfter before={h.before} after={h.after} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {diff.lines.map(l => (
        <div key={`${l.lineNo}-${l.change}`} className={cn('overflow-hidden rounded-lg border', l.change === 'removed' ? 'border-danger/30' : l.change === 'added' ? 'border-success/30' : 'border-border')} data-testid={`revision-line-${l.lineNo}`} data-change={l.change}>
          <p className="flex items-center gap-2 border-b border-border bg-subtle px-3 py-1.5 text-sm">
            <span className="font-medium">{t('po.fu.lineN', { n: l.lineNo })}</span>
            <Badge tone={CHANGE_TONE[l.change]}>
              {l.change === 'added' ? <Plus className="size-3" aria-hidden /> : l.change === 'removed' ? <Minus className="size-3" aria-hidden /> : null}
              {t(`po.rev.change.${l.change}` as 'po.rev.change.added')}
            </Badge>
          </p>
          <table className="w-full text-base">
            <tbody>
              {l.fields.map(f => (
                <tr key={f.field} className="border-t border-border first:border-t-0" data-testid={`revision-field-${l.lineNo}-${f.field}`}>
                  <th scope="row" className="w-40 px-3 py-2 text-left text-sm font-normal text-fg-muted">{f.label}</th>
                  <BeforeAfter before={f.before} after={f.after} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function BeforeAfter({ before, after }: { before: unknown; after: unknown }) {
  const b = show(before); const a = show(after);
  return (
    <td className="px-3 py-2">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
        <del className={cn('decoration-danger/60', b === '—' ? 'text-fg-subtle no-underline' : 'text-fg-muted')} aria-label={t('po.rev.beforeVal', { v: b })}>{b}</del>
        <ArrowRight className="size-3.5 text-fg-subtle" aria-hidden />
        <ins className={cn('no-underline', a === '—' ? 'text-fg-subtle' : 'rounded bg-success-soft px-1 font-medium text-success')} aria-label={t('po.rev.afterVal', { v: a })}>{a}</ins>
      </span>
    </td>
  );
}
