'use client';
import type { DocTypeSummary, DocumentLineRow, DocumentRow } from '@procure/schema';
import { cn } from '@procure/ui';
import { useEffect } from 'react';
import { t } from '@/i18n';
import { dec, fmtQty } from './decimal';
import { refLabel } from './form-model';
import type { DocLineColumn } from './extensions';
import { DocStatusBadge, PendingPill, QtyCell } from './status';

export function lineItemLabel(l: DocumentLineRow): string {
  return refLabel(l.refs, 'item', l.values.item) ?? (typeof l.values.description === 'string' ? l.values.description : null) ?? t('docs.lineN', { n: l.lineNo });
}
export function lineUom(l: DocumentLineRow): string {
  return refLabel(l.refs, 'uom', l.values.uom) ?? '';
}

/** Where a line's remaining qty sits: "HOD approval: 300 pending, 20 held". */
function StageSpots({ line, stageNames }: { line: DocumentLineRow; stageNames: Record<string, string> }) {
  const spots = Object.entries(line.stages ?? {}).filter(([, v]) => dec.gt0(v.pending) || dec.gt0(v.held));
  if (!spots.length) return <span className="text-fg-subtle">—</span>;
  return (
    <ul className="space-y-0.5">
      {spots.map(([k, v]) => (
        <li key={k} className="text-xs" data-testid={`line-stage-${line.lineNo}-${k}`}>
          <span className="text-fg-muted">{stageNames[k] ?? k}: </span>
          {dec.gt0(v.pending) && <span className="font-medium text-accent tabular-nums">{t('docs.qty.nPending', { n: fmtQty(v.pending) })}</span>}
          {dec.gt0(v.pending) && dec.gt0(v.held) && ', '}
          {dec.gt0(v.held) && <span className="font-medium text-warning tabular-nums">{t('docs.qty.nHeld', { n: fmtQty(v.held) })}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Lines with quantity buckets (requested / approved / held / rejected / cancelled / pending) and per-stage spots. */
export function LinesTable({ doc, docType, extraColumns = [] }: { doc: DocumentRow; docType: DocTypeSummary; extraColumns?: DocLineColumn[] }) {
  const stageNames = Object.fromEntries((doc.workflow?.stages ?? []).map(s => [s.key, s.name]));
  const lines = [...doc.lines].sort((a, b) => a.lineNo - b.lineNo);
  const showStages = !!doc.workflow;

  // Deep link from the item-wise list: #line-<n>
  useEffect(() => {
    const m = window.location.hash.match(/^#line-(\d+)$/);
    if (!m) return;
    const el = document.getElementById(`line-${m[1]}`);
    el?.scrollIntoView({ block: 'center' });
  }, []);

  if (!lines.length) return <p className="rounded border border-dashed border-border px-3 py-6 text-center text-fg-muted">{t('docs.noLines')}</p>;

  return (
    <>
      {/* Wide screens: table */}
      {/* A11Y8-003: a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
      <div tabIndex={0} className="hidden overflow-x-auto rounded border border-border md:block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <table className="w-full text-base" data-testid="doc-lines">
          <thead className="bg-subtle text-sm text-fg-muted">
            <tr>
              <th scope="col" className="w-10 px-3 py-2 text-right font-medium">#</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('docs.col.item')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('docs.qty.requested')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('docs.qty.approved')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('docs.qty.held')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('docs.qty.rejected')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('docs.qty.cancelled')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('docs.qty.pending')}</th>
              {showStages && <th scope="col" className="px-3 py-2 text-left font-medium">{t('docs.col.where')}</th>}
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('docs.col.status')}</th>
              {extraColumns.map(c => <th key={c.key} scope="col" className={cn('px-3 py-2 font-medium', c.align === 'right' ? 'text-right' : 'text-left')}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id} id={`line-${l.lineNo}`} className="border-t border-border target:bg-accent-soft" data-testid={`doc-line-${l.lineNo}`}>
                <td className="px-3 py-2.5 text-right text-sm text-fg-subtle tabular-nums">{l.lineNo}</td>
                <td className="max-w-72 px-3 py-2.5">
                  <p className="truncate font-medium">{lineItemLabel(l)}</p>
                  {l.cancelledReason && <p className="truncate text-xs text-fg-subtle">{t('docs.cancelledBecause', { reason: l.cancelledReason })}</p>}
                </td>
                <td className="px-3 py-2.5 text-right"><QtyCell value={l.qty.requested} testId={`qty-requested-${l.lineNo}`} /> <span className="text-xs text-fg-subtle">{lineUom(l)}</span></td>
                <td className="px-3 py-2.5 text-right"><QtyCell value={l.qty.approved} tone="success" testId={`qty-approved-${l.lineNo}`} /></td>
                <td className="px-3 py-2.5 text-right"><QtyCell value={l.qty.held} tone="warning" testId={`qty-held-${l.lineNo}`} /></td>
                <td className="px-3 py-2.5 text-right"><QtyCell value={l.qty.rejected} tone="danger" testId={`qty-rejected-${l.lineNo}`} /></td>
                <td className="px-3 py-2.5 text-right"><QtyCell value={l.qty.cancelled} testId={`qty-cancelled-${l.lineNo}`} /></td>
                <td className="px-3 py-2.5 text-right"><PendingPill value={l.qty.pendingApproval} testId={`qty-pending-${l.lineNo}`} /></td>
                {showStages && <td className="px-3 py-2.5"><StageSpots line={l} stageNames={stageNames} /></td>}
                <td className="px-3 py-2.5"><DocStatusBadge statusKey={l.statusKey} label={docType.statuses.find(s => s.key === l.statusKey)?.label ?? l.statusKey} docType={docType} /></td>
                {extraColumns.map(c => <td key={c.key} className={cn('px-3 py-2.5', c.align === 'right' && 'text-right')}>{c.cell(l)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: one card per line */}
      <ul className="space-y-2 md:hidden" data-testid="doc-lines-cards">
        {lines.map(l => (
          <li key={l.id} id={`line-${l.lineNo}-m`} className="rounded border border-border bg-surface p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 font-medium"><span className="mr-1.5 text-sm text-fg-subtle tabular-nums">{l.lineNo}</span>{lineItemLabel(l)}</p>
              <DocStatusBadge statusKey={l.statusKey} label={docType.statuses.find(s => s.key === l.statusKey)?.label ?? l.statusKey} docType={docType} />
            </div>
            <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm">
              <Bucket label={t('docs.qty.requested')} value={l.qty.requested} suffix={lineUom(l)} />
              <Bucket label={t('docs.qty.approved')} value={l.qty.approved} tone="text-success" />
              <Bucket label={t('docs.qty.pending')} value={l.qty.pendingApproval} tone="text-warning" />
              <Bucket label={t('docs.qty.held')} value={l.qty.held} tone="text-warning" />
              <Bucket label={t('docs.qty.rejected')} value={l.qty.rejected} tone="text-danger" />
              <Bucket label={t('docs.qty.cancelled')} value={l.qty.cancelled} />
            </dl>
            {showStages && <div className="mt-2 border-t border-border pt-2"><StageSpots line={l} stageNames={stageNames} /></div>}
            {extraColumns.length > 0 && (
              <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1.5 border-t border-border pt-2 text-sm">
                {extraColumns.map(c => <div key={c.key} className="min-w-0"><dt className="text-xs text-fg-subtle">{c.label}</dt><dd className="tabular-nums">{c.cell(l)}</dd></div>)}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function Bucket({ label, value, tone, suffix }: { label: string; value: string; tone?: string; suffix?: string }) {
  const zero = dec.isZero(value);
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className={cn('tabular-nums font-medium', zero ? 'text-fg-subtle' : tone)}>{fmtQty(value)}{suffix ? <span className="ml-1 text-xs font-normal text-fg-subtle">{suffix}</span> : null}</dd>
    </div>
  );
}
