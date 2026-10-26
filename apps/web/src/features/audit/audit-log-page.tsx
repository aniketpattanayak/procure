'use client';
import type { AuditCheckRow, AuditRow } from '@procure/schema';
import {
  Badge, Button, DataTable, EmptyState, Input, Label, Sheet, SheetContent, Skeleton, SkeletonGroup, StatusBadge, toast, type DataTableColumn,
} from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck, ScrollText, UserCog, X } from 'lucide-react';
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { DetailList, InlineAlert, PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { describeAgent, fmtDateTime, fmtNumber, fmtRelative } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { useDebounced } from '@/lib/use-debounced';
import { UserPicker } from '@/features/workflows/actors';
import { useUserOptions } from '@/features/workflows/api';
import { auditApi, type AuditFilters } from './api';
import { diffValues, DiffViewer } from './diff';

/** Local date (YYYY-MM-DD) to an ISO instant at the start or end of that day in the browser's zone. */
function dayBound(d: string, end: boolean): string | undefined {
  if (!d) return undefined;
  const dt = new Date(`${d}T${end ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}

function actionTone(a: string): 'danger' | 'warning' | 'success' | 'neutral' | 'accent' {
  if (/delete|deactivat|reject|cancel|revoke|lock/.test(a)) return 'danger';
  if (/imperson|override|reset|unlock/.test(a)) return 'warning';
  if (/create|activate|approve|publish/.test(a)) return 'success';
  if (/update|edit|save|change/.test(a)) return 'accent';
  return 'neutral';
}

function FilterField({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-1"><Label htmlFor={id} className="text-xs text-fg-muted">{label}</Label>{children(id)}</div>;
}

export function AuditLogPage() {
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState('');
  const [actor, setActor] = useState<string[]>([]);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<AuditRow | null>(null);
  const users = useUserOptions('');
  const names = useMemo(() => new Map((users.data ?? []).map(u => [u.id, u.name])), [users.data]);

  const filters: AuditFilters = {
    entity: useDebounced(entity.trim(), 300) || undefined,
    entityId: useDebounced(entityId.trim(), 300) || undefined,
    actorId: actor[0],
    action: useDebounced(action.trim(), 300) || undefined,
    from: dayBound(from, false),
    to: dayBound(to, true),
  };
  const key = JSON.stringify(filters);
  const fetchPage = useCallback((cursor: string | null) => auditApi.list(JSON.parse(key) as AuditFilters, cursor), [key]);
  const active = !!(entity || entityId || actor.length || action || from || to);
  const clear = () => { setEntity(''); setEntityId(''); setActor([]); setAction(''); setFrom(''); setTo(''); };

  const columns = useMemo<DataTableColumn<AuditRow>[]>(() => [
    { id: 'at', header: t('auditlog.col.when'), width: 190, alwaysVisible: true, cell: ({ row }) => <span className="tabular-nums text-fg-muted" title={row.original.at}>{fmtDateTime(row.original.at)}</span> },
    {
      id: 'actor', header: t('auditlog.col.user'), width: 190, cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{row.original.actor?.name ?? <span className="text-fg-subtle">{t('auditlog.system')}</span>}</span>
          {row.original.impersonatedBy && (
            <Badge tone="warning" title={t('auditlog.impersonatedBy', { name: row.original.impersonatedBy.name })} data-testid="audit-impersonated">
              <UserCog className="size-3" aria-hidden />{t('auditlog.via', { name: row.original.impersonatedBy.name })}
            </Badge>
          )}
        </span>
      ),
    },
    { id: 'action', header: t('auditlog.col.action'), width: 140, cell: ({ row }) => <Badge tone={actionTone(row.original.action)}>{row.original.action}</Badge> },
    {
      id: 'entity', header: t('auditlog.col.entity'), width: 170, cell: ({ row }) => (
        <span className="min-w-0 truncate">{row.original.entity}{row.original.entityId && <span className="ml-1.5 font-mono text-xs text-fg-muted">{row.original.entityId.length > 12 ? row.original.entityId.slice(0, 8) : row.original.entityId}</span>}</span>
      ),
    },
    {
      id: 'changes', header: t('auditlog.col.changes'), width: 90, align: 'right', cell: ({ row }) => {
        const n = diffValues(row.original.before ?? null, row.original.after ?? null).filter(r => r.kind !== 'same').length;
        return <span className="tabular-nums text-fg-muted">{n ? t('auditlog.keysN', { n }) : '—'}</span>;
      },
    },
    { id: 'ip', header: t('auditlog.col.ip'), width: 130, defaultHidden: true, cell: ({ row }) => <span className="tabular-nums text-fg-muted">{row.original.ip ?? '—'}</span> },
  ], []);

  return (
    <PageBody>
      <PageHeader title={t('auditlog.title')} description={t('auditlog.description')} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface p-3 md:grid-cols-3 2xl:grid-cols-6" role="search" aria-label={t('auditlog.filters')} data-testid="audit-filters">
            <FilterField label={t('auditlog.f.entity')}>{id => <Input id={id} value={entity} onChange={e => setEntity(e.target.value)} placeholder={t('auditlog.f.entityEg')} className="h-8" data-testid="audit-filter-entity" />}</FilterField>
            <FilterField label={t('auditlog.f.entityId')}>{id => <Input id={id} value={entityId} onChange={e => setEntityId(e.target.value)} className="h-8 font-mono text-sm" data-testid="audit-filter-entity-id" />}</FilterField>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-fg-muted">{t('auditlog.f.user')}</span>
              <UserPicker value={actor} onChange={ids => setActor(ids.slice(-1))} userName={id => names.get(id) ?? id.slice(0, 8)} testId="audit-filter-user" label={t('auditlog.f.user')} />
            </div>
            <FilterField label={t('auditlog.f.action')}>{id => <Input id={id} value={action} onChange={e => setAction(e.target.value)} placeholder={t('auditlog.f.actionEg')} className="h-8" data-testid="audit-filter-action" />}</FilterField>
            <FilterField label={t('auditlog.f.from')}>{id => <Input id={id} type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} className="h-8" data-testid="audit-filter-from" />}</FilterField>
            <FilterField label={t('auditlog.f.to')}>{id => <Input id={id} type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} className="h-8" data-testid="audit-filter-to" />}</FilterField>
            {active && (
              <div className="col-span-full flex justify-end">
                <Button size="sm" variant="ghost" onClick={clear} data-testid="audit-filter-clear"><X aria-hidden />{t('auditlog.clear')}</Button>
              </div>
            )}
          </div>
          <DataTable
            data-testid="audit-table"
            columns={columns}
            fetchPage={fetchPage}
            queryKey={key}
            getRowId={r => r.id}
            onRowClick={r => setOpen(r)}
            storageKey="tenant-audit"
            height="calc(100dvh - 19rem)"
            labels={{ caption: t('auditlog.title'), columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') }}
            empty={<EmptyState icon={<ScrollText />} title={active ? t('auditlog.emptyFiltered') : t('auditlog.empty')} />}
          />
        </div>
        <TamperPanel />
      </div>
      <Sheet open={!!open} onOpenChange={o => { if (!o) setOpen(null); }}>
        {open && (
          <SheetContent side="right" title={t('auditlog.detailTitle', { action: open.action, entity: open.entity })} closeLabel={t('common.close')}
            className="w-full max-w-none sm:w-[44rem] sm:max-w-[44rem]" data-testid="audit-detail">
            <div className="space-y-4 p-4">
              {open.impersonatedBy && (
                <InlineAlert tone="warning" data-testid="audit-detail-impersonation">
                  {t('auditlog.impersonationNote', { by: open.impersonatedBy.name, as: open.actor?.name ?? t('auditlog.system') })}
                </InlineAlert>
              )}
              <DetailList items={[
                { label: t('auditlog.col.when'), value: <span title={open.at}>{fmtDateTime(open.at)}</span> },
                { label: t('auditlog.col.user'), value: open.actor?.name ?? t('auditlog.system') },
                { label: t('auditlog.col.action'), value: <Badge tone={actionTone(open.action)}>{open.action}</Badge> },
                { label: t('auditlog.col.entity'), value: <span>{open.entity} {open.entityId && <code className="break-all text-xs text-fg-muted">{open.entityId}</code>}</span> },
                { label: t('auditlog.col.ip'), value: open.ip ?? '—' },
                { label: t('auditlog.device'), value: describeAgent(open.userAgent) },
              ]} />
              <DiffViewer before={open.before} after={open.after} />
            </div>
          </SheetContent>
        )}
      </Sheet>
    </PageBody>
  );
}

function TamperPanel() {
  const p = usePermissions();
  const qc = useQueryClient();
  const canVerify = p.has('admin.audit:action.verify');
  const checks = useQuery({ queryKey: ['audit-checks'], queryFn: auditApi.checks });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<AuditCheckRow | null>(null);
  async function run() {
    setBusy(true);
    try {
      const r = await auditApi.runCheck();
      setLast(r);
      void qc.invalidateQueries({ queryKey: ['audit-checks'] });
      if (r.ok) toast.success(t('auditlog.check.passed', { n: fmtNumber(r.rowsChecked) }));
      else toast.error(t('auditlog.check.failed'), r.detail ?? undefined);
    } catch (e) {
      toast.error(t('auditlog.check.runFailed'), isApiError(e) ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }
  const rows = [...(checks.data ?? [])].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
  const latest = last ?? rows[0] ?? null;
  return (
    <aside className="h-fit space-y-3 rounded-lg border border-border bg-surface p-4" aria-labelledby="tamper-h" data-testid="audit-tamper">
      <div className="flex items-start gap-2">
        {latest && !latest.ok ? <ShieldAlert className="mt-0.5 size-5 text-danger" aria-hidden /> : <ShieldCheck className="mt-0.5 size-5 text-success" aria-hidden />}
        <div className="min-w-0 flex-1">
          <h2 id="tamper-h" className="font-semibold">{t('auditlog.check.title')}</h2>
          <p className="text-sm text-fg-muted">{t('auditlog.check.body')}</p>
        </div>
      </div>
      {latest && (
        <div className={latest.ok ? 'rounded bg-success-soft px-3 py-2 text-sm text-success' : 'rounded bg-danger-soft px-3 py-2 text-sm text-danger'} role="status" data-testid="audit-check-result" data-ok={latest.ok}>
          <p className="font-medium">{latest.ok ? t('auditlog.check.okLine', { n: fmtNumber(latest.rowsChecked) }) : t('auditlog.check.badLine', { id: latest.firstBadId ?? '?' })}</p>
          <p className="text-xs" title={latest.checkedAt}>{t('auditlog.check.when', { when: fmtRelative(latest.checkedAt) })}</p>
          {latest.detail && <p className="mt-1 text-xs">{latest.detail}</p>}
        </div>
      )}
      {canVerify && <Button className="w-full" variant="secondary" onClick={() => void run()} loading={busy} data-testid="audit-run-check">{t('auditlog.check.run')}</Button>}
      <div>
        <h3 className="mb-1 text-sm font-medium">{t('auditlog.check.recent')}</h3>
        {checks.isLoading ? (
          <SkeletonGroup className="space-y-1.5"><Skeleton className="h-7" /><Skeleton className="h-7" /></SkeletonGroup>
        ) : !rows.length ? (
          <p className="text-sm text-fg-muted">{t('auditlog.check.none')}</p>
        ) : (
          <ol className="max-h-72 divide-y divide-border overflow-y-auto text-sm" data-testid="audit-check-list">
            {rows.map(c => (
              <li key={c.checkedAt} className="flex items-center gap-2 py-1.5" data-testid="audit-check-row" data-ok={c.ok}>
                <StatusBadge tone={c.ok ? 'success' : 'danger'}>{c.ok ? t('auditlog.check.ok') : t('auditlog.check.bad')}</StatusBadge>
                <span className="flex-1 truncate text-fg-muted" title={c.checkedAt}>{fmtDateTime(c.checkedAt)}</span>
                <span className="tabular-nums text-xs text-fg-subtle">{fmtNumber(c.rowsChecked)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
