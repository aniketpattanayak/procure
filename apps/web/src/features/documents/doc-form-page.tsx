'use client';
import type { DocTypeSummary, DocumentRow, FormEvaluationResult, RenderableForm } from '@procure/schema';
import { LINES_KEY } from '@procure/schema';
import { Button, Card, EmptyState, toast } from '@procure/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileX2, Lock, Save, Send } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { PageSkeleton } from '@/components/guards';
import { InlineAlert, PageBody, PageHeader } from '@/components/page';
import type { FormRendererHandle } from '@/engines/form-renderer';
import { useRenderableForm } from '@/engines/form-renderer/render-api';
import { useTenantLocale } from '@/engines/form-renderer/tenant';
import { formatDecimal } from '@/engines/form-renderer/values';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useCurrentLocationId } from '@/lib/location';
import { usePermissions } from '@/lib/permissions';
import { useTenantPrincipal } from '@/lib/session';
import { docKeys, docsApi, docTab, useDocType } from './api';
import { AttachmentsPanel } from './attachments-panel';
import { combineForms, mergeRefs, newDocValues, normalizeErrorPaths, toFormValues, toWriteBody } from './form-model';
import { todayIn } from '@/engines/form-renderer/formula';
import { DocStatusBadge } from './status';
import { docExtension } from './extensions';
import './extensions-installed';

const FormRenderer = dynamic(() => import('@/engines/form-renderer/form-renderer').then(m => m.FormRenderer), {
  ssr: false,
  loading: () => <PageSkeleton rows={6} />,
});

const LINE_TEST_IDS = { [LINES_KEY]: { row: (i: number) => `line-row-${i + 1}`, add: 'line-add' } };

export function DocFormPage({ type, id }: { type: string; id?: string }) {
  const { docType, isLoading: typesLoading } = useDocType(type);
  const p = usePermissions();
  const doc = useQuery({ queryKey: docKeys.detail(type, id ?? 'new'), queryFn: () => docsApi.get(type, id!), enabled: !!id, retry: false });

  if (typesLoading || !p.ready || (id && doc.isLoading)) return <PageBody><PageSkeleton rows={8} /></PageBody>;
  if (!docType) return <PageBody><EmptyState icon={<FileX2 />} title={t('docs.typeNotFound')} action={<Button asChild variant="secondary"><Link href="/dashboard">{t('masters.goHome')}</Link></Button>} /></PageBody>;
  if (id && (doc.isError || !doc.data)) return <PageBody><EmptyState icon={<FileX2 />} title={t('docs.notFound')} description={t('docs.notFoundHint')} /></PageBody>;
  const allowed = id ? !!doc.data?.allowedActions.includes('edit') : p.can(docTab(type), 'add');
  if (!allowed) {
    return (
      <PageBody>
        <EmptyState icon={<Lock />} title={id ? t('docs.form.notEditable') : t('guard.noAccess.title')} description={id ? t('docs.form.notEditableHint') : t('guard.noAccess.body')}
          action={id ? <Button asChild variant="secondary"><Link href={`/docs/${type}/${id}`}>{t('docs.form.backToDoc')}</Link></Button> : undefined} />
      </PageBody>
    );
  }
  return <DocFormLoader key={doc.data?.version ?? 'new'} docType={docType} doc={doc.data ?? null} />;
}

function DocFormLoader({ docType, doc }: { docType: DocTypeSummary; doc: DocumentRow | null }) {
  const header = useRenderableForm(docType.headerFormKey, doc?.formVersionId);
  const line = useRenderableForm(docType.lineFormKey, doc?.lineFormVersionId, !!docType.lineFormKey);
  if (header.isLoading || (docType.lineFormKey && line.isLoading)) return <PageBody><PageSkeleton rows={8} /></PageBody>;
  if (!header.data) return <PageBody><InlineAlert>{t('docs.form.loadError')}</InlineAlert></PageBody>;
  return <DocForm docType={docType} doc={doc} header={header.data} line={line.data ?? null} />;
}

function DocForm({ docType, doc, header, line }: { docType: DocTypeSummary; doc: DocumentRow | null; header: RenderableForm; line: RenderableForm | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useTenantPrincipal();
  const perms = usePermissions();
  const currentLocation = useCurrentLocationId(me?.userId);
  const { currency, timeZone } = useTenantLocale();
  const type = docType.key;
  const form = useMemo(() => combineForms(header, line, { label: t('docs.lines') }), [header, line]);
  const refs = useMemo(() => mergeRefs(doc), [doc]);

  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (doc) return toFormValues(doc);
    return newDocValues(header, line, todayIn(timeZone), currentLocation ? { location: currentLocation } : {});
  });
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const [newFiles, setNewFiles] = useState<string[]>([]);
  const docRef = useRef<DocumentRow | null>(doc);
  const rendererRef = useRef<FormRendererHandle>(null);
  const [evaluation, setEvaluation] = useState<FormEvaluationResult | null>(null);

  const onChange = useCallback((next: Record<string, unknown>) => { setValues(next); setDirty(true); }, []);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  async function persist(): Promise<DocumentRow> {
    const body = toWriteBody(values, header, line);
    const current = docRef.current;
    const saved = current ? await docsApi.update(type, current.id, { ...body, version: current.version }) : await docsApi.create(type, body);
    docRef.current = saved;
    // Attach files picked on this screen (attachments need a document id).
    for (const fileId of newFiles) {
      try { await docsApi.attach(type, saved.id, { fileId }); } catch (e) { toast.error(t('docs.attach.failed'), isApiError(e) ? e.message : undefined); }
    }
    if (newFiles.length) setNewFiles([]);
    return saved;
  }

  function handleError(e: unknown) {
    if (isApiError(e)) {
      const errs = normalizeErrorPaths(e.errors);
      setErrors(errs);
      if (e.status === 409) setBanner(t('docs.form.conflict'));
      else setBanner(errs.length ? t('docs.form.fixErrors', { n: errs.length }) : e.message);
    } else setBanner(e instanceof Error ? e.message : String(e));
  }

  async function saveDraft() {
    setBusy('save'); setBanner(null); setErrors([]);
    try {
      const saved = await persist();
      setDirty(false);
      void qc.invalidateQueries({ queryKey: docKeys.all(type) });
      toast.success(t('docs.form.saved'));
      if (!doc) router.replace(`/docs/${type}/${saved.id}/edit`);
    } catch (e) { handleError(e); } finally { setBusy(null); }
  }

  async function submit() {
    setBanner(null); setErrors([]);
    const local = rendererRef.current?.validate() ?? {};
    const rows = Array.isArray(values[LINES_KEY]) ? (values[LINES_KEY] as unknown[]) : [];
    if (line && rows.length === 0) { setBanner(t('docs.form.needLine')); return; }
    if (Object.keys(local).length) { setBanner(t('docs.form.fixErrors', { n: Object.keys(local).length })); return; }
    setBusy('submit');
    try {
      const saved = await persist();
      const submitted = await docsApi.submit(type, saved.id, saved.version);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: docKeys.all(type) });
      void qc.invalidateQueries({ queryKey: docKeys.inbox });
      toast.success(t('docs.form.submitted', { number: submitted.number ?? '' }));
      router.push(`/docs/${type}/${submitted.id}?submitted=1`);
    } catch (e) {
      handleError(e);
      // A created-but-not-submitted draft keeps its id: move to its edit URL so a retry updates it.
      if (!doc && docRef.current) router.replace(`/docs/${type}/${docRef.current.id}/edit`);
    } finally { setBusy(null); }
  }

  const rows = Array.isArray(values[LINES_KEY]) ? (values[LINES_KEY] as unknown[]) : [];
  const total = evaluation?.values.total_amount;
  const title = doc ? t('docs.form.editTitle', { name: docType.name, number: doc.number ?? t('docs.draft') }) : t('docs.form.newTitle', { name: docType.name });
  const canSubmit = doc ? doc.allowedActions.includes('submit') : perms.can(docTab(type), 'submit');
  const backHref = doc ? `/docs/${type}/${doc.id}` : `/docs/${type}`;

  return (
    <PageBody className="pb-28">
      <PageHeader
        back={<Link href={backHref} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{doc ? t('docs.form.backToDoc') : docType.pluralName}</Link>}
        title={title}
        description={doc ? <DocStatusBadge statusKey={doc.statusKey} label={doc.statusLabel} docType={docType} /> : docType.description ?? undefined}
      />
      {docExtension(type).formBanner({ doc, docType, errors, values })}
      {banner && <InlineAlert className="mb-4" data-testid="doc-form-error">{banner}</InlineAlert>}
      <Card className="p-4 sm:p-5" data-testid="doc-form">
        <FormRenderer
          ref={rendererRef}
          form={form}
          value={values}
          onChange={onChange}
          errors={errors}
          refs={refs}
          files={doc?.files as never}
          currency={currency}
          timeZone={timeZone}
          onEvaluate={setEvaluation}
          gridTestIds={LINE_TEST_IDS}
          idPrefix="doc"
        />
      </Card>

      <section className="mt-5 space-y-3" aria-labelledby="doc-attachments-h">
        <h2 id="doc-attachments-h" className="text-md font-semibold">{t('docs.tabs.attachments')}</h2>
        {doc && <AttachmentsPanel type={type} id={doc.id} canAttach={doc.allowedActions.includes('attach') || doc.allowedActions.includes('edit')} compact />}
        <FileUpload value={newFiles} onChange={v => { setNewFiles(Array.isArray(v) ? v : v ? [v] : []); setDirty(true); }} multiple maxFiles={20} maxSizeMb={25} fieldKey="attachments" />
        {!doc && newFiles.length > 0 && <p className="text-xs text-fg-subtle">{t('docs.attach.onSave')}</p>}
      </section>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/95 backdrop-blur lg:left-[var(--sidebar-w)]">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1 text-sm text-fg-muted" aria-live="polite">
            <span className="tabular-nums">{t('docs.form.lineCount', { n: rows.length })}</span>
            {total !== undefined && total !== null && total !== '' && (
              <span className="ml-3 font-semibold text-fg tabular-nums" data-testid="doc-total">{formatDecimal(total, 2, { currency })}</span>
            )}
          </div>
          <Button variant="secondary" onClick={() => void saveDraft()} loading={busy === 'save'} disabled={!!busy} data-testid="doc-save"><Save aria-hidden /><span className="hidden sm:inline">{t('docs.form.saveDraft')}</span><span className="sm:hidden">{t('docs.form.save')}</span></Button>
          {canSubmit && <Button onClick={() => void submit()} loading={busy === 'submit'} disabled={!!busy} data-testid="doc-submit"><Send aria-hidden />{t('docs.form.submit')}</Button>}
        </div>
      </div>
    </PageBody>
  );
}
