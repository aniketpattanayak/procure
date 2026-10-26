'use client';
import type { DataField, MasterSummary, RecordRow } from '@procure/schema';
import {
  Button, DataTable, toast, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, Input, StatusBadge, cn, type DataTableColumn,
} from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Database, Download, FileUp, Lock, PencilRuler, Plus, Search } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { PageSkeleton } from '@/components/guards';
import { PageBody, PageHeader } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { perm, usePermissions } from '@/lib/permissions';
import { useDebounced } from '@/lib/use-debounced';
import { useRenderableForm } from '@/engines/form-renderer/render-api';
import { isDataField } from '@/engines/form-renderer/formula';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { mastersApi, type RecordView } from './api';
import { numericTypes, RecordCell } from './cells';

const RecordSheet = dynamic(() => import('./record-sheet').then(m => m.RecordSheet), { ssr: false });
const ImportDialog = dynamic(() => import('./import-dialog').then(m => m.ImportDialog), { ssr: false });

const VIEWS = ['active', 'inactive'] as const;

export function MasterRecordsPage({ masterKey }: { masterKey: string }) {
  const masters = useQuery({ queryKey: ['masters'], queryFn: mastersApi.list, staleTime: 60_000 });
  const master = masters.data?.find(m => m.key === masterKey);
  const p = usePermissions();
  const tab = perm.masterTab(masterKey);

  if (masters.isLoading || !p.ready) return <PageBody><PageSkeleton rows={8} /></PageBody>;
  if (!master || !p.can(tab, 'view')) {
    return (
      <PageBody>
        <EmptyState icon={<Lock />} title={master ? t('masters.noAccess') : t('masters.notFound')} description={master ? t('masters.noAccessHint') : undefined}
          action={<Button asChild variant="secondary"><Link href="/dashboard">{t('masters.goHome')}</Link></Button>} />
      </PageBody>
    );
  }
  return <RecordsList master={master} />;
}

function RecordsList({ master }: { master: MasterSummary }) {
  const p = usePermissions();
  const tab = perm.masterTab(master.key);
  const { currency } = useTenantLocale();
  const permitted = p.permittedViews(tab, VIEWS);
  const views: RecordView[] = permitted.length === 2 ? [...permitted, 'all'] : permitted;
  const [view, setView] = useState<RecordView | undefined>(undefined);
  const currentView = view && views.includes(view) ? view : views[0];
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const form = useRenderableForm(master.formKey);
  const dataFields = useMemo<DataField[]>(
    () => (form.data?.definition.fields ?? []).filter(isDataField).filter(f => !f.removed && !f.hidden && f.key !== 'code' && f.key !== 'name'),
    [form.data],
  );

  const fetchPage = useCallback(
    (cursor: string | null) => mastersApi.records(master.key, { cursor, q, view: currentView, sort: master.settings.defaultSort }),
    [master.key, master.settings.defaultSort, q, currentView],
  );

  const columns = useMemo<DataTableColumn<RecordRow>[]>(() => {
    const listCols = new Set(master.settings.listColumns);
    const cols: DataTableColumn<RecordRow>[] = [
      { id: 'code', header: master.settings.codeLabel || t('masters.code'), width: 130, alwaysVisible: true, cell: ({ row }) => <span className="font-medium tabular-nums">{row.original.code}</span> },
      { id: 'name', header: master.settings.nameLabel || t('masters.name'), width: 240, alwaysVisible: true, cell: ({ row }) => <span className="truncate">{row.original.name}</span> },
    ];
    // Images first among data columns so thumbnails line up next to the name.
    const ordered = [...dataFields].sort((a, b) => Number(b.type === 'image') - Number(a.type === 'image'));
    for (const f of ordered) {
      if (f.type === 'grid' || f.type === 'signature') continue;
      cols.push({
        id: `d.${f.key}`,
        header: f.label,
        label: f.label,
        width: f.type === 'image' ? 90 : numericTypes.has(f.type) ? 130 : 180,
        align: numericTypes.has(f.type) ? 'right' : 'left',
        defaultHidden: !listCols.has(f.key),
        cell: ({ row }) => <RecordCell field={f} row={row.original} currency={currency} />,
      });
    }
    cols.push({
      id: 'status', header: t('masters.status'), width: 110,
      cell: ({ row }) => row.original.isActive ? <StatusBadge tone="success">{t('masters.active')}</StatusBadge> : <StatusBadge tone="neutral">{t('masters.inactive')}</StatusBadge>,
    });
    return cols;
  }, [dataFields, master.settings, currency]);

  const canAdd = p.can(tab, 'add');
  const canImport = p.can(tab, 'import');
  const canExport = p.can(tab, 'export');

  async function exportAs(format: 'csv' | 'xlsx') {
    try {
      await mastersApi.export(master.key, format, currentView ?? 'active');
    } catch (e) {
      toast.error(t('masters.exportFailed'), isApiError(e) ? e.message : undefined);
    }
  }

  return (
    <PageBody>
      <PageHeader
        title={master.pluralName}
        description={master.description ?? undefined}
        actions={
          <>
            {p.has('config.forms:action.view') && (
              <Button asChild variant="ghost" size="sm"><Link href={`/config/forms/${master.formKey}`} data-testid="master-edit-form"><PencilRuler aria-hidden />{t('masters.editForm')}</Link></Button>
            )}
            {canImport && <Button variant="secondary" onClick={() => setImportOpen(true)} data-testid="master-import"><FileUp aria-hidden />{t('masters.import')}</Button>}
            {canExport && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="secondary" data-testid="master-export"><Download aria-hidden />{t('masters.export')}</Button></DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => void exportAs('xlsx')} data-testid="master-export-xlsx">{t('masters.exportXlsx')}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportAs('csv')} data-testid="master-export-csv">{t('masters.exportCsv')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canAdd && <Button onClick={() => setOpen('new')} data-testid="master-add"><Plus aria-hidden />{t('masters.add', { name: master.name })}</Button>}
          </>
        }
      />
      {views.length === 0 ? (
        <EmptyState icon={<Lock />} title={t('masters.noViews')} />
      ) : form.isLoading ? (
        <PageSkeleton rows={8} />
      ) : (
        <DataTable
          data-testid="master-records-table"
          columns={columns}
          fetchPage={fetchPage}
          queryKey={`${master.key}|${q}|${currentView}|${version}`}
          getRowId={r => r.id}
          onRowClick={r => setOpen(r.id)}
          storageKey={`master:${master.key}`}
          rowHeight={52}
          labels={{ caption: master.pluralName, columns: t('table.columns'), loadMore: t('table.loadMore'), error: t('table.error'), retry: t('common.retry'), loading: t('common.loading') }}
          toolbar={
            <>
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
                <Input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('masters.search', { name: master.pluralName.toLowerCase() })}
                  aria-label={t('masters.searchLabel')} className="pl-8" data-testid="master-search" />
              </div>
              {views.length > 0 && (
                <div role="radiogroup" aria-label={t('masters.view')} className="flex gap-1" data-testid="master-views">
                  {views.map(v => (
                    <button key={v} type="button" role="radio" aria-checked={currentView === v} onClick={() => setView(v)} data-testid={`master-view-${v}`}
                      className={cn('rounded-full border px-3 py-1 text-sm', currentView === v ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-border text-fg-muted hover:bg-muted')}>
                      {t(`masters.view.${v}` as 'masters.view.all')}
                    </button>
                  ))}
                </div>
              )}
            </>
          }
          empty={
            <EmptyState
              icon={<Database />}
              title={q ? t('masters.emptySearch') : t('masters.empty', { name: master.pluralName.toLowerCase() })}
              description={q ? undefined : canImport ? t('masters.emptyHintImport') : undefined}
              action={!q && canAdd && <Button variant="secondary" onClick={() => setOpen('new')}><Plus aria-hidden />{t('masters.add', { name: master.name })}</Button>}
            />
          }
        />
      )}
      {open && (
        <RecordSheet key={open} master={master} recordId={open === 'new' ? null : open} onClose={() => setOpen(null)} onChanged={() => setVersion(v => v + 1)} onOpenRecord={id => setOpen(id)} />
      )}
      {importOpen && <ImportDialog master={master} onClose={() => setImportOpen(false)} onImported={() => setVersion(v => v + 1)} />}
    </PageBody>
  );
}
