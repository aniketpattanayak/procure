'use client';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, toast } from '@procure/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText, Sheet } from 'lucide-react';
import Link from 'next/link';
import { fileHref } from '@/components/file-upload';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { exportsApi, reportKeys } from '@/features/reports/api';
import type { ExportBody, ExportFormat, ExportJob } from '@/features/reports/types';

const POLL_MS = 2500;
const NAMES_KEY = 'procure.exportNames';

/** ExportJobRow has no name: remember what each job exported, in this browser only (best effort). */
export function exportName(id: string): string | null {
  try { return (JSON.parse(window.localStorage.getItem(NAMES_KEY) ?? '{}') as Record<string, string>)[id] ?? null; } catch { return null; }
}
function rememberName(id: string, name: string) {
  try {
    const all = Object.entries(JSON.parse(window.localStorage.getItem(NAMES_KEY) ?? '{}') as Record<string, string>).slice(-99);
    window.localStorage.setItem(NAMES_KEY, JSON.stringify(Object.fromEntries([...all, [id, name]])));
  } catch { /* storage unavailable */ }
}
const POLL_MAX = 10 * 60_000;

/** Follow a job until it is ready or failed, then toast the result (with a download link). Runs detached. */
function follow(job: ExportJob, onChange: () => void) {
  const started = Date.now();
  const tick = async () => {
    let cur: ExportJob;
    try { cur = await exportsApi.get(job.id); } catch { return; }
    if (cur.status === 'ready') {
      onChange();
      toast.success(t('export.toast.ready'), (
        <span className="flex flex-wrap gap-x-3">
          {cur.fileUrl && <a href={fileHref(cur.fileUrl)} className="font-medium text-accent underline" data-testid="export-toast-download">{t('export.download')}</a>}
          <Link href="/exports" className="text-accent underline">{t('export.toast.open')}</Link>
        </span>
      ));
      return;
    }
    if (cur.status === 'failed' || cur.status === 'expired') {
      onChange();
      toast.error(t('export.toast.failed'), cur.error ?? undefined);
      return;
    }
    if (Date.now() - started < POLL_MAX) setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
}

/** Queue an export job: toast "Export started" with a link to /exports, then a second toast when the file is ready. */
export function useStartExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: ExportBody; name?: string }) => exportsApi.create(v.body),
    onSuccess: (job, v) => {
      if (v.name) rememberName(job.id, v.name);
      void qc.invalidateQueries({ queryKey: reportKeys.exports });
      toast(t('export.toast.started'), {
        description: <span>{t('export.toast.startedBody')} <Link href="/exports" className="font-medium text-accent underline" data-testid="export-toast-link">{t('export.toast.open')}</Link></span>,
      });
      follow(job, () => void qc.invalidateQueries({ queryKey: reportKeys.exports }));
    },
    onError: e => toast.error(t('export.toast.error'), isApiError(e) ? e.message : undefined),
  });
}

export const FORMAT_ICON = { xlsx: FileSpreadsheet, csv: Sheet, pdf: FileText } as const;

/** "Export" menu: xlsx / csv / pdf. */
export function ExportMenu({ build, name, disabled, size = 'sm', formats = ['xlsx', 'csv', 'pdf'] }: {
  build: (format: ExportFormat) => ExportBody; name?: string; disabled?: boolean; size?: 'sm' | 'md'; formats?: ExportFormat[];
}) {
  const start = useStartExport();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size={size} disabled={disabled} loading={start.isPending} data-testid="export-menu"><Download aria-hidden />{t('export.button')}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{t('export.as')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {formats.map(f => {
          const Icon = FORMAT_ICON[f];
          return (
            <DropdownMenuItem key={f} onSelect={() => start.mutate({ body: build(f), name })} data-testid={`export-${f}`}>
              <Icon className="size-4 text-fg-muted" aria-hidden />{t(`export.format.${f}` as 'export.format.xlsx')}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
