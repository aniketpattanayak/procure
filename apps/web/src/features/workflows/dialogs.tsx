'use client';
import { Button, Dialog, DialogContent, FormField, Skeleton, SkeletonGroup, Textarea } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { InlineAlert } from '@/components/page';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { workflowsApi } from './api';
import { Lane, type Names } from './lane';
import { normalize } from './model';

export function PublishDialog({ open, onOpenChange, onPublish, nextVersion, issues, summary }: {
  open: boolean; onOpenChange: (o: boolean) => void; onPublish: (note: string) => Promise<void>; nextVersion: number; issues: number; summary: string;
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
        title={t('wf.publishTitle', { n: nextVersion })}
        description={t('wf.publishBody')}
        closeLabel={t('common.close')}
        data-testid="wf-publish-dialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button onClick={go} loading={busy} disabled={issues > 0} data-testid="wf-publish-confirm">{t('wf.publishConfirm', { n: nextVersion })}</Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="rounded bg-subtle px-3 py-2 text-sm">{summary}</p>
          {error && <InlineAlert data-testid="wf-publish-error">{error}</InlineAlert>}
          <FormField label={t('wf.changeNote')} hint={t('wf.changeNoteHint')}>
            <Textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={3} data-testid="wf-publish-note" />
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function VersionsDialog({ open, onOpenChange, docType, current, names }: { open: boolean; onOpenChange: (o: boolean) => void; docType: string; current: number | null; names: Names }) {
  const versions = useQuery({ queryKey: ['wf-versions', docType], queryFn: () => workflowsApi.versions(docType), enabled: open });
  const [viewing, setViewing] = useState<number | null>(null);
  const def = useQuery({ queryKey: ['wf-version', docType, viewing], queryFn: () => workflowsApi.version(docType, viewing!), enabled: viewing !== null });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) setViewing(null); onOpenChange(o); }}>
      <DialogContent title={viewing ? t('wf.viewVersion', { n: viewing }) : t('wf.versions')} size="lg" closeLabel={t('common.close')} data-testid="wf-versions-dialog"
        footer={viewing ? <Button variant="secondary" onClick={() => setViewing(null)}>{t('wf.backToVersions')}</Button> : undefined}>
        {viewing ? (
          def.isLoading ? <Skeleton className="h-40" /> : def.data ? (
            <div className="-mx-5 -my-4 bg-subtle" data-testid="wf-version-view">
              <Lane def={normalize(def.data)} selected={null} issuesByKey={new Map()} sim={null} names={names} readOnly
                onSelect={() => {}} onInsert={() => {}} onAddParallel={() => {}} onMoveRow={() => {}} onAction={() => {}} />
            </div>
          ) : <InlineAlert>{t('wf.loadError')}</InlineAlert>
        ) : versions.isLoading ? (
          <SkeletonGroup className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></SkeletonGroup>
        ) : !versions.data?.length ? (
          <p className="py-6 text-center text-fg-muted">{t('wf.noVersions')}</p>
        ) : (
          <ol className="divide-y divide-border">
            {[...versions.data].sort((a, b) => b.version - a.version).map(v => (
              <li key={v.version} className="flex items-start gap-3 py-2.5" data-testid={`wf-version-row-${v.version}`}>
                <span className="mt-0.5 inline-grid min-w-9 place-items-center rounded bg-subtle px-1.5 py-0.5 text-sm font-semibold tabular-nums">v{v.version}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{v.changeNote || <span className="text-fg-subtle">{t('wf.noNote')}</span>}</p>
                  <p className="text-xs text-fg-subtle">
                    {[fmtDateTime(v.publishedAt), v.publishedByName ?? null, v.version === current ? t('wf.current') : null].filter(Boolean).join(', ')}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setViewing(v.version)} data-testid={`wf-version-view-${v.version}`}>{t('wf.view')}</Button>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
