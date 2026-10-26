'use client';
import { Button, Dialog, DialogContent, FormField, Skeleton, SkeletonGroup, Textarea } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { formsApi } from './api';
import { BuilderPreview } from './preview';

export function PublishDialog({ open, onOpenChange, onPublish, nextVersion, issues }: {
  open: boolean; onOpenChange: (o: boolean) => void; onPublish: (note: string) => Promise<void>; nextVersion: number; issues: number;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onPublish(note.trim());
      setNote('');
      onOpenChange(false);
    } catch (e) {
      setError(isApiError(e) ? [e.message, ...e.errors.map(x => x.message)].join(' · ') : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) setError(null); onOpenChange(o); }}>
      <DialogContent
        title={t('fb.publishTitle', { n: nextVersion })}
        description={t('fb.publishBody')}
        closeLabel={t('common.close')}
        data-testid="publish-dialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button onClick={go} loading={busy} disabled={issues > 0} data-testid="publish-confirm">{t('fb.publishConfirm', { n: nextVersion })}</Button>
          </>
        }
      >
        <div className="space-y-3">
          {error && <InlineAlert data-testid="publish-error">{error}</InlineAlert>}
          <FormField label={t('fb.changeNote')} hint={t('fb.changeNoteHint')}>
            <Textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={3} data-testid="publish-note" />
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function VersionsDialog({ open, onOpenChange, formKey, current }: { open: boolean; onOpenChange: (o: boolean) => void; formKey: string; current: number | null }) {
  const versions = useQuery({ queryKey: ['config-form-versions', formKey], queryFn: () => formsApi.versions(formKey), enabled: open });
  const [viewing, setViewing] = useState<number | null>(null);
  const def = useQuery({ queryKey: ['config-form-version', formKey, viewing], queryFn: () => formsApi.version(formKey, viewing!), enabled: viewing !== null });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) setViewing(null); onOpenChange(o); }}>
      <DialogContent title={viewing ? t('fb.viewVersion', { n: viewing }) : t('fb.versions')} size="lg" closeLabel={t('common.close')} data-testid="versions-dialog"
        footer={viewing ? <Button variant="secondary" onClick={() => setViewing(null)}>{t('fb.backToVersions')}</Button> : undefined}>
        {viewing ? (
          def.isLoading ? <Skeleton className="h-40" /> : def.data ? <div className="-mx-5 -my-4 bg-subtle"><BuilderPreview formKey={formKey} def={def.data} title={t('fb.viewVersionHint')} /></div> : <InlineAlert>{t('fb.loadError')}</InlineAlert>
        ) : versions.isLoading ? (
          <SkeletonGroup className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></SkeletonGroup>
        ) : !versions.data?.length ? (
          <p className="py-6 text-center text-fg-muted">{t('fb.noVersions')}</p>
        ) : (
          <ol className="divide-y divide-border">
            {[...versions.data].sort((a, b) => b.version - a.version).map(v => (
              <li key={v.id} className="flex items-start gap-3 py-2.5" data-testid={`version-row-${v.version}`}>
                <span className="mt-0.5 inline-grid min-w-9 place-items-center rounded bg-subtle px-1.5 py-0.5 text-sm font-semibold tabular-nums">v{v.version}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{v.changeNote || <span className="text-fg-subtle">{t('fb.noNote')}</span>}</p>
                  <p className="text-xs text-fg-subtle">{fmtDateTime(v.publishedAt)}{(v as typeof v & { publishedByName?: string | null }).publishedByName ? ` · ${(v as typeof v & { publishedByName?: string | null }).publishedByName}` : ''}{v.version === current ? ` · ${t('fb.current')}` : ''}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setViewing(v.version)} data-testid={`version-view-${v.version}`}>{t('fb.view')}</Button>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
