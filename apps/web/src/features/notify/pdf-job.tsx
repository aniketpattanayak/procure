'use client';
import { Button, cn } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { fileHref } from '@/components/file-upload';
import { t } from '@/i18n';
import { pdfApi, type PdfJobRow } from './api';

const MAX_WAIT_MS = 90_000;

/**
 * Polls `GET /pdf-jobs/:id` until the job is ready or failed (1 s, backing off to 3 s; gives up after 90 s).
 * `initial` is the row returned by print / test-pdf, which may already be ready (cache hit).
 */
export function usePdfJob(initial: PdfJobRow | null, onReady?: (job: PdfJobRow) => void) {
  const started = useRef(Date.now());
  const readyFired = useRef<string | null>(null);
  useEffect(() => { started.current = Date.now(); }, [initial?.id]);
  const q = useQuery({
    queryKey: ['notify', 'pdf-job', initial?.id],
    queryFn: () => pdfApi.job(initial!.id),
    enabled: !!initial && initial.status !== 'ready' && initial.status !== 'failed',
    initialData: initial ?? undefined,
    refetchInterval: query => {
      const s = query.state.data?.status;
      if (s === 'ready' || s === 'failed') return false;
      const elapsed = Date.now() - started.current;
      if (elapsed > MAX_WAIT_MS) return false;
      return elapsed < 5000 ? 1000 : 3000;
    },
    staleTime: 0,
  });
  const job = q.data ?? initial;
  const timedOut = !!job && job.status !== 'ready' && job.status !== 'failed' && Date.now() - started.current > MAX_WAIT_MS;
  useEffect(() => {
    if (job?.status === 'ready' && readyFired.current !== job.id) {
      readyFired.current = job.id;
      onReady?.(job);
    }
  }, [job, onReady]);
  return { job, timedOut, error: q.error };
}

export function pdfUrl(job: PdfJobRow | null | undefined) {
  return job?.fileUrl ? fileHref(job.fileUrl) ?? job.fileUrl : undefined;
}

/** Status line for a PDF job with Open / Download once ready. */
export function PdfJobStatus({ job, timedOut, testId = 'print-status', fileName }: { job: PdfJobRow | null | undefined; timedOut?: boolean; testId?: string; fileName?: string }) {
  if (!job) return null;
  const url = pdfUrl(job);
  const busy = job.status === 'queued' || job.status === 'rendering';
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded border px-3 py-2.5 text-sm',
      job.status === 'failed' || timedOut ? 'border-danger/30 bg-danger-soft text-danger' : job.status === 'ready' ? 'border-success/30 bg-success-soft text-success' : 'border-border bg-subtle text-fg-muted')}
      role="status" aria-live="polite" data-testid={testId} data-status={timedOut ? 'timeout' : job.status}>
      {busy && !timedOut && <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
      {job.status === 'ready' && <CheckCircle2 className="size-4 shrink-0" aria-hidden />}
      {(job.status === 'failed' || timedOut) && <AlertTriangle className="size-4 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1">
        {timedOut ? t('print.status.timeout') : job.status === 'failed' ? (job.error || t('print.status.failed')) : t(`print.status.${job.status}`)}
      </span>
      {job.status === 'ready' && url && (
        <span className="flex gap-2">
          <Button asChild size="sm" variant="secondary"><a href={url} target="_blank" rel="noopener noreferrer" data-testid={`${testId}-open`}><ExternalLink aria-hidden />{t('print.open')}</a></Button>
          <Button asChild size="sm" variant="secondary"><a href={url} download={fileName ?? true} data-testid={`${testId}-download`}><Download aria-hidden />{t('print.download')}</a></Button>
        </span>
      )}
    </div>
  );
}
