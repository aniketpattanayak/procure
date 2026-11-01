'use client';
/**
 * Procurement panels injected into the generic document screens (indent, vendor_selection, po) through
 * features/documents/extensions. Heavy panels load lazily when their tab opens.
 */
import type { DocumentLineRow, DocumentRow, SettingRow } from '@procure/schema';
import { Badge, Button, Skeleton, toast } from '@procure/ui';
import { CalendarClock, ChevronDown, ChevronUp, FilePenLine, PackagePlus, Scale, Scissors } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { docsApi } from '@/features/documents/api';
import { dec, fmtQty } from '@/features/documents/decimal';
import { registerDocExtension, type DocExtensionContext } from '@/features/documents/extensions';
import { fmtDate } from '@/lib/format';
import { stockApi, STOCK_PERM } from '@/features/stock/api';
import { PageSkeleton } from '@/components/guards';
import { QtyCell } from '@/features/documents/status';
import { t } from '@/i18n';
import { usePermissions } from '@/lib/permissions';
import { settingsApi, settingsKeys } from '@/features/settings/api';
import { fmtRate, fmtShortDate, num } from './calc';
import { refLabel } from '@/features/documents/form-model';
import { PERM, useProcurementFlow } from './flow';
import { AmendDialog, closableQty, ShortCloseDialog } from './po/dialogs';
import { RevisionBanner, usePoRevision } from './po/revision-banner';

const loading = () => <PageSkeleton rows={4} />;
const QuotePanel = dynamic(() => import('./quotes/quote-panel').then(m => m.QuotePanel), { loading });
const PoTaxPanel = dynamic(() => import('./po/tax-panel').then(m => m.PoTaxPanel), { loading });
const FollowupsPanel = dynamic(() => import('./po/followups-panel').then(m => m.FollowupsPanel), { loading });
const RevisionsPanel = dynamic(() => import('./po/revisions-panel').then(m => m.RevisionsPanel), { loading });

const AMENDABLE = new Set(['approved', 'partially_approved']);

/* ------------------------------------------------------------------ indent */

function HasPerm({ perm, children }: { perm: string; children: React.ReactNode }) {
  return usePermissions().has(perm) ? <>{children}</> : null;
}

function QuotesTabGate({ ctx }: { ctx: DocExtensionContext }) {
  return <QuotePanel doc={ctx.doc} focusLineId={ctx.focusLineId} onFocusLine={id => ctx.openTab('quotes', { lineId: id })} />;
}

function ShortCloseButton({ ctx, type }: { ctx: DocExtensionContext; type: 'indent' | 'po' }) {
  const p = usePermissions();
  const [open, setOpen] = useState(false);
  const can = p.has(type === 'po' ? PERM.poShortClose : PERM.indentShortClose);
  const any = ctx.doc.number && ctx.doc.lines.some(l => dec.gt0(closableQty(type, l)));
  if (!can || !any || ctx.doc.statusKey === 'draft' || ctx.doc.statusKey === 'amending') return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="short-close-button"><Scissors aria-hidden />{t('po.sc.button')}</Button>
      {open && <ShortCloseDialog type={type} doc={ctx.doc} onClose={() => setOpen(false)} onDone={d => { setOpen(false); ctx.refresh(d); toast.success(t('po.sc.done')); }} />}
    </>
  );
}

function useCanQuote() {
  const p = usePermissions();
  const flow = useProcurementFlow();
  return flow.indentEnabled && (p.has(PERM.logQuote) || p.has(PERM.compare));
}

function QuoteLineAction({ ctx, line }: { ctx: DocExtensionContext; line: DocumentLineRow }) {
  const ok = useCanQuote();
  if (!ok || !ctx.doc.number || !line.values.item) return null;
  return (
    <Button variant="ghost" size="sm" onClick={() => ctx.openTab('quotes', { lineId: line.id })} data-testid={`quote-line-action-${line.lineNo}`}>
      <Scale aria-hidden />{t('proc.quotes.action')}
    </Button>
  );
}

/* ------------------------------------------------------------------ indent item stock bar (per-line, collapsed + expandable) */

/** Read a boolean tenant setting, with a default fallback. */
function usePanelSetting(rows: SettingRow[], key: string, fallback: boolean | number): boolean | number {
  const row = rows.find(r => r.key === key);
  const v = row?.value ?? row?.default ?? fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  return fallback;
}

/**
 * Per-line info bar: appears collapsed (one thin row) once an item is selected on that line.
 * Click "Show more" → expands a drawer with full stock pills + recent indents + recent POs.
 * All sections are admin-configurable via `procurement.indent_panel.*` tenant settings.
 *
 * Accepts raw itemId + locationId so it works both on the live form (raw row values) and on the
 * saved detail page (via lineColumns, where we extract from DocumentLineRow).
 */
export function IndentLineStockBar({ itemId, locationId }: { itemId: string | undefined; locationId?: string }) {
  const perm = usePermissions();
  const [expanded, setExpanded] = useState(false);

  // Load tenant settings (cached across all line bars on the form — one request total)
  const settings = useQuery({ queryKey: settingsKeys.list, queryFn: settingsApi.list, staleTime: 300_000 });
  const rows = settings.data ?? [];

  const panelEnabled = usePanelSetting(rows, 'procurement.indent_panel.enabled', true) as boolean;
  const showStock = usePanelSetting(rows, 'procurement.indent_panel.show_stock', true) as boolean;
  const showLastIndent = usePanelSetting(rows, 'procurement.indent_panel.show_last_indent', true) as boolean;
  const showLastPo = usePanelSetting(rows, 'procurement.indent_panel.show_last_po', true) as boolean;
  const showIndentList = usePanelSetting(rows, 'procurement.indent_panel.show_indent_list', true) as boolean;
  const showPoList = usePanelSetting(rows, 'procurement.indent_panel.show_po_list', true) as boolean;
  const indentCount = usePanelSetting(rows, 'procurement.indent_panel.indent_count', 5) as number;
  const poCount = usePanelSetting(rows, 'procurement.indent_panel.po_count', 5) as number;
  const locationFilter = usePanelSetting(rows, 'procurement.indent_panel.location_filter', true) as boolean;
  const canViewStock = perm.has(STOCK_PERM.view);
  const canViewPo = perm.has('doc.po:action.view');

  // Stock summary
  const stock = useQuery({
    queryKey: ['stock-summary', itemId, locationFilter ? locationId : undefined],
    queryFn: () => stockApi.summary(itemId!),
    enabled: !!itemId && canViewStock && showStock && panelEnabled,
    staleTime: 30_000,
  });

  // Last indent (limit 1 for collapsed bar chip)
  const lastIndentQ = useQuery({
    queryKey: ['indent-last-item', itemId],
    queryFn: () => docsApi.list('indent', { view: 'document', item: itemId, sort: '-date' }, null, 1),
    enabled: !!itemId && showLastIndent && panelEnabled,
    staleTime: 60_000,
  });

  // Last PO (limit 1 for collapsed bar chip)
  const lastPoQ = useQuery({
    queryKey: ['po-last-item', itemId],
    queryFn: () => docsApi.list('po', { view: 'document', item: itemId, sort: '-date' }, null, 1),
    enabled: !!itemId && canViewPo && showLastPo && panelEnabled,
    staleTime: 60_000,
  });

  // Full lists for drawer (only fetched after expansion)
  const indentListQ = useQuery({
    queryKey: ['indent-recent-item', itemId, indentCount],
    queryFn: () => docsApi.list('indent', { view: 'document', item: itemId, sort: '-date' }, null, indentCount),
    enabled: !!itemId && expanded && showIndentList && panelEnabled,
    staleTime: 60_000,
  });
  const poListQ = useQuery({
    queryKey: ['po-recent-item', itemId, poCount],
    queryFn: () => docsApi.list('po', { view: 'document', item: itemId, sort: '-date' }, null, poCount),
    enabled: !!itemId && expanded && canViewPo && showPoList && panelEnabled,
    staleTime: 60_000,
  });

  // Nothing to show
  if (!itemId || !panelEnabled) return null;
  if (!canViewStock && !showLastIndent && !showLastPo) return null;

  const totals = stock.data?.totals;
  const lastIndent = (lastIndentQ.data?.data as unknown as Record<string, unknown>[] | undefined)?.[0];
  const lastPo = (lastPoQ.data?.data as unknown as Record<string, unknown>[] | undefined)?.[0];
  const indentList = (indentListQ.data?.data as unknown as Record<string, unknown>[] | undefined) ?? [];
  const poList = (poListQ.data?.data as unknown as Record<string, unknown>[] | undefined) ?? [];

  return (
    <div className="mt-1.5" data-testid={`indent-stock-bar-${itemId ?? 'none'}`}>
      {/* ── COLLAPSED BAR ── */}
      <div className="flex items-center rounded border border-border bg-subtle text-xs overflow-hidden">
        {/* Available stock chip */}
        {showStock && canViewStock && (
          <span className="flex items-center gap-1 px-2.5 py-1.5 border-r border-border whitespace-nowrap">
            <span className="text-fg-muted">Avail</span>
            {stock.isLoading
              ? <Skeleton className="h-3 w-10 inline-block" />
              : <strong className="text-success">{totals ? fmtQty(totals.available) : '—'}</strong>
            }
          </span>
        )}
        {/* Last indent chip */}
        {showLastIndent && (
          <span className="flex items-center gap-1 px-2.5 py-1.5 border-r border-border whitespace-nowrap">
            <span className="text-fg-muted">Last Indent</span>
            {lastIndentQ.isLoading
              ? <Skeleton className="h-3 w-16 inline-block" />
              : lastIndent
                ? <><Badge tone="neutral" className="text-[10px] py-0 px-1">{lastIndent.number as string}</Badge><span className="text-fg-muted">· {fmtDate(lastIndent.date as string)}</span></>
                : <span className="text-fg-subtle">—</span>
            }
          </span>
        )}
        {/* Last PO chip */}
        {showLastPo && canViewPo && (
          <span className="flex items-center gap-1 px-2.5 py-1.5 border-r border-border whitespace-nowrap">
            <span className="text-fg-muted">Last PO</span>
            {lastPoQ.isLoading
              ? <Skeleton className="h-3 w-16 inline-block" />
              : lastPo
                ? <><Badge tone="neutral" className="text-[10px] py-0 px-1">{lastPo.number as string}</Badge><span className="text-fg-muted">· {fmtDate(lastPo.date as string)}</span></>
                : <span className="text-fg-subtle">—</span>
            }
          </span>
        )}
        {/* Expand / collapse button */}
        <button
          type="button"
          className="ml-auto flex items-center gap-1 px-2.5 py-1.5 text-accent font-medium hover:bg-accent/5 whitespace-nowrap"
          onClick={() => setExpanded(e => !e)}
          data-testid={`indent-stock-bar-toggle-${itemId ?? 'none'}`}
        >
          {expanded ? <><ChevronUp className="size-3" aria-hidden />Hide</> : <><ChevronDown className="size-3" aria-hidden />Show more</>}
        </button>
      </div>

      {/* ── EXPANDED DRAWER ── */}
      {expanded && (
        <div className="rounded-b border border-t-0 border-border bg-surface px-3 py-2.5 text-xs space-y-2.5">
          {/* Full stock pills */}
          {showStock && canViewStock && (
            <div className="flex flex-wrap gap-2">
              {stock.isLoading ? <Skeleton className="h-10 w-64" /> : totals ? (
                <>
                  <div className="rounded border border-border bg-subtle px-2.5 py-1.5">
                    <div className="text-fg-subtle mb-0.5">Available</div>
                    <div className="text-sm font-bold text-success">{fmtQty(totals.available)}</div>
                  </div>
                  <div className="rounded border border-border bg-subtle px-2.5 py-1.5">
                    <div className="text-fg-subtle mb-0.5">Open PO</div>
                    <div className="text-sm font-bold text-fg">{fmtQty(totals.openPoQty)}</div>
                  </div>
                  <div className="rounded border border-border bg-subtle px-2.5 py-1.5">
                    <div className="text-fg-subtle mb-0.5">Pending Issue</div>
                    <div className="text-sm font-bold text-fg">{fmtQty(totals.pendingIssueQty)}</div>
                  </div>
                  {locationId && locationFilter && (
                    <div className="rounded border border-border bg-subtle px-2.5 py-1.5">
                      <div className="text-fg-subtle mb-0.5">Location</div>
                      <div className="text-sm font-medium text-fg">{stock.data?.nodes.find(n => n.node.id === locationId)?.node.name ?? 'This location'}</div>
                    </div>
                  )}
                </>
              ) : <p className="text-fg-muted italic">No stock data</p>}
            </div>
          )}

          {/* Recent indents list */}
          {showIndentList && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Recent Indents</p>
                <Link href={`/docs/indent?item=${itemId}`} className="text-accent hover:underline text-[10px]" onClick={e => e.stopPropagation()}>View all →</Link>
              </div>
              {indentListQ.isLoading ? <Skeleton className="h-4 w-full" /> : indentList.length ? (
                <ul className="space-y-1">
                  {indentList.map(d => (
                    <li key={d.id as string} className="flex items-center gap-1.5">
                      <Badge tone="neutral" className="text-[10px] py-0 px-1 shrink-0">{d.number as string}</Badge>
                      <span className="text-fg-muted">{fmtDate(d.date as string)}</span>
                      <span className="capitalize text-fg-muted">{String(d.statusKey ?? '').replace(/_/g, ' ')}</span>
                      <span className="ml-auto tabular-nums font-medium">{fmtQty(String((d as Record<string, unknown>).qty ?? '0'))}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-fg-muted italic">No recent indents</p>}
            </div>
          )}

          {/* Recent POs list */}
          {showPoList && canViewPo && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase tracking-wider text-fg-muted">Recent Purchase Orders</p>
                <Link href={`/docs/po?item=${itemId}`} className="text-accent hover:underline text-[10px]" onClick={e => e.stopPropagation()}>View all →</Link>
              </div>
              {poListQ.isLoading ? <Skeleton className="h-4 w-full" /> : poList.length ? (
                <ul className="space-y-1">
                  {poList.map(d => (
                    <li key={d.id as string} className="flex items-center gap-1.5">
                      <Badge tone="neutral" className="text-[10px] py-0 px-1 shrink-0">{d.number as string}</Badge>
                      <span className="text-fg-muted">{fmtDate(d.date as string)}</span>
                      <span className="capitalize text-fg-muted">{String(d.statusKey ?? '').replace(/_/g, ' ')}</span>
                      <span className="ml-auto tabular-nums font-medium">{fmtQty(String((d as Record<string, unknown>).qty ?? '0'))}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-fg-muted italic">No recent POs</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

registerDocExtension('indent', {
  // Vendor quotes tab is only shown to users who can log or compare quotes (e.g. Buyer).
  // Indent Clerks and other view-only roles will not see this tab at all.
  tabs: ctx => (ctx.doc.number && useCanQuote() ? [{ key: 'quotes', label: t('proc.quotes.tab'), testId: 'doc-tab-quotes', render: () => <QuotesTabGate ctx={ctx} /> }] : []),
  actions: ctx => <ShortCloseButton ctx={ctx} type="indent" />,
  lineColumns: ctx => {
    // Location from the saved doc's values (the indent header's `location` field)
    const locationId = typeof ctx.doc.values?.location === 'string' ? ctx.doc.values.location : undefined;
    return [
      // Per-line stock info bar on the DETAIL (read-only saved) view.
      // On the new/edit form this is rendered via FormRenderer's lineExtra prop instead (see doc-form-page.tsx).
      {
        key: 'stock_info',
        label: '',
        cell: l => <IndentLineStockBar itemId={typeof l.values.item === 'string' ? l.values.item : undefined} locationId={locationId} />,
      },
      ...(ctx.doc.number ? [
        { key: 'selected', label: t('proc.qty.selected'), align: 'right' as const, cell: (l: DocumentLineRow) => <QtyCell value={l.qty.selected} tone="success" testId={`qty-selected-${l.lineNo}`} /> },
        { key: 'ordered', label: t('proc.qty.ordered'), align: 'right' as const, cell: (l: DocumentLineRow) => <QtyCell value={l.qty.ordered} testId={`qty-ordered-${l.lineNo}`} /> },
        { key: 'quotes', label: t('proc.quotes.col'), cell: (l: DocumentLineRow) => <QuoteLineAction ctx={ctx} line={l} /> },
      ] : []),
    ];
  },
  itemColumns: () => [
    { id: 'selected', label: t('proc.qty.selected'), width: 96, align: 'right', cell: r => <QtyCell value={r.qty.selected} tone="success" /> },
    { id: 'ordered', label: t('proc.qty.ordered'), width: 96, align: 'right', cell: r => <QtyCell value={r.qty.ordered} /> },
    {
      id: 'quotes', label: t('proc.quotes.col'), width: 110, defaultVisible: true,
      cell: r => (r.number && r.item ? (
        <Link href={`/docs/indent/${r.documentId}?tab=quotes&line=${r.lineId}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 text-sm text-accent hover:underline" data-testid={`quote-open-${r.number}-${r.lineNo}`}>
          <Scale className="size-3.5" aria-hidden />{t('proc.quotes.action')}
        </Link>
      ) : null),
    },
  ],
});

/* ------------------------------------------------------------------ vendor selection */

function CreatePoLink({ ctx }: { ctx: DocExtensionContext }) {
  const p = usePermissions();
  if (!p.has(PERM.poAdd) || !AMENDABLE.has(ctx.doc.statusKey)) return null;
  return <Button asChild variant="secondary"><Link href="/procurement/order" data-testid="selection-create-po"><PackagePlus aria-hidden />{t('nav.procurement.order')}</Link></Button>;
}

registerDocExtension('vendor_selection', {
  actions: ctx => <CreatePoLink ctx={ctx} />,
  lineColumns: ctx => [
    { key: 'vendor', label: t('proc.cmp.vendor'), cell: l => <span className="whitespace-nowrap" data-testid={`sel-vendor-${l.lineNo}`}>{refLabel(l.refs, 'vendor', l.values.vendor) ?? '—'}</span> },
    { key: 'rate', label: t('proc.cmp.rate'), align: 'right', cell: l => <span className="tabular-nums">{l.values.rate ? fmtRate(l.values.rate) : '—'}</span> },
    ...(ctx.doc.number ? [{ key: 'ordered', label: t('proc.qty.ordered'), align: 'right' as const, cell: (l: DocumentLineRow) => <QtyCell value={l.qty.ordered} testId={`qty-ordered-${l.lineNo}`} /> }] : []),
  ],
});

/* ------------------------------------------------------------------ purchase order */

function AmendButton({ ctx }: { ctx: DocExtensionContext }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const p = usePermissions();
  const rev = usePoRevision(ctx.doc).current;
  if (!p.has(PERM.amend) || !AMENDABLE.has(ctx.doc.statusKey)) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="amend-button"><FilePenLine aria-hidden />{t('po.amend.button')}</Button>
      {open && (
        <AmendDialog doc={ctx.doc} revNo={rev} onClose={() => setOpen(false)} onDone={d => {
          setOpen(false); ctx.refresh(d); toast.success(t('po.amend.started', { n: rev + 1 }));
          router.push(`/docs/po/${ctx.doc.id}/edit`);
        }} />
      )}
    </>
  );
}

function FollowupButton({ ctx }: { ctx: DocExtensionContext }) {
  const p = usePermissions();
  if (!p.has(PERM.followup) || !ctx.doc.number || ctx.doc.statusKey === 'draft') return null;
  return <Button variant="secondary" onClick={() => ctx.openTab('followups')} data-testid="followup-open"><CalendarClock aria-hidden />{t('po.fu.button')}</Button>;
}

function FollowupsTab({ ctx }: { ctx: DocExtensionContext }) {
  const p = usePermissions();
  return <FollowupsPanel doc={ctx.doc} canLog={p.has(PERM.followup)} onChanged={() => ctx.refresh()} />;
}

/** Delivery schedule rows (grid field `schedule`): count, next date and whether they add up to the line qty. */
function ScheduleCell({ line }: { line: DocumentLineRow }) {
  const raw = line.values.schedule;
  const rows = (Array.isArray(raw) ? raw : []) as { date?: string; qty?: string | number }[];
  if (!rows.length) return <span className="text-fg-subtle" data-testid={`po-schedule-${line.lineNo}`} data-ok="none">—</span>;
  const sum = dec.add(...rows.map(r => String(r.qty ?? '0')));
  const lineQty = String(line.values.qty ?? line.qty.requested);
  const ok = dec.cmp(sum, lineQty) === 0;
  const next = rows.map(r => r.date).filter((d): d is string => !!d).sort()[0];
  return (
    <span className="text-sm" data-testid={`po-schedule-${line.lineNo}`} data-ok={ok ? 'true' : 'false'}>
      {t('po.sched.n', { n: rows.length })}{next ? <span className="text-fg-muted"> · {fmtShortDate(next)}</span> : null}
      {!ok && <span className="block text-xs font-medium text-danger">{t('po.sched.mismatch', { sum: fmtQty(sum), qty: fmtQty(lineQty) })}</span>}
    </span>
  );
}

function PoAside({ ctx }: { ctx: DocExtensionContext }) {
  const rev = usePoRevision(ctx.doc).current;
  const termIds = Array.isArray(ctx.doc.values.terms) ? (ctx.doc.values.terms as string[]) : [];
  // After approval the T&C bodies are snapshotted (`__terms_snapshot`); prefer those names when present.
  const snap = Array.isArray(ctx.doc.values.__terms_snapshot) ? (ctx.doc.values.__terms_snapshot as Record<string, unknown>[]) : [];
  const snapNames = snap.map(x => (typeof x?.name === 'string' ? x.name : typeof x?.title === 'string' ? x.title : typeof x?.code === 'string' ? x.code : null)).filter((x): x is string => !!x);
  const termNames = snapNames.length ? snapNames : termIds.map(id => ctx.doc.refs.terms?.[id] ?? null).filter((x): x is string => !!x);
  const expected = typeof ctx.doc.values.expected_date === 'string' ? ctx.doc.values.expected_date : null;
  return (
    <>
      {rev > 0 && <div><p className="text-xs text-fg-subtle">{t('po.rev.label')}</p><p data-testid="po-rev">{t('po.rev.n', { n: rev })}</p></div>}
      {expected && <div><p className="text-xs text-fg-subtle">{t('po.fu.expected')}</p><p data-testid="po-expected">{fmtShortDate(expected)}</p></div>}
      <div data-testid="po-terms" data-count={Math.max(termIds.length, snapNames.length)}>
        <p className="text-xs text-fg-subtle">{t('po.terms')}</p>
        {termIds.length === 0 && snapNames.length === 0 ? <p className="text-fg-muted">{t('po.termsNone')}</p> : (
          <ul className="space-y-0.5">{(termNames.length ? termNames : termIds.map((_, i) => t('po.termN', { n: i + 1 }))).map(n => <li key={n} className="truncate">{n}</li>)}</ul>
        )}
      </div>
    </>
  );
}

function ScheduleErrors({ errors, values }: { errors: { path: string; message: string }[]; values: Record<string, unknown> }) {
  const sched = errors.filter(e => /^lines\.\d+\.schedule/.test(e.path));
  const rows = Array.isArray(values.lines) ? (values.lines as Record<string, unknown>[]) : [];
  const local = rows.map((r, i) => {
    const s = (Array.isArray(r.schedule) ? r.schedule : []) as { qty?: unknown }[];
    if (!s.length) return null;
    const sum = s.reduce((a, x) => a + num(x.qty), 0);
    return Math.abs(sum - num(r.qty)) > 1e-9 ? { i, sum, qty: num(r.qty) } : null;
  }).filter((x): x is { i: number; sum: number; qty: number } => !!x);
  if (!sched.length && !local.length) return null;
  return (
    <div className="mb-4 rounded border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger" role="alert" data-testid="po-schedule-errors">
      <p className="font-medium">{t('po.sched.title')}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {local.map(x => <li key={`l${x.i}`}>{t('po.sched.lineMismatch', { n: x.i + 1, sum: fmtQty(String(x.sum)), qty: fmtQty(String(x.qty)) })}</li>)}
        {sched.filter(e => !local.some(x => e.path.startsWith(`lines.${x.i}.`))).map(e => <li key={e.path}>{t('po.sched.server', { n: Number(e.path.split('.')[1]) + 1, msg: e.message })}</li>)}
      </ul>
    </div>
  );
}

registerDocExtension('po', {
  banner: ctx => <RevisionBanner doc={ctx.doc} onOpenRevisions={() => ctx.openTab('revisions')} />,
  actions: ctx => (
    <>
      <FollowupButton ctx={ctx} />
      <AmendButton ctx={ctx} />
      <ShortCloseButton ctx={ctx} type="po" />
    </>
  ),
  aside: ctx => <PoAside ctx={ctx} />,
  tabs: ctx => [
    { key: 'taxes', label: t('po.tab.taxes'), testId: 'doc-tab-taxes', render: () => <PoTaxPanel doc={ctx.doc} /> },
    ...(ctx.doc.number ? [
      { key: 'followups', label: t('po.tab.followups'), testId: 'doc-tab-followups', render: () => <FollowupsTab ctx={ctx} /> },
      { key: 'revisions', label: t('po.tab.revisions'), testId: 'doc-tab-revisions', render: () => <RevisionsPanel doc={ctx.doc} /> },
    ] : []),
  ],
  lineColumns: ctx => [
    { key: 'schedule', label: t('po.sched.col'), cell: l => <ScheduleCell line={l} /> },
    ...(ctx.doc.number ? [{ key: 'ordered', label: t('proc.qty.received'), align: 'right' as const, cell: (l: DocumentLineRow) => <QtyCell value={l.qty.received} testId={`qty-received-${l.lineNo}`} /> }] : []),
  ],
  formBanner: ctx => (
    <>
      {ctx.doc && <RevisionBanner doc={ctx.doc} editing />}
      <ScheduleErrors errors={ctx.errors} values={ctx.values} />
    </>
  ),
});

/* ------------------------------------------------------------------ GRN */

/** Qty still in the GRN approval pipeline (received but not yet accepted or rejected at receipt). */
function grnClosableQty(l: DocumentLineRow): string {
  const received = Number(l.qty.received ?? '0');
  const accepted = Number(l.qty.accepted ?? '0');
  const rejected = Number((l.values as Record<string, unknown>).rejected_qty ?? '0');
  return String(Math.max(0, received - accepted - rejected));
}

function GrnShortCloseButton({ ctx }: { ctx: DocExtensionContext }) {
  const p = usePermissions();
  const [open, setOpen] = useState(false);
  const can = p.has(PERM.grnShortClose);
  const any = ctx.doc.lines.some(l => dec.gt0(grnClosableQty(l)));
  if (!can || !any || ctx.doc.statusKey === 'draft' || ctx.doc.statusKey === 'submitted') return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="grn-short-close-button">
        <Scissors aria-hidden />{t('po.sc.button')}
      </Button>
      {open && (
        <GrnShortCloseDialog
          doc={ctx.doc}
          onClose={() => setOpen(false)}
          onDone={d => { setOpen(false); ctx.refresh(d); toast.success(t('po.sc.done')); }}
        />
      )}
    </>
  );
}

function GrnShortCloseDialog({ doc, onClose, onDone }: { doc: DocumentRow; onClose: () => void; onDone: (d: DocumentRow) => void }) {
  const { Dialog, DialogContent, Checkbox, FormField, Segmented, Textarea } = require('@procure/ui') as typeof import('@procure/ui');
  const { InlineAlert } = require('@/components/page') as typeof import('@/components/page');
  const lines = [...doc.lines].sort((a, b) => a.lineNo - b.lineNo).filter(l => dec.gt0(grnClosableQty(l)));
  const [mode, setMode] = useState<'whole' | 'lines'>('whole');
  const [ids, setIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (reason.trim().length < 3) { setErr(t('validation.reasonMin')); return; }
    if (mode === 'lines' && !ids.length) { setErr(t('po.sc.pickLines')); return; }
    setErr(null); setBusy(true);
    try {
      const { procApi } = await import('./api');
      onDone(await procApi.grnShortClose(doc.id, { reason: reason.trim(), ...(mode === 'lines' ? { lineIds: ids } : {}) }));
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o: boolean) => !o && onClose()}>
      <DialogContent
        data-testid="grn-short-close-dialog"
        title={t('po.sc.title')}
        description={t('po.sc.hintPo')}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={go} loading={busy} disabled={!lines.length} data-testid="grn-short-close-confirm">{t('po.sc.confirm')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          {err && <InlineAlert data-testid="grn-short-close-error">{err}</InlineAlert>}
          {lines.length === 0 ? <p className="text-sm text-fg-muted">{t('po.sc.nothing')}</p> : (
            <>
              <Segmented<'whole' | 'lines'>
                label={t('po.sc.scope')} value={mode} onChange={setMode} size="md" data-testid="grn-short-close-mode"
                options={[{ value: 'whole', label: t('po.sc.whole') }, { value: 'lines', label: t('po.sc.someLines') }]}
              />
              <ul className="divide-y divide-border rounded border border-border">
                {lines.map(l => (
                  <li key={l.id} className="px-3 py-2">
                    <label className="flex items-center gap-2.5 text-sm">
                      {mode === 'lines' && (
                        <Checkbox
                          checked={ids.includes(l.id)}
                          onCheckedChange={(c: boolean) => setIds(x => (c ? [...x, l.id] : x.filter(i => i !== l.id)))}
                          data-testid={`grn-short-close-line-${l.lineNo}`}
                        />
                      )}
                      <span className="text-fg-subtle tabular-nums">{l.lineNo}</span>
                      <span className="min-w-0 flex-1 truncate">{String(l.values.item_name ?? l.values.item ?? '')}</span>
                      <span className="tabular-nums text-fg-muted">{t('po.sc.closes', { qty: fmtQty(grnClosableQty(l)), uom: String(l.values.uom ?? '') })}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <FormField label={t('po.sc.reason')} required>
            <Textarea rows={2} value={reason} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReason(e.target.value)} maxLength={500} data-testid="grn-short-close-reason" />
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

registerDocExtension('grn', {
  actions: ctx => <GrnShortCloseButton ctx={ctx} />,
});

export type { DocumentRow };
export { HasPerm };
