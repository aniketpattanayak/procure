'use client';
import type { DocTypeSummary, DocumentRow } from '@procure/schema';
import {
  Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, Tabs, TabsContent,
  TabsList, TabsTrigger, toast,
} from '@procure/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle2, ClipboardCheck, Copy, FileX2, Lock, MoreHorizontal, Pencil, Send, Trash2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Comments } from '@/components/comments/comments';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageSkeleton } from '@/components/guards';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import { Timeline } from '@/components/timeline/timeline';
import { useRenderableForm } from '@/engines/form-renderer/render-api';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { docKeys, docsApi, useDocType } from './api';
import { CancelDialog } from './action-dialogs';
import { AttachmentsPanel } from './attachments-panel';
import { dec } from './decimal';
import { combineForms, mergeRefs, toFormValues } from './form-model';
import { LinesTable } from './lines-table';
import { DocStatusBadge } from './status';
import { docExtension, type DocExtensionContext } from './extensions';
import './extensions-installed';
import { WorkflowProgress } from './workflow-progress';

const FormRenderer = dynamic(() => import('@/engines/form-renderer/form-renderer').then(m => m.FormRenderer), { ssr: false, loading: () => <PageSkeleton rows={3} /> });

type Tab = string;
const BUILTIN_TABS = ['lines', 'timeline', 'comments', 'attachments'];

export function DocDetailPage({ type, id }: { type: string; id: string }) {
  const { docType, isLoading } = useDocType(type);
  const doc = useQuery({ queryKey: docKeys.detail(type, id), queryFn: () => docsApi.get(type, id), retry: false });
  if (isLoading || doc.isLoading) return <PageBody><PageSkeleton rows={8} /></PageBody>;
  if (!docType || doc.isError || !doc.data) {
    const forbidden = isApiError(doc.error) && doc.error.status === 403;
    return <PageBody><EmptyState icon={forbidden ? <Lock /> : <FileX2 />} title={forbidden ? t('guard.noAccess.title') : t('docs.notFound')} description={t('docs.notFoundHint')}
      action={<Button asChild variant="secondary"><Link href={`/docs/${type}`}>{docType?.pluralName ?? t('common.back')}</Link></Button>} /></PageBody>;
  }
  return <DocDetail docType={docType} doc={doc.data} />;
}

function DocDetail({ docType, doc }: { docType: DocTypeSummary; doc: DocumentRow }) {
  const type = docType.key;
  const router = useRouter();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const { currency, timeZone } = useTenantLocale();
  const [tab, setTab] = useState<Tab>(() => sp.get('tab') || 'lines');
  const [focusLineId, setFocusLineId] = useState<string | null>(() => sp.get('line'));
  const [dialog, setDialog] = useState<'submit' | 'cancel' | 'close' | 'delete' | null>(null);
  const a = new Set(doc.allowedActions);

  const header = useRenderableForm(docType.headerFormKey, doc.formVersionId);
  const line = useRenderableForm(docType.lineFormKey, doc.lineFormVersionId, !!docType.lineFormKey);
  const viewForm = useMemo(() => (header.data ? combineForms(header.data, line.data, { label: t('docs.lines'), hideLines: true }) : null), [header.data, line.data]);
  const values = useMemo(() => toFormValues(doc), [doc]);
  const refs = useMemo(() => mergeRefs(doc), [doc]);

  const refresh = (next?: DocumentRow) => {
    if (next) qc.setQueryData(docKeys.detail(type, doc.id), next);
    void qc.invalidateQueries({ queryKey: docKeys.detail(type, doc.id) });
    void qc.invalidateQueries({ queryKey: docKeys.all(type) });
    void qc.invalidateQueries({ queryKey: docKeys.inbox });
  };
  const ext = docExtension(type);
  const ctx: DocExtensionContext = {
    doc, docType, allowed: a, refresh, focusLineId,
    openTab: (k, o) => { setTab(k); if (o?.lineId !== undefined) setFocusLineId(o.lineId); },
  };
  const extTabs = ext.tabs(ctx);
  const activeTab = BUILTIN_TABS.includes(tab) || extTabs.some(x => x.key === tab) ? tab : 'lines';
  const copy = useMutation({
    mutationFn: () => docsApi.copy(type, doc.id),
    onSuccess: d => { toast.success(t('docs.copied')); void qc.invalidateQueries({ queryKey: docKeys.all(type) }); router.push(`/docs/${type}/${d.id}/edit`); },
    onError: e => toast.error(t('docs.copyFailed'), isApiError(e) ? e.message : undefined),
  });

  const actStages = (doc.workflow?.stages ?? []).filter(s => s.status === 'active' && s.canAct);
  const pendingAt = (stageKey: string) => doc.lines.filter(l => dec.gt0(l.stages?.[stageKey]?.pending)).length;
  const heldAt = (stageKey: string) => doc.lines.filter(l => dec.gt0(l.stages?.[stageKey]?.held)).length;
  const canDecide = a.has('decide') || a.has('unhold');
  const justSubmitted = sp.get('submitted') === '1' && doc.number;

  const more = [
    a.has('copy') && { key: 'copy', label: t('docs.action.copy'), icon: Copy, run: () => copy.mutate() },
    a.has('close') && { key: 'close', label: t('docs.action.close'), icon: Lock, run: () => setDialog('close') },
    (a.has('cancel') || a.has('cancel_lines')) && { key: 'cancel', label: t('docs.action.cancel'), icon: Ban, run: () => setDialog('cancel'), danger: true },
    a.has('delete') && { key: 'delete', label: t('docs.action.delete'), icon: Trash2, run: () => setDialog('delete'), danger: true },
  ].filter(Boolean) as { key: string; label: string; icon: typeof Copy; run: () => void; danger?: boolean }[];

  return (
    <PageBody>
      <PageHeader
        back={<Link href={`/docs/${type}`} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{docType.pluralName}</Link>}
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span data-testid="doc-number" className="tabular-nums">{doc.number ?? t('docs.draftTitle', { name: docType.name })}</span>
            <DocStatusBadge statusKey={doc.statusKey} label={doc.statusLabel} docType={docType} className="text-sm" />
          </span>
        }
        description={
          <span className="text-sm">
            {docType.name}
            {doc.values.doc_date ? <> · {fmtDate(String(doc.values.doc_date))}</> : null}
            {doc.createdBy ? <> · {t('docs.createdBy', { name: doc.createdBy.name })}</> : null}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2" data-testid="doc-actions">
            {ext.actions(ctx)}
            {a.has('edit') && <Button asChild variant="secondary"><Link href={`/docs/${type}/${doc.id}/edit`} data-testid="doc-edit"><Pencil aria-hidden />{t('common.edit')}</Link></Button>}
            {a.has('submit') && <Button onClick={() => setDialog('submit')} data-testid="doc-submit"><Send aria-hidden />{t('docs.form.submit')}</Button>}
            {canDecide && actStages[0] && (
              <Button asChild><Link href={`/docs/${type}/${doc.id}/approve?stage=${actStages[0].key}`} data-testid="doc-approve"><ClipboardCheck aria-hidden />{t('docs.action.review')}</Link></Button>
            )}
            {more.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="secondary" size="icon" aria-label={t('docs.action.more')} data-testid="doc-more"><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
                <DropdownMenuContent>
                  {more.map(m => <DropdownMenuItem key={m.key} onSelect={m.run} destructive={m.danger} data-testid={`doc-${m.key}`}><m.icon className="size-4" aria-hidden />{m.label}</DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      />

      {justSubmitted && (
        <InlineAlert tone="success" className="mb-4 flex items-center gap-2" data-testid="doc-submitted">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />{t('docs.submittedAs', { number: doc.number! })}
        </InlineAlert>
      )}

      {ext.banner(ctx)}

      {actStages.map(s => (
        <div key={s.key} className="mb-4 flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 sm:flex-row sm:items-center" data-testid={`act-callout-${s.key}`}>
          <ClipboardCheck className="hidden size-5 shrink-0 text-accent sm:block" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t('docs.act.title', { stage: s.name })}</p>
            <p className="text-sm text-fg-muted">
              {t('docs.act.counts', { pending: pendingAt(s.key), held: heldAt(s.key) })}
              {s.overdue && <span className="ml-2 font-medium text-danger">{t('docs.wf.overdue')}</span>}
            </p>
          </div>
          <Button asChild><Link href={`/docs/${type}/${doc.id}/approve?stage=${s.key}`}>{t('docs.act.open')}</Link></Button>
        </div>
      ))}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="p-4 sm:p-5">
          {viewForm ? (
            <FormRenderer form={viewForm} value={values} onChange={() => {}} mode="view" refs={refs} files={doc.files as never} currency={currency} timeZone={timeZone} idPrefix="docv" />
          ) : <PageSkeleton rows={3} />}
        </Card>
        <Card className="space-y-3 p-4 text-sm">
          <Meta label={t('docs.meta.created')} value={`${doc.createdBy?.name ?? '—'} · ${fmtDateTime(doc.createdAt)}`} />
          <Meta label={t('docs.meta.submitted')} value={doc.submittedAt ? `${doc.submittedBy?.name ?? '—'} · ${fmtDateTime(doc.submittedAt)}` : '—'} />
          <Meta label={t('docs.meta.lines')} value={String(doc.lines.length)} />
          {doc.isLocked && <p className="flex items-center gap-1.5 text-fg-muted"><Lock className="size-3.5" aria-hidden />{t('docs.meta.locked')}</p>}
          {ext.aside(ctx)}
        </Card>
      </div>

      {doc.workflow && (
        <Card className="mt-4 p-4 sm:p-5">
          <WorkflowProgress workflow={doc.workflow} submittedAt={doc.submittedAt} submittedBy={doc.submittedBy?.name ?? null} />
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={v => setTab(v)} className="mt-5">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="lines" data-testid="doc-tab-lines">{t('docs.tabs.lines')} <span className="ml-1 text-fg-subtle">{doc.lines.length}</span></TabsTrigger>
          {extTabs.map(x => <TabsTrigger key={x.key} value={x.key} data-testid={x.testId}>{x.label}{x.badge !== undefined && <span className="ml-1 text-fg-subtle">{x.badge}</span>}</TabsTrigger>)}
          <TabsTrigger value="timeline" data-testid="doc-tab-timeline">{t('docs.tabs.timeline')}</TabsTrigger>
          <TabsTrigger value="comments" data-testid="doc-tab-comments">{t('docs.tabs.comments')}</TabsTrigger>
          <TabsTrigger value="attachments" data-testid="doc-tab-attachments">{t('docs.tabs.attachments')}</TabsTrigger>
        </TabsList>
        <TabsContent value="lines" className="pt-4"><LinesTable doc={doc} docType={docType} extraColumns={ext.lineColumns(ctx)} /></TabsContent>
        {extTabs.map(x => <TabsContent key={x.key} value={x.key} className="pt-4">{activeTab === x.key ? x.render() : null}</TabsContent>)}
        <TabsContent value="timeline" className="pt-4"><TimelineTab type={type} id={doc.id} /></TabsContent>
        <TabsContent value="comments" className="pt-4">
          <Comments
            queryKey={docKeys.comments(type, doc.id)}
            canComment={a.has('comment')}
            onChanged={() => void qc.invalidateQueries({ queryKey: docKeys.timeline(type, doc.id) })}
            api={{
              list: () => docsApi.comments(type, doc.id),
              create: body => docsApi.addComment(type, doc.id, { body }),
              update: (cid, body) => docsApi.editComment(type, doc.id, cid, { body }),
              remove: cid => docsApi.deleteComment(type, doc.id, cid),
            }}
          />
        </TabsContent>
        <TabsContent value="attachments" className="pt-4"><AttachmentsPanel type={type} id={doc.id} canAttach={a.has('attach')} /></TabsContent>
      </Tabs>

      <ConfirmDialog open={dialog === 'submit'} onOpenChange={o => !o && setDialog(null)} testId="submit-dialog"
        title={t('docs.submit.title')} description={t('docs.submit.hint')} confirmLabel={t('docs.form.submit')}
        onConfirm={async () => { const d = await docsApi.submit(type, doc.id, doc.version); refresh(d); toast.success(t('docs.form.submitted', { number: d.number ?? '' })); router.replace(`/docs/${type}/${doc.id}?submitted=1`); }} />
      <ConfirmDialog open={dialog === 'close'} onOpenChange={o => !o && setDialog(null)} testId="close-dialog" requireReason
        title={t('docs.close.title')} description={t('docs.close.hint')} confirmLabel={t('docs.action.close')}
        onConfirm={async reason => { refresh(await docsApi.close(type, doc.id, { reason })); toast.success(t('docs.closed')); }} />
      <ConfirmDialog open={dialog === 'delete'} onOpenChange={o => !o && setDialog(null)} testId="delete-dialog" tone="danger"
        title={t('docs.delete.title')} description={t('docs.delete.hint')} confirmLabel={t('docs.action.delete')}
        onConfirm={async () => { await docsApi.remove(type, doc.id); void qc.invalidateQueries({ queryKey: docKeys.all(type) }); toast.success(t('docs.deleted')); router.replace(`/docs/${type}`); }} />
      {dialog === 'cancel' && (
        <CancelDialog doc={doc} allowWhole={a.has('cancel')} allowLines={a.has('cancel_lines') && docType.settings.allowLineCancel !== false} onClose={() => setDialog(null)}
          onConfirm={async body => { refresh(await docsApi.cancel(type, doc.id, body)); toast.success(t('docs.cancelled')); }} />
      )}
    </PageBody>
  );
}

function TimelineTab({ type, id }: { type: string; id: string }) {
  const q = useQuery({ queryKey: docKeys.timeline(type, id), queryFn: () => docsApi.timeline(type, id) });
  return <Timeline entries={q.data} loading={q.isLoading} error={q.isError} />;
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-fg-subtle">{label}</p>
      <p className="break-words">{value}</p>
    </div>
  );
}
