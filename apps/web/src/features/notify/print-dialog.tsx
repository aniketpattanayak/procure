'use client';
import type { DocTypeSummary, DocumentRow } from '@procure/schema';
import { Button, Dialog, DialogContent, Skeleton, SkeletonGroup, cn } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { FileText, Star } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { notifyKeys, pdfApi, templatesApi, type PdfJobRow } from './api';
import { PdfJobStatus, usePdfJob } from './pdf-job';

/**
 * Print / PDF: lists the document type's PDF layouts when there is more than one (default first), generates the
 * PDF (or returns the cached one for this document and template version) and offers Open / Download when ready.
 * Users who can't read template config print with the default layout.
 */
export function PrintDialog({ docType, doc, onClose }: { docType: DocTypeSummary; doc: DocumentRow; onClose: () => void }) {
  const list = useQuery({
    queryKey: notifyKeys.templates({ channel: 'pdf', docType: docType.key }),
    queryFn: () => templatesApi.list({ channel: 'pdf', docType: docType.key }),
    retry: false,
    staleTime: 60_000,
  });
  const templates = (list.data ?? []).filter(x => x.isActive && (x.docTypeKey === docType.key || x.docTypeKey === null))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(!!b.docTypeKey) - Number(!!a.docTypeKey) || a.name.localeCompare(b.name));
  const [picked, setPicked] = useState<string | null>(null);
  const [job, setJob] = useState<PdfJobRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  const choice = picked ?? templates[0]?.id ?? null;
  const { job: live, timedOut } = usePdfJob(job, useCallback(() => {}, []));

  async function generate(templateId?: string) {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      setJob(await pdfApi.print(docType.key, doc.id, templateId ? { templateId } : {}));
    } catch (e) {
      setError(isApiError(e) ? e.message : t('print.failed'));
    } finally {
      setBusy(false);
    }
  }

  // One layout (or no access to the list): start straight away.
  const needsPick = templates.length > 1;
  useEffect(() => {
    if (started.current || list.isLoading) return;
    if (!needsPick) { started.current = true; void generate(templates[0]?.id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.isLoading, needsPick]);

  const fileName = `${(doc.number ?? docType.key).replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;

  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent title={t('print.title', { number: doc.number ?? docType.name })} closeLabel={t('common.close')} data-testid="print-dialog"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
            {needsPick && <Button onClick={() => void generate(choice ?? undefined)} loading={busy} disabled={!choice} data-testid="print-generate"><FileText aria-hidden />{live ? t('print.regenerate') : t('print.generate')}</Button>}
          </>
        }>
        <div className="space-y-4">
          {list.isLoading ? (
            <SkeletonGroup className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></SkeletonGroup>
          ) : needsPick ? (
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t('print.pickLayout')}</legend>
              <div className="space-y-1.5" role="radiogroup">
                {templates.map(x => (
                  <label key={x.id} className={cn('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5', choice === x.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-subtle')} data-testid={`print-template-${x.key}`}>
                    <input type="radio" name="print-template" className="accent-[rgb(var(--c-accent))]" checked={choice === x.id} onChange={() => setPicked(x.id)} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{x.name}</span>
                      <span className="text-xs text-fg-muted">{x.pdfOptions?.format ?? 'A4'} · {x.pdfOptions?.landscape ? t('tpl.pdf.landscape') : t('tpl.pdf.portrait')}</span>
                    </span>
                    {x.docTypeKey === null
                      ? <span className="text-xs text-fg-subtle">{t('print.forAnyDoc')}</span>
                      : x.isDefault && <span className="inline-flex items-center gap-1 text-xs text-accent"><Star className="size-3" aria-hidden />{t('tpl.default')}</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <p className="text-sm text-fg-muted">{templates[0] ? t('print.usingLayout', { name: templates[0].name }) : t('print.usingDefault')}</p>
          )}
          {error && <InlineAlert data-testid="print-error">{error}</InlineAlert>}
          {busy && !live && <PdfJobStatus job={{ id: 'pending', status: 'queued', fileUrl: null, error: null }} />}
          <PdfJobStatus job={live} timedOut={timedOut} fileName={fileName} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
