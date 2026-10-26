'use client';
import type { AttachmentRow } from '@procure/schema';
import { Button, cn, Skeleton, toast } from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Paperclip, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { FileUpload, fileHref } from '@/components/file-upload';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { useTenantPrincipal } from '@/lib/session';
import { docKeys, docsApi } from './api';

const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

/** Document attachments: list (thumbnail/filename, who, when), add via upload, remove own. */
export function AttachmentsPanel({ type, id, canAttach, compact }: { type: string; id: string; canAttach: boolean; compact?: boolean }) {
  const qc = useQueryClient();
  const me = useTenantPrincipal();
  const list = useQuery({ queryKey: docKeys.attachments(type, id), queryFn: () => docsApi.attachments(type, id) });
  const [pending, setPending] = useState<string[]>([]);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: docKeys.attachments(type, id) });
    void qc.invalidateQueries({ queryKey: docKeys.timeline(type, id) });
  };
  const attach = useMutation({
    mutationFn: async (ids: string[]) => { for (const fileId of ids) await docsApi.attach(type, id, { fileId }); },
    onSuccess: () => { setPending([]); invalidate(); },
    onError: e => toast.error(t('docs.attach.failed'), isApiError(e) ? e.message : undefined),
  });
  const detach = useMutation({
    mutationFn: (attId: string) => docsApi.detach(type, id, attId),
    onSuccess: invalidate,
    onError: e => toast.error(t('docs.attach.removeFailed'), isApiError(e) ? e.message : undefined),
  });

  const rows = list.data ?? [];
  return (
    <div className="space-y-3" data-testid="doc-attachments">
      {list.isLoading ? (
        <div className="space-y-2" aria-busy="true">{[0, 1].map(i => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        !compact && <p className="rounded border border-dashed border-border px-3 py-6 text-center text-fg-muted"><Paperclip className="mx-auto mb-1 size-5 text-fg-subtle" aria-hidden />{t('docs.attach.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded border border-border">
          {rows.map((a: AttachmentRow) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2.5" data-testid="attachment-row">
              {a.file.thumbUrl ? (
                <img src={fileHref(a.file.thumbUrl)} alt="" className="size-10 shrink-0 rounded object-cover" />
              ) : (
                <span className="grid size-10 shrink-0 place-items-center rounded bg-muted text-fg-subtle"><FileText className="size-5" aria-hidden /></span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{a.file.filename}</p>
                <p className="truncate text-xs text-fg-subtle">{fmtSize(a.file.sizeBytes)} · {a.createdBy.name} · {fmtRelative(a.createdAt)}{a.note ? ` · ${a.note}` : ''}</p>
              </div>
              {a.file.url && (
                <Button asChild variant="ghost" size="icon-sm"><a href={fileHref(a.file.url)} target="_blank" rel="noreferrer" aria-label={t('docs.attach.open', { name: a.file.filename })}><Download aria-hidden /></a></Button>
              )}
              {canAttach && a.createdBy.id === me?.userId && (
                <Button variant="ghost" size="icon-sm" className={cn('hover:text-danger')} onClick={() => detach.mutate(a.id)} aria-label={t('docs.attach.remove', { name: a.file.filename })}><Trash2 aria-hidden /></Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canAttach && !compact && (
        <div className="space-y-2">
          <FileUpload value={pending} onChange={v => setPending(Array.isArray(v) ? v : v ? [v] : [])} multiple maxFiles={20} maxSizeMb={25} fieldKey="attachments" />
          {pending.length > 0 && <Button size="sm" onClick={() => attach.mutate(pending)} loading={attach.isPending} data-testid="attach-save">{t('docs.attach.add', { n: pending.length })}</Button>}
        </div>
      )}
    </div>
  );
}
