'use client';
import { Button, cn, Skeleton } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  ListChecks,
  PackageCheck,
  PackagePlus,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { PageBody, PageHeader } from '@/components/page';
import { docsApi, docKeys } from '@/features/documents/api';
import type { StatusCount } from '@/features/documents/api';
import { t } from '@/i18n';
import { usePermissions } from '@/lib/permissions';
import { useProcurementFlow, PERM } from '../flow';

/** Sum counts for all statuses except terminal ones (closed / cancelled). */
function sumActive(counts: StatusCount[] | undefined): number {
  if (!counts) return 0;
  return counts
    .filter(c => !['closed', 'cancelled'].includes(c.statusKey))
    .reduce((s, c) => s + c.count, 0);
}

/** Count for a specific status key. */
function countFor(counts: StatusCount[] | undefined, statusKey: string): number {
  return counts?.find(c => c.statusKey === statusKey)?.count ?? 0;
}

interface StatCardProps {
  title: string;
  subtitle?: string;
  value: number | undefined;
  loading: boolean;
  error: boolean;
  href: string;
  icon: React.ReactNode;
  warn?: boolean;
  ok?: boolean;
  disabled?: boolean;
}

function StatCard({ title, subtitle, value, loading, error, href, icon, warn, ok, disabled }: StatCardProps) {
  const body = (
    <div className={cn('group relative flex flex-col gap-4 rounded-xl border bg-surface p-5 transition-all',
      disabled ? 'cursor-default opacity-60' : 'cursor-pointer hover:border-accent/40 hover:shadow-sm',
    )}>
      <div className="flex items-start justify-between">
        <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg',
          disabled ? 'bg-fg-muted/10 text-fg-muted' : 'bg-accent/10 text-accent',
        )}>
          {icon}
        </div>
        {!disabled && (
          <ArrowRight className="h-4 w-4 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        )}
      </div>

      <div>
        <p className="text-sm font-medium text-fg-muted">{title}</p>
        {subtitle && <p className="mt-0.5 text-xs text-fg-subtle">{subtitle}</p>}
        <div className="mt-2 h-9 flex items-center">
          {loading ? (
            <Skeleton className="h-8 w-16" />
          ) : error ? (
            <span className="flex items-center gap-1.5 text-sm text-fg-muted">
              <AlertCircle className="h-4 w-4" aria-hidden /> —
            </span>
          ) : (
            <span className={cn('text-3xl font-bold tabular-nums',
              warn && value! > 0 ? 'text-warning' : ok ? 'text-success' : 'text-fg',
            )}>
              {value ?? 0}
            </span>
          )}
        </div>
      </div>
    </div>
  );

  if (disabled) return body;
  return <Link href={href} className="block" aria-label={`${title}: ${value ?? 0}`}>{body}</Link>;
}

function QuickAction({ label, href, icon }: { label: string; href: string; icon: React.ReactNode }) {
  return (
    <Button asChild variant="secondary" className="h-auto px-4 py-3">
      <Link href={href} className="flex items-center gap-2.5">
        {icon}
        <span className="text-sm font-medium">{label}</span>
        <ArrowRight className="ml-auto h-4 w-4 text-fg-muted" aria-hidden />
      </Link>
    </Button>
  );
}

export function ProcurementDashboard() {
  const p = usePermissions();
  const flow = useProcurementFlow();

  const canViewIndent = p.has(PERM.indentView);
  const canAddSelection = p.has(PERM.selectionAdd);
  const canAddPo = p.has(PERM.poAdd);

  const indentCounts = useQuery({
    queryKey: docKeys.counts('indent', { view: 'document' }),
    queryFn: () => docsApi.counts('indent', { view: 'document' }),
    staleTime: 30_000,
    enabled: flow.indentEnabled && canViewIndent,
  });

  const selectionCounts = useQuery({
    queryKey: docKeys.counts('vendor_selection', { view: 'document' }),
    queryFn: () => docsApi.counts('vendor_selection', { view: 'document' }),
    staleTime: 30_000,
    enabled: flow.selectionEnabled,
  });

  const poCounts = useQuery({
    queryKey: docKeys.counts('po', { view: 'document' }),
    queryFn: () => docsApi.counts('po', { view: 'document' }),
    staleTime: 30_000,
    enabled: canAddPo,
  });

  const grnCounts = useQuery({
    queryKey: docKeys.counts('grn', { view: 'document' }),
    queryFn: () => docsApi.counts('grn', { view: 'document' }),
    staleTime: 30_000,
  });

  const pendingIndents = sumActive(indentCounts.data);
  const pendingSelections = sumActive(selectionCounts.data);
  const openPos = countFor(poCounts.data, 'approved');
  const pendingGrns = countFor(grnCounts.data, 'approved');

  return (
    <PageBody>
      <PageHeader
        title={t('nav.section.procurement')}
        description="Overview of your procurement activity."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {flow.indentEnabled && (
          <StatCard
            title="Pending indents"
            subtitle="Awaiting approval"
            value={pendingIndents}
            loading={indentCounts.isLoading}
            error={indentCounts.isError}
            href="/docs/indent"
            icon={<ClipboardList className="h-5 w-5" />}
            warn
            disabled={!canViewIndent}
          />
        )}

        {flow.selectionEnabled && (
          <StatCard
            title="Pending selections"
            subtitle="Vendor not yet chosen"
            value={pendingSelections}
            loading={selectionCounts.isLoading}
            error={selectionCounts.isError}
            href="/docs/vendor_selection"
            icon={<ListChecks className="h-5 w-5" />}
            warn
          />
        )}

        <StatCard
          title="Open purchase orders"
          subtitle="Approved, not fully received"
          value={openPos}
          loading={poCounts.isLoading}
          error={poCounts.isError}
          href="/docs/po?status=approved"
          icon={<PackagePlus className="h-5 w-5" />}
          ok={openPos === 0}
          disabled={!canAddPo}
        />

        <StatCard
          title="GRNs to process"
          subtitle="Approved, awaiting acceptance"
          value={pendingGrns}
          loading={grnCounts.isLoading}
          error={grnCounts.isError}
          href="/docs/grn?status=approved"
          icon={<PackageCheck className="h-5 w-5" />}
          warn
        />
      </div>

      <div className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-fg-muted uppercase tracking-wide">Quick actions</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {flow.indentEnabled && canViewIndent && (
            <QuickAction
              label="View all indents"
              href="/docs/indent"
              icon={<ClipboardList className="h-4 w-4 text-accent" />}
            />
          )}
          {flow.selectionEnabled && canAddSelection && (
            <QuickAction
              label={t('nav.procurement.select')}
              href="/procurement/select"
              icon={<ListChecks className="h-4 w-4 text-accent" />}
            />
          )}
          {canAddPo && (
            <QuickAction
              label={t('nav.procurement.order')}
              href="/procurement/order"
              icon={<PackagePlus className="h-4 w-4 text-accent" />}
            />
          )}
          <QuickAction
            label="View purchase orders"
            href="/docs/po"
            icon={<TrendingUp className="h-4 w-4 text-accent" />}
          />
          <QuickAction
            label="View goods receipts"
            href="/docs/grn"
            icon={<PackageCheck className="h-4 w-4 text-accent" />}
          />
          <QuickAction
            label="Approvals inbox"
            href="/approvals"
            icon={<CheckCircle2 className="h-4 w-4 text-accent" />}
          />
        </div>
      </div>
    </PageBody>
  );
}
