'use client';
import { TemplateInput } from '@procure/schema';
import {
  Button, EmptyState, FormField, Input, Label, NativeSelect, Segmented, Skeleton, Switch, toast,
} from '@procure/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileText, FileX2, Info, Save } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { InlineAlert } from '@/components/page';
import { t, type MessageKey } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { usePermissions } from '@/lib/permissions';
import { useDebounced } from '@/lib/use-debounced';
import { docsApi, useDocTypes } from '@/features/documents/api';
import {
  notifyKeys, templatesApi, type ContextField, type PdfJobRow, type PdfOptions, type TemplateBody, type TemplateChannel, type TemplateRow,
  type WhatsAppTemplate,
} from '@/features/notify/api';
import { PdfJobStatus, pdfUrl, usePdfJob } from '@/features/notify/pdf-job';
import { ChannelTag } from '@/features/notify/ui';
import { TemplateCodeEditor, type TemplateCodeEditorHandle } from './code-editor';
import { PlaceholderPicker } from './placeholder-picker';
import { snippetFor } from './placeholders';
import { EmailPreview, InAppPreview, PaperPreview, WhatsAppBubble } from './previews';

const DEFAULT_PDF: PdfOptions = { format: 'A4', landscape: false, marginMm: { top: 15, right: 12, bottom: 15, left: 12 } };

const STARTER: Record<TemplateChannel, Partial<TemplateBody>> = {
  pdf: { body: '<h1>{{document.number}}</h1>\n<p>{{formatDate document.docDate \'DD-MMM-YYYY\'}}</p>\n\n<table style="width:100%">\n  {{#each lines}}\n  <tr><td>{{lineNo}}</td><td>{{item.name}}</td><td>{{qty}} {{uom}}</td></tr>\n  {{/each}}\n</table>\n' },
  email: { subject: '{{document.number}} from {{tenant.name}}', body: '<p>Dear {{recipient.name}},</p>\n<p></p>\n<p>Regards,<br>{{tenant.name}}</p>\n' },
  whatsapp: { body: '-' },
  inapp: { subject: '{{document.number}}', body: '{{event.actor.name}} …' },
};

function keyFromName(name: string) {
  let k = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(k)) k = `t_${k}`;
  return k.slice(0, 60).replace(/_+$/, '') || 'template';
}

function toBody(r: TemplateRow): TemplateBody {
  return {
    channel: r.channel, docTypeKey: r.docTypeKey ?? null, key: r.key, name: r.name, subject: r.subject ?? '', body: r.body,
    whatsappTemplateId: r.whatsappTemplateId, whatsappVariables: r.whatsappVariables ?? [], pdfOptions: { ...DEFAULT_PDF, ...(r.pdfOptions ?? {}), marginMm: { ...DEFAULT_PDF.marginMm, ...(r.pdfOptions?.marginMm ?? {}) } },
    isDefault: r.isDefault, isActive: r.isActive,
  };
}

/** Strip HTML to text (WhatsApp / in-app previews come back as HTML-escaped text). */
function htmlToText(html: string) {
  if (typeof DOMParser === 'undefined') return html;
  return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
}
const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

export function TemplateEditorPage({ id }: { id: string }) {
  const sp = useSearchParams();
  const isNew = id === 'new';
  const copyOf = sp.get('copy');
  const list = useQuery({ queryKey: notifyKeys.templatesAll, queryFn: () => templatesApi.list() });
  const row = isNew ? null : list.data?.find(r => r.id === id) ?? null;
  const source = copyOf ? list.data?.find(r => r.id === copyOf) ?? null : null;

  if (list.isLoading) return <EditorSkeleton />;
  if (!isNew && !row) {
    return <div className="p-6"><EmptyState icon={<FileX2 />} title={t('tpl.notFound')} action={<Button asChild variant="secondary"><Link href="/config/templates">{t('tpl.title')}</Link></Button>} /></div>;
  }
  let initial: TemplateBody;
  if (row) initial = toBody(row);
  else if (source) initial = { ...toBody(source), name: t('tpl.copyName', { name: source.name }), key: `${source.key}_copy`.slice(0, 60), isDefault: false };
  else {
    const channel = (['pdf', 'email', 'whatsapp', 'inapp'].includes(sp.get('channel') ?? '') ? sp.get('channel') : 'pdf') as TemplateChannel;
    initial = { channel, docTypeKey: sp.get('docType') || null, key: '', name: '', subject: '', body: '', whatsappVariables: [], pdfOptions: DEFAULT_PDF, isDefault: false, isActive: true, ...STARTER[channel] };
  }
  return <Editor key={row?.id ?? `new-${copyOf ?? ''}`} row={row} initial={initial} />;
}

function EditorSkeleton() {
  return (
    <div className="flex h-[calc(100dvh-var(--topbar-h))] flex-col">
      <div className="border-b border-border px-4 py-3"><Skeleton className="h-7 w-72" /></div>
      <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[15rem_1fr_1fr]"><Skeleton /><Skeleton /><Skeleton /></div>
    </div>
  );
}

type PdfPane = 'body' | 'header' | 'footer' | 'page';

function Editor({ row, initial }: { row: TemplateRow | null; initial: TemplateBody }) {
  const router = useRouter();
  const qc = useQueryClient();
  const p = usePermissions();
  const canEdit = p.has('config.templates:action.edit');
  const [v, setV] = useState<TemplateBody>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [keyTouched, setKeyTouched] = useState(!!row || !!initial.key);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pane, setPane] = useState<PdfPane>('body');
  const [docId, setDocId] = useState('');
  const [testJob, setTestJob] = useState<PdfJobRow | null>(null);
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit');
  const testWin = useRef<Window | null>(null);
  const dirty = JSON.stringify(v) !== baseline;
  const channel = v.channel;
  const opts: PdfOptions = { ...DEFAULT_PDF, ...(v.pdfOptions ?? {}) } as PdfOptions;

  const docTypes = useDocTypes();
  const docType = docTypes.data?.find(d => d.key === v.docTypeKey) ?? null;
  const fieldsQ = useQuery({ queryKey: notifyKeys.contextFields(v.docTypeKey), queryFn: () => templatesApi.contextFields(v.docTypeKey), staleTime: 5 * 60_000 });
  const fields: ContextField[] = fieldsQ.data ?? [];
  const waQ = useQuery({ queryKey: notifyKeys.waAllowed, queryFn: templatesApi.whatsapp, enabled: channel === 'whatsapp', staleTime: 60_000 });
  const wa: WhatsAppTemplate | null = waQ.data?.find(w => w.id === v.whatsappTemplateId) ?? null;

  const set = <K extends keyof TemplateBody>(k: K, val: TemplateBody[K]) => setV(s => ({ ...s, [k]: val }));
  const setOpt = <K extends keyof PdfOptions>(k: K, val: PdfOptions[K]) => setV(s => ({ ...s, pdfOptions: { ...DEFAULT_PDF, ...(s.pdfOptions ?? {}), [k]: val } }));

  // Unsaved changes guard (reload / close tab).
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // ----- insertion target: the editor that last had focus
  const bodyRef = useRef<TemplateCodeEditorHandle>(null);
  const subjectRef = useRef<TemplateCodeEditorHandle>(null);
  const headerRef = useRef<TemplateCodeEditorHandle>(null);
  const footerRef = useRef<TemplateCodeEditorHandle>(null);
  const varRefs = useRef(new Map<number, TemplateCodeEditorHandle | null>());
  const active = useRef<TemplateCodeEditorHandle | null>(null);
  const target = () => active.current ?? (channel === 'whatsapp' ? varRefs.current.values().next().value ?? null : pane === 'header' ? headerRef.current : pane === 'footer' ? footerRef.current : bodyRef.current);
  const pick = (f: ContextField) => {
    const ed = target();
    if (!ed) return;
    const s = snippetFor(f, ed.insideLines());
    ed.insert(s.text, s.caret);
  };
  const helper = (snippet: string) => target()?.insert(snippet);
  const track = (h: () => TemplateCodeEditorHandle | null) => ({ onFocusCapture: () => { active.current = h(); } });

  // ----- live preview
  const waBody = useMemo(() => (wa ? wa.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => (v.whatsappVariables ?? []).find(x => x.index === Number(n))?.expr || `[${n}]`) : ''), [wa, v.whatsappVariables]);
  const previewInput = useMemo<TemplateBody>(() => {
    if (channel === 'whatsapp') return { ...v, channel: 'email', subject: undefined, body: escapeHtml(waBody || ' ') };
    return { ...v, body: v.body || ' ' };
  }, [v, channel, waBody]);
  const debounced = useDebounced(JSON.stringify(previewInput), 450);
  const preview = useQuery({
    queryKey: ['notify', 'tpl-preview', debounced, docId],
    queryFn: () => templatesApi.preview(JSON.parse(debounced) as TemplateBody, docId || undefined),
    placeholderData: keepPreviousData,
    enabled: channel !== 'whatsapp' || !!wa,
    retry: false,
  });

  // Header and footer go through the same renderer so placeholders show filled in (one call, split on a marker).
  const SPLIT = '<!--procure-hf-split-->';
  const hfSource = channel === 'pdf' && (opts.headerHtml || opts.footerHtml) ? `${opts.headerHtml ?? ''}${SPLIT}${opts.footerHtml ?? ''}` : '';
  const hfDebounced = useDebounced(hfSource, 450);
  const hf = useQuery({
    queryKey: ['notify', 'tpl-preview-hf', v.docTypeKey, hfDebounced, docId],
    queryFn: () => templatesApi.preview({ ...v, channel: 'pdf', body: hfDebounced }, docId || undefined),
    enabled: !!hfDebounced,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const [hfHeader, hfFooter] = (hf.data?.html ?? '').split(SPLIT);
  const previewOpts: PdfOptions = { ...opts, headerHtml: opts.headerHtml ? (hfHeader ?? opts.headerHtml) : undefined, footerHtml: opts.footerHtml ? (hfFooter ?? opts.footerHtml) : undefined };

  const docs = useQuery({
    queryKey: ['notify', 'tpl-docs', v.docTypeKey],
    queryFn: () => docsApi.list(v.docTypeKey!, { view: 'document' }, null, 25),
    enabled: !!v.docTypeKey,
    staleTime: 60_000,
    retry: false,
  });

  // ----- save
  const validate = (): TemplateBody | null => {
    const body: TemplateBody = {
      ...v,
      subject: channel === 'email' || channel === 'inapp' ? v.subject : undefined,
      body: channel === 'whatsapp' ? (wa?.body ?? (v.body || '-')) : v.body,
      whatsappTemplateId: channel === 'whatsapp' ? v.whatsappTemplateId : undefined,
      whatsappVariables: channel === 'whatsapp' ? v.whatsappVariables : [],
      pdfOptions: channel === 'pdf' ? { ...opts, headerHtml: opts.headerHtml || undefined, footerHtml: opts.footerHtml || undefined } : undefined,
    };
    const parsed = TemplateInput.safeParse(body);
    const errs: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
    if (channel === 'whatsapp' && !v.whatsappTemplateId) errs.whatsappTemplateId = t('tpl.wa.pickRequired');
    if (channel === 'email' && !v.subject?.trim()) errs.subject = t('tpl.email.subjectRequired');
    setErrors(errs);
    return Object.keys(errs).length ? null : body;
  };

  const save = useCallback(async (): Promise<TemplateRow | null> => {
    const body = validate();
    if (!body) { setSaveError(t('tpl.fixErrors')); return null; }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = row ? await templatesApi.update(row.id, { ...body, version: row.version }) : await templatesApi.create(body);
      await qc.invalidateQueries({ queryKey: notifyKeys.templatesAll });
      setBaseline(JSON.stringify(v));
      toast.success(t('tpl.saved', { version: saved.version }));
      if (!row) router.replace(`/config/templates/${saved.id}`);
      return saved;
    } catch (e) {
      if (isApiError(e)) {
        const errs: Record<string, string> = {};
        for (const fe of e.errors) if (fe.path) errs[fe.path.split('.')[0]!] = fe.message;
        setErrors(errs);
        setSaveError(e.status === 409 && !e.code.startsWith('LIMIT') ? t('tpl.conflict') : e.message);
      } else setSaveError(String(e));
      return null;
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, row, wa]);

  // Ctrl+S saves.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (canEdit) void save(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save, canEdit]);

  // ----- test PDF: open a window now (popup blockers allow it only on the click) and point it at the file when ready
  const { job, timedOut } = usePdfJob(testJob, useCallback((j: PdfJobRow) => {
    const url = pdfUrl(j);
    if (url && testWin.current && !testWin.current.closed) testWin.current.location.href = url;
    testWin.current = null;
  }, []));
  useEffect(() => { if ((job?.status === 'failed' || timedOut) && testWin.current) { testWin.current.close(); testWin.current = null; } }, [job?.status, timedOut]);
  async function testPdf() {
    testWin.current = window.open('', '_blank');
    if (testWin.current) testWin.current.document.title = t('print.status.rendering');
    let id = row?.id;
    if (!id || dirty) {
      const saved = await save();
      if (!saved) { testWin.current?.close(); testWin.current = null; return; }
      id = saved.id;
    }
    try {
      setTestJob(await templatesApi.testPdf(id, docId || undefined));
    } catch (e) {
      testWin.current?.close();
      testWin.current = null;
      toast.error(t('print.failed'), isApiError(e) ? e.message : undefined);
    }
  }

  const docTypeName = docType?.name ?? (v.docTypeKey ? v.docTypeKey : t('tpl.anyDocument'));

  return (
    <div className="flex min-h-[calc(100dvh-var(--topbar-h))] flex-col lg:h-[calc(100dvh-var(--topbar-h)-var(--banner-h))]" data-testid="tpl-editor" data-channel={channel} data-dirty={dirty}>
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2.5">
        <Link href="/config/templates" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" aria-hidden />{t('tpl.title')}</Link>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Input value={v.name} onChange={e => { const name = e.target.value; setV(s => ({ ...s, name, key: keyTouched ? s.key : keyFromName(name) })); }}
            placeholder={t('tpl.namePlaceholder')} aria-label={t('tpl.name')} aria-invalid={!!errors.name} className="h-8 w-64 max-w-full font-semibold" data-testid="tpl-name" readOnly={!canEdit} />
          <ChannelTag channel={channel} className="text-fg-muted" />
          <span className="text-sm text-fg-subtle">·</span>
          <span className="text-sm text-fg-muted" data-testid="tpl-doctype-label">{docTypeName}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-fg-subtle" data-testid="tpl-version" aria-live="polite">
            {dirty ? t('tpl.unsaved') : row ? t('tpl.versionLine', { v: row.version, when: fmtRelative(row.updatedAt) }) : t('tpl.notSaved')}
          </span>
          {channel === 'pdf' && (
            <Button variant="secondary" size="sm" onClick={() => void testPdf()} loading={saving && !!testWin.current} disabled={!canEdit && !row} data-testid="tpl-test-pdf">
              <FileText aria-hidden />{dirty || !row ? t('tpl.saveAndTest') : t('tpl.testPdf')}
            </Button>
          )}
          {canEdit && <Button size="sm" onClick={() => void save()} loading={saving} disabled={!dirty && !!row} data-testid="tpl-save"><Save aria-hidden />{t('tpl.save')}</Button>}
        </div>
      </div>

      {(saveError || (channel === 'pdf' && job)) && (
        <div className="space-y-2 border-b border-border bg-surface px-4 py-2">
          {saveError && <InlineAlert data-testid="tpl-save-error">{saveError}</InlineAlert>}
          {channel === 'pdf' && <PdfJobStatus job={job} timedOut={timedOut} testId="tpl-test-status" />}
        </div>
      )}

      <div className="border-b border-border px-4 py-2 lg:hidden">
        <Segmented label={t('tpl.mobileView')} value={mobileView} onChange={setMobileView} options={[{ value: 'edit', label: t('tpl.edit') }, { value: 'preview', label: t('tpl.preview') }]} />
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[15rem_minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[16rem_minmax(0,1.1fr)_minmax(0,1fr)]">
        {/* Placeholder rail */}
        <aside className={`${mobileView === 'edit' ? 'block' : 'hidden'} min-h-0 border-b border-border bg-surface p-3 lg:block lg:border-b-0 lg:border-r`} aria-label={t('tpl.ph.title')}>
          <h2 className="mb-2 text-sm font-semibold">{t('tpl.ph.title')}</h2>
          <p className="mb-2 text-xs text-fg-muted">{t('tpl.ph.hint')}</p>
          <PlaceholderPicker fields={fields} loading={fieldsQ.isLoading} onPick={pick} onHelper={helper} className="max-h-72 lg:h-[calc(100%-4.5rem)] lg:max-h-none" />
        </aside>

        {/* Editor column */}
        <section className={`${mobileView === 'edit' ? 'flex' : 'hidden'} min-h-0 flex-col gap-3 overflow-y-auto bg-surface p-4 lg:flex lg:border-r lg:border-border`} aria-label={t('tpl.edit')}>
          <Settings v={v} set={set} errors={errors} canEdit={canEdit} keyTouched={keyTouched} setKeyTouched={setKeyTouched} isNew={!row} docTypes={docTypes.data ?? []} />

          {channel === 'pdf' && (
            <>
              <Segmented label={t('tpl.pdf.panes')} value={pane} onChange={x => { setPane(x); active.current = null; }} data-testid="tpl-pane" size="md"
                options={(['body', 'header', 'footer', 'page'] as PdfPane[]).map(x => ({ value: x, label: t(`tpl.pdf.pane.${x}` as MessageKey) }))} />
              <div className={pane === 'body' ? 'flex min-h-[24rem] flex-1 flex-col' : 'hidden'} {...track(() => bodyRef.current)}>
                <TemplateCodeEditor ref={bodyRef} value={v.body} onChange={x => set('body', x)} fields={fields} label={t('tpl.body')} testId="tpl-body" />
                {errors.body && <p className="mt-1 text-sm text-danger">{errors.body}</p>}
              </div>
              {pane === 'header' && (
                <div className="space-y-1.5" {...track(() => headerRef.current)}>
                  <TemplateCodeEditor ref={headerRef} value={opts.headerHtml ?? ''} onChange={x => setOpt('headerHtml', x)} fields={fields} label={t('tpl.pdf.header')} testId="tpl-header" minHeight="10rem" />
                  <PageVarHint onInsert={s => headerRef.current?.insert(s)} />
                </div>
              )}
              {pane === 'footer' && (
                <div className="space-y-1.5" {...track(() => footerRef.current)}>
                  <TemplateCodeEditor ref={footerRef} value={opts.footerHtml ?? ''} onChange={x => setOpt('footerHtml', x)} fields={fields} label={t('tpl.pdf.footer')} testId="tpl-footer" minHeight="10rem" />
                  <PageVarHint onInsert={s => footerRef.current?.insert(s)} />
                </div>
              )}
              {pane === 'page' && <PageSetup opts={opts} setOpt={setOpt} />}
            </>
          )}

          {channel === 'email' && (
            <>
              <Field label={t('tpl.email.subject')} error={errors.subject}>
                {() => <div {...track(() => subjectRef.current)}><TemplateCodeEditor ref={subjectRef} compact value={v.subject ?? ''} onChange={x => set('subject', x)} fields={fields} label={t('tpl.email.subject')} testId="tpl-subject" /></div>}
              </Field>
              <div className="flex min-h-[22rem] flex-1 flex-col" {...track(() => bodyRef.current)}>
                <Label className="mb-1.5">{t('tpl.email.body')}</Label>
                <TemplateCodeEditor ref={bodyRef} value={v.body} onChange={x => set('body', x)} fields={fields} label={t('tpl.email.body')} testId="tpl-body" />
                {errors.body && <p className="mt-1 text-sm text-danger">{errors.body}</p>}
              </div>
            </>
          )}

          {channel === 'inapp' && (
            <>
              <Field label={t('tpl.inapp.title')} error={errors.subject}>
                {() => <div {...track(() => subjectRef.current)}><TemplateCodeEditor ref={subjectRef} compact value={v.subject ?? ''} onChange={x => set('subject', x)} fields={fields} label={t('tpl.inapp.title')} testId="tpl-subject" /></div>}
              </Field>
              <Field label={t('tpl.inapp.body')} error={errors.body}>
                {() => <div {...track(() => bodyRef.current)}><TemplateCodeEditor ref={bodyRef} compact minHeight="6rem" value={v.body} onChange={x => set('body', x)} fields={fields} label={t('tpl.inapp.body')} testId="tpl-body" /></div>}
              </Field>
            </>
          )}

          {channel === 'whatsapp' && (
            <WhatsAppMapping v={v} set={set} wa={wa} options={waQ.data ?? []} loading={waQ.isLoading} error={errors.whatsappTemplateId} fields={fields}
              register={(i, h) => { varRefs.current.set(i, h); }} onFocusVar={i => { active.current = varRefs.current.get(i) ?? null; }} />
          )}

          <p className="flex items-start gap-1.5 text-xs text-fg-muted" data-testid="tpl-versions-note">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {row ? t('tpl.versionsNote', { next: row.version + 1 }) : t('tpl.versionsNoteNew')}
          </p>
        </section>

        {/* Preview column */}
        <section className={`${mobileView === 'preview' ? 'flex' : 'hidden'} min-h-0 flex-col bg-subtle lg:flex`} aria-label={t('tpl.preview')} data-testid="tpl-preview">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/70 px-4 py-2">
            <h2 className="text-sm font-semibold">{t('tpl.preview')}</h2>
            <span className="text-xs text-fg-subtle" aria-live="polite">{preview.isFetching ? t('tpl.preview.updating') : preview.isError ? '' : t('tpl.preview.live')}</span>
            <label className="ml-auto flex items-center gap-2 text-sm">
              <span className="text-fg-muted">{t('tpl.preview.with')}</span>
              <NativeSelect value={docId} onChange={e => setDocId(e.target.value)} className="h-8 w-auto max-w-[14rem] text-sm" data-testid="tpl-preview-doc" disabled={!v.docTypeKey}>
                <option value="">{t('tpl.preview.sample')}</option>
                {(docs.data?.data ?? []).filter(d => 'id' in d).map(d => {
                  const r = d as { id: string; number: string | null; statusLabel: string };
                  return <option key={r.id} value={r.id}>{r.number ?? t('tpl.preview.draft')} · {r.statusLabel}</option>;
                })}
              </NativeSelect>
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {preview.isError && (
              <InlineAlert className="mb-3" data-testid="tpl-preview-error">{isApiError(preview.error) ? preview.error.message : t('tpl.preview.error')}</InlineAlert>
            )}
            {channel === 'pdf' && <PaperPreview html={preview.data?.html ?? ''} options={previewOpts} loading={preview.isFetching} />}
            {channel === 'email' && <EmailPreview subject={preview.data?.subject ?? null} html={preview.data?.html ?? ''} to={t('tpl.email.recipientSample')} />}
            {channel === 'inapp' && <InAppPreview title={preview.data?.subject ?? null} body={htmlToText(preview.data?.html ?? '')} />}
            {channel === 'whatsapp' && (wa
              ? <WhatsAppBubble body={htmlToText(preview.data?.html ?? '')} headerKind={wa.headerKind} templateName={`${wa.name} · ${wa.language}`} />
              : <EmptyState title={t('tpl.wa.pickFirst')} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && !error && <p className="text-xs text-fg-muted">{hint}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function Settings({ v, set, errors, canEdit, keyTouched, setKeyTouched, isNew, docTypes }: {
  v: TemplateBody; set: <K extends keyof TemplateBody>(k: K, val: TemplateBody[K]) => void; errors: Record<string, string>; canEdit: boolean;
  keyTouched: boolean; setKeyTouched: (b: boolean) => void; isNew: boolean; docTypes: { key: string; name: string }[];
}) {
  return (
    <details className="group rounded-lg border border-border" open={isNew || !!errors.key || !!errors.docTypeKey}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
        <span className="font-medium">{t('tpl.settings')}</span>
        <span className="truncate text-fg-subtle">{v.key || '—'}{v.isDefault ? ` · ${t('tpl.default')}` : ''}{v.isActive === false ? ` · ${t('tpl.inactive')}` : ''}</span>
        <span className="ml-auto text-xs text-accent group-open:hidden">{t('common.edit')}</span>
      </summary>
      <div className="grid gap-3 border-t border-border p-3 sm:grid-cols-2">
        <Field label={t('tpl.docType')} error={errors.docTypeKey} hint={t('tpl.docTypeHint')}>
          {id => (
            <NativeSelect id={id} value={v.docTypeKey ?? ''} onChange={e => set('docTypeKey', e.target.value || null)} disabled={!canEdit} data-testid="tpl-doctype">
              <option value="">{t('tpl.anyDocument')}</option>
              {docTypes.map(d => <option key={d.key} value={d.key}>{d.name}</option>)}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('tpl.key')} error={errors.key} hint={t('tpl.keyHint')}>
          {id => <Input id={id} value={v.key} onChange={e => { setKeyTouched(true); set('key', e.target.value); }} className="font-mono text-sm" readOnly={!canEdit || !isNew} data-testid="tpl-key" data-touched={keyTouched} aria-invalid={!!errors.key} />}
        </Field>
        <label className="flex items-start gap-2.5 text-sm sm:col-span-1">
          <Switch checked={!!v.isDefault} onCheckedChange={c => set('isDefault', c)} disabled={!canEdit} data-testid="tpl-default" className="mt-0.5" />
          <span><span className="font-medium">{t('tpl.defaultToggle')}</span><span className="block text-xs text-fg-muted">{t('tpl.defaultHint')}</span></span>
        </label>
        <label className="flex items-start gap-2.5 text-sm">
          <Switch checked={v.isActive !== false} onCheckedChange={c => set('isActive', c)} disabled={!canEdit} data-testid="tpl-active" className="mt-0.5" />
          <span><span className="font-medium">{t('tpl.activeToggle')}</span><span className="block text-xs text-fg-muted">{t('tpl.activeHint')}</span></span>
        </label>
      </div>
    </details>
  );
}

function PageVarHint({ onInsert }: { onInsert: (s: string) => void }) {
  const vars = [['pageNumber', 'tpl.pdf.var.page'], ['totalPages', 'tpl.pdf.var.total'], ['date', 'tpl.pdf.var.date']] as const;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
      <span>{t('tpl.pdf.pageVars')}</span>
      {vars.map(([cls, label]) => (
        <button key={cls} type="button" className="rounded border border-border bg-subtle px-1.5 py-0.5 hover:border-accent hover:text-accent" onClick={() => onInsert(`<span class="${cls}"></span>`)} data-testid={`tpl-pagevar-${cls}`}>
          {t(label)}
        </button>
      ))}
    </div>
  );
}

function PageSetup({ opts, setOpt }: { opts: PdfOptions; setOpt: <K extends keyof PdfOptions>(k: K, val: PdfOptions[K]) => void }) {
  const m = opts.marginMm ?? DEFAULT_PDF.marginMm;
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  return (
    <div className="space-y-4" data-testid="tpl-page-setup">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={t('tpl.pdf.paper')}>
          <NativeSelect value={opts.format} onChange={e => setOpt('format', e.target.value as PdfOptions['format'])} data-testid="tpl-pdf-format">
            {(['A4', 'A5', 'Letter', 'Legal'] as const).map(f => <option key={f} value={f}>{t(`tpl.pdf.paper.${f}` as MessageKey)}</option>)}
          </NativeSelect>
        </FormField>
        <div className="space-y-1.5">
          <span className="block text-sm font-medium">{t('tpl.pdf.orientation')}</span>
          <Segmented label={t('tpl.pdf.orientation')} size="md" value={opts.landscape ? 'landscape' : 'portrait'} onChange={x => setOpt('landscape', x === 'landscape')} data-testid="tpl-pdf-orientation"
            options={[{ value: 'portrait', label: t('tpl.pdf.portrait') }, { value: 'landscape', label: t('tpl.pdf.landscape') }]} />
        </div>
      </div>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{t('tpl.pdf.margins')}</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {sides.map(s => (
            <label key={s} className="space-y-1 text-sm">
              <span className="text-fg-muted">{t(`tpl.pdf.margin.${s}` as MessageKey)}</span>
              <span className="flex items-center gap-1.5">
                <Input type="number" min={0} max={50} step={1} value={m[s]} className="h-8 tabular-nums"
                  onChange={e => setOpt('marginMm', { ...m, [s]: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })} data-testid={`tpl-margin-${s}`} />
                <span className="text-fg-subtle">mm</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-xs text-fg-muted">{t('tpl.pdf.setupHint')}</p>
    </div>
  );
}

function WhatsAppMapping({ v, set, wa, options, loading, error, fields, register, onFocusVar }: {
  v: TemplateBody; set: <K extends keyof TemplateBody>(k: K, val: TemplateBody[K]) => void; wa: WhatsAppTemplate | null; options: WhatsAppTemplate[];
  loading: boolean; error?: string; fields: ContextField[]; register: (i: number, h: TemplateCodeEditorHandle | null) => void; onFocusVar: (i: number) => void;
}) {
  const vars = v.whatsappVariables ?? [];
  const setVar = (index: number, expr: string) => set('whatsappVariables', [...vars.filter(x => x.index !== index), { index, expr }].sort((a, b) => a.index - b.index));
  return (
    <div className="space-y-4">
      <Field label={t('tpl.wa.template')} error={error} hint={t('tpl.wa.templateHint')}>
        {id => (
          <NativeSelect id={id} value={v.whatsappTemplateId ?? ''} disabled={loading}
            onChange={e => {
              const next = options.find(o => o.id === e.target.value);
              set('whatsappTemplateId', e.target.value || undefined);
              if (next) set('whatsappVariables', next.variables.map(x => ({ index: x.index, expr: vars.find(y => y.index === x.index)?.expr ?? '' })));
            }} data-testid="tpl-wa-template">
            <option value="">{loading ? t('common.loading') : t('tpl.wa.choose')}</option>
            {options.map(o => <option key={o.id} value={o.id}>{o.name} · {o.language}</option>)}
          </NativeSelect>
        )}
      </Field>
      {!loading && !options.length && <InlineAlert tone="info" data-testid="tpl-wa-none">{t('tpl.wa.noneAllowed')}</InlineAlert>}
      {wa && (
        <>
          <div className="rounded border border-border bg-subtle px-3 py-2 text-sm" data-testid="tpl-wa-body">
            <p className="mb-1 text-xs text-fg-subtle">{t('tpl.wa.approvedText', { category: wa.category })}</p>
            <p className="whitespace-pre-wrap">{wa.body.split(/(\{\{\d+\}\})/g).map((part, i) => (/^\{\{\d+\}\}$/.test(part) ? <mark key={i} className="rounded bg-warning-soft px-0.5 font-mono text-warning">{part}</mark> : part))}</p>
          </div>
          <div className="space-y-3" data-testid="tpl-wa-vars">
            {wa.variables.map(x => (
              <div key={x.index} className="grid gap-1.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start" onFocusCapture={() => onFocusVar(x.index)}>
                <span className="pt-1.5 text-sm"><code className="mr-1.5 text-warning">{`{{${x.index}}}`}</code>{x.label}</span>
                <TemplateCodeEditor ref={h => register(x.index, h)} compact value={vars.find(y => y.index === x.index)?.expr ?? ''} onChange={e => setVar(x.index, e)}
                  fields={fields} label={t('tpl.wa.varLabel', { n: x.index, label: x.label })} testId={`tpl-wa-var-${x.index}`} placeholder="{{document.number}}" />
              </div>
            ))}
          </div>
          {wa.headerKind === 'document' && <p className="text-xs text-fg-muted">{t('tpl.wa.docHeader')}</p>}
        </>
      )}
    </div>
  );
}
