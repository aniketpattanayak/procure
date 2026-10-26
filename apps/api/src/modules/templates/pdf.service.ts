import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Effect, PdfJobRow } from '@procure/schema';
import type { Job } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { EFFECT_REGISTRY, EffectContext, EffectRegistry } from '../../core/ports';
import { QueueService } from '../../core/queue.service';
import { FilesService } from '../files';
import type { DocActor } from '../documents';
import { accessKeyOf, DocumentContextBuilder, HiddenFields, NO_HIDDEN } from './context.service';
import { PdfRenderer } from './pdf.renderer';
import { pdfOptionsOf, TemplateDbRow, TemplatesService } from './templates.service';

export const PDF_QUEUE = 'pdf';
const JOB_ATTEMPTS = 3;

export interface GeneratedPdfRow {
  id: string; document_id: string; template_id: string; template_version: number; document_version: number; access_key: string;
  hidden_fields: HiddenFields | null; file_id: string | null;
  status: 'queued' | 'rendering' | 'ready' | 'failed'; error: string | null; created_at: Date; created_by: string | null;
}
const GP_COLS = ['id', 'document_id', 'template_id', 'template_version', 'document_version', 'access_key', 'hidden_fields', 'file_id', 'status', 'error', 'created_at', 'created_by'] as const;

/**
 * PDF jobs: `app.generated_pdf` is the cache keyed by (document, template, template version, document version, access
 * variant). The access variant (QA47-BUG-006) is the requester's hidden fields ('' = full access: workflow effects,
 * automatic sends); the worker removes those fields from the render context.
 * A request reuses a queued/rendering/ready row for the same versions; a failed row is re-queued. Rendering runs in
 * queue `pdf` (worker process, or inline in dev/test) and stores the file through the files module storage driver.
 *
 * Storage decision: generated PDFs are a regenerable cache, so they are NOT counted against the tenant's
 * `storage_gb` limit (a full quota must never block printing a PO). Their file_object rows are marked clean and
 * attached to the generated_pdf row (kind `generated_pdf`) so orphan cleanup never deletes them.
 */
@Injectable()
export class PdfJobs implements OnModuleInit {
  private readonly log = new Logger('PdfJobs');

  constructor(
    private readonly db: DbService,
    private readonly queue: QueueService,
    private readonly files: FilesService,
    private readonly templates: TemplatesService,
    private readonly contexts: DocumentContextBuilder,
    private readonly renderer: PdfRenderer,
    @Inject(EFFECT_REGISTRY) private readonly effects: EffectRegistry,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor(PDF_QUEUE, job => this.process(job), 3);
    this.effects.register('generate_pdf', (e, c) => this.effect(e as Extract<Effect, { effect: 'generate_pdf' }>, c));
  }

  // ------------------------------------------------------------------ requests
  /** Template to print with: explicit id (active pdf template), else the doc type's default, else the generic default. */
  async resolveTemplate(tx: Tx, tenantId: string, docTypeKey: string, templateId: string | null | undefined): Promise<TemplateDbRow> {
    if (templateId) {
      const t = await this.templates.load(tx, tenantId, templateId);
      if (t.channel !== 'pdf') throw new AppError(400, 'VALIDATION_FAILED', 'This template is not a PDF layout.', undefined, [{ path: 'templateId', message: 'Pick a PDF template.' }]);
      if (t.doc_type_key && t.doc_type_key !== docTypeKey) throw new AppError(400, 'VALIDATION_FAILED', 'This layout is for another document type.', undefined, [{ path: 'templateId', message: 'Pick a layout of this document type.' }]);
      return t;
    }
    const t = await this.templates.defaultFor(tx, tenantId, 'pdf', docTypeKey);
    if (!t) throw AppError.conflict('No PDF layout is set up for this document type.');
    return t;
  }

  /**
   * Finds or creates the generated_pdf row for the document at its current version. Returns `enqueue` when a job is
   * needed (new row or a failed one being retried).
   */
  async request(tx: Tx, tenantId: string, documentId: string, template: TemplateDbRow, userId: string | null, hidden: HiddenFields = NO_HIDDEN): Promise<{ row: GeneratedPdfRow; enqueue: boolean; fresh: boolean }> {
    const doc = await tx.selectFrom('app.document').select(['id', 'version']).where('tenant_id', '=', tenantId).where('id', '=', documentId)
      .where('is_deleted', '=', false).executeTakeFirst();
    if (!doc) throw AppError.notFound('Document');
    const accessKey = accessKeyOf(hidden);
    const key = { document_id: doc.id, template_id: template.id, template_version: template.version, document_version: doc.version, access_key: accessKey };
    const inserted = await tx.insertInto('app.generated_pdf').values({ ...key, hidden_fields: accessKey ? JSON.stringify(hidden) : null, created_by: userId })
      .onConflict(oc => oc.doNothing()).returning([...GP_COLS]).executeTakeFirst();
    if (inserted) return { row: inserted as GeneratedPdfRow, enqueue: true, fresh: true };
    const existing = (await tx.selectFrom('app.generated_pdf').select([...GP_COLS]).where('tenant_id', '=', tenantId).where('document_id', '=', key.document_id)
      .where('template_id', '=', key.template_id).where('template_version', '=', key.template_version).where('document_version', '=', key.document_version)
      .where('access_key', '=', accessKey).forUpdate().executeTakeFirstOrThrow()) as GeneratedPdfRow;
    if (existing.status === 'failed') {
      const row = (await tx.updateTable('app.generated_pdf').set({ status: 'queued', error: null }).where('id', '=', existing.id)
        .returning([...GP_COLS]).executeTakeFirstOrThrow()) as GeneratedPdfRow;
      return { row, enqueue: true, fresh: false };
    }
    return { row: existing, enqueue: false, fresh: false };
  }

  async enqueue(tenantId: string, id: string, retry = false) {
    await this.queue.enqueue(PDF_QUEUE, 'render', { tenantId, id }, {
      jobId: retry ? `pdf:${id}:${randomUUID().slice(0, 8)}` : `pdf:${id}`, attempts: JOB_ATTEMPTS, backoff: { type: 'exponential', delay: 1000 },
    });
  }

  /** POST /docs/:type/:id/print core (caller checked permissions and document access). Commits, then queues. */
  async print(tenantId: string, userId: string | null, documentId: string, docTypeKey: string, templateId?: string | null, viewer?: DocActor | null): Promise<PdfJobRow> {
    const { row, enqueue, fresh } = await this.db.tenantTx(tenantId, async tx => {
      const t = await this.resolveTemplate(tx, tenantId, docTypeKey, templateId);
      return this.request(tx, tenantId, documentId, t, userId, await this.contexts.hiddenFor(tx, viewer, documentId));
    });
    if (enqueue) await this.enqueue(tenantId, row.id, !fresh);
    return this.toJobRow(tenantId, row);
  }

  async load(tx: Tx, tenantId: string, id: string): Promise<GeneratedPdfRow | undefined> {
    return (await tx.selectFrom('app.generated_pdf').select([...GP_COLS]).where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst()) as GeneratedPdfRow | undefined;
  }

  /** True when the PDF hides at least what `viewer` cannot read (the caller sees nothing beyond their access). */
  async coversViewer(tx: Tx, viewer: DocActor, r: GeneratedPdfRow): Promise<boolean> {
    const mine = await this.contexts.hiddenFor(tx, viewer, r.document_id);
    const has = { header: new Set(r.hidden_fields?.header ?? []), line: new Set(r.hidden_fields?.line ?? []) };
    return mine.header.every(k => has.header.has(k)) && mine.line.every(k => has.line.has(k));
  }

  toJobRow(tenantId: string, r: Pick<GeneratedPdfRow, 'id' | 'status' | 'file_id' | 'error'>): PdfJobRow {
    return { id: r.id, status: r.status, fileUrl: r.status === 'ready' && r.file_id ? this.files.signedUrl(tenantId, r.file_id) : null, error: r.error };
  }

  /** Self-healing poll: a row still queued after 30 s without a live job is queued again (lost enqueue). */
  async heal(tenantId: string, r: GeneratedPdfRow) {
    if (r.status !== 'queued' || Date.now() - new Date(r.created_at).getTime() < 30_000) return;
    const job = await this.queue.queue(PDF_QUEUE).getJob(`pdf:${r.id}`);
    const state = job ? await job.getState() : 'unknown';
    if (!job || state === 'completed' || state === 'failed' || state === 'unknown') await this.enqueue(tenantId, r.id, true);
  }

  // ------------------------------------------------------------------ TemplateRenderer.pdfForDocument + effect
  async pdfForDocument(tx: Tx, documentId: string, templateId: string | null, opts: { waitMs?: number; hidden?: HiddenFields | null } = {}): Promise<{ id: string; fileId: string | null }> {
    const tenantId = await this.contexts.tenantIdOf(tx);
    const docType = await tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select('t.key')
      .where('d.tenant_id', '=', tenantId).where('d.id', '=', documentId).executeTakeFirst();
    if (!docType) throw AppError.notFound('Document');
    const waitMs = opts.waitMs ?? 0;
    if (waitMs <= 0) {
      const t = await this.resolveTemplate(tx, tenantId, docType.key, templateId);
      const { row, enqueue, fresh } = await this.request(tx, tenantId, documentId, t, null, opts.hidden ?? NO_HIDDEN);
      if (enqueue) await this.enqueue(tenantId, row.id, !fresh);
      return { id: row.id, fileId: row.status === 'ready' ? row.file_id : null };
    }
    // Waiting: the row must be committed so the worker can see it (the document itself is already committed).
    const { row, enqueue, fresh } = await this.db.tenantTx(tenantId, async t2 => {
      const t = await this.resolveTemplate(t2, tenantId, docType.key, templateId);
      return this.request(t2, tenantId, documentId, t, null, opts.hidden ?? NO_HIDDEN);
    });
    if (enqueue) await this.enqueue(tenantId, row.id, !fresh);
    const until = Date.now() + waitMs;
    let cur: GeneratedPdfRow | undefined = row;
    while (cur && cur.status !== 'ready' && cur.status !== 'failed' && Date.now() < until) {
      await new Promise(r => setTimeout(r, 200));
      cur = await this.db.tenantTx(tenantId, t3 => this.load(t3, tenantId, row.id));
    }
    return { id: row.id, fileId: cur?.status === 'ready' ? cur.file_id : null };
  }

  /** Workflow effect `generate_pdf` (optional `template` = key of a pdf template). Idempotent via the cache key. */
  private async effect(e: Extract<Effect, { effect: 'generate_pdf' }>, c: EffectContext) {
    const doc = await c.tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select('t.key')
      .where('d.tenant_id', '=', c.tenantId).where('d.id', '=', c.documentId).executeTakeFirst();
    if (!doc) return;
    let template: TemplateDbRow | undefined;
    if (e.template) {
      template = await this.templates.byKey(c.tx, c.tenantId, 'pdf', e.template);
      if (!template || !template.is_active) {
        this.log.warn(`generate_pdf: template "${e.template}" not found for tenant ${c.tenantId}; using the default`);
        template = undefined;
      }
    }
    template ??= await this.templates.defaultFor(c.tx, c.tenantId, 'pdf', doc.key);
    if (!template) return;
    const { row, enqueue, fresh } = await this.request(c.tx, c.tenantId, c.documentId, template, c.actorId);
    // Queued before commit: the job retries until the row is visible; a rolled-back action leaves nothing behind.
    if (enqueue) await this.enqueue(c.tenantId, row.id, !fresh);
  }

  // ------------------------------------------------------------------ worker
  async process(job: Pick<Job, 'data' | 'attemptsMade' | 'opts'>): Promise<{ status: string }> {
    const { tenantId, id } = job.data as { tenantId: string; id: string };
    const attempts = job.opts?.attempts ?? JOB_ATTEMPTS;
    const last = job.attemptsMade + 1 >= attempts;
    const prep = await this.db.tenantTx(tenantId, async tx => {
      const row = await this.load(tx, tenantId, id);
      if (!row) return { kind: 'missing' as const };
      if (row.status === 'ready') return { kind: 'done' as const };
      await tx.updateTable('app.generated_pdf').set({ status: 'rendering' }).where('id', '=', id).execute();
      try {
        const t = await this.templates.load(tx, tenantId, row.template_id);
        const opts = pdfOptionsOf(t);
        const built = await this.contexts.build(tx, row.document_id, [t.body, opts.headerHtml, opts.footerHtml], { hidden: row.hidden_fields });
        const out = this.templates.renderWith({ channel: 'pdf', body: t.body, subject: null, pdfOptions: opts, name: t.name }, built.context);
        const type = (built.context.document as { docTypeName?: string }).docTypeName ?? 'Document';
        return { kind: 'render' as const, out, opts, filename: pdfFilename(built.number ?? type) };
      } catch (e) {
        if (e instanceof AppError) return { kind: 'bad' as const, error: e.message };
        throw e;
      }
    });
    if (prep.kind === 'missing') {
      // Requested inside a transaction that has not committed yet (effect) — retry; gone for good after that.
      if (!last) throw new Error(`generated_pdf ${id} not visible yet`);
      return { status: 'missing' };
    }
    if (prep.kind === 'done') return { status: 'ready' };
    if (prep.kind === 'bad') {
      await this.fail(tenantId, id, prep.error);
      return { status: 'failed' };
    }
    try {
      const res = await this.renderer.render(prep.out.html, { ...prep.opts, headerHtml: prep.out.headerHtml, footerHtml: prep.out.footerHtml },
        q => (q.t === tenantId ? this.files.content(q).then(f => ({ body: f.body, mime: f.mime })) : Promise.resolve(null)));
      if (res.blocked.length) this.log.debug?.(`pdf ${id}: blocked ${res.blocked.length} request(s)`);
      await this.store(tenantId, id, res.pdf, prep.filename);
      return { status: 'ready' };
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 500) ?? 'PDF rendering failed';
      this.log.warn(`pdf ${id} attempt ${job.attemptsMade + 1}: ${msg}`);
      if (last) {
        await this.fail(tenantId, id, `The PDF could not be generated: ${msg}`);
        return { status: 'failed' };
      }
      throw e;
    }
  }

  private async fail(tenantId: string, id: string, error: string) {
    await this.db.tenantTx(tenantId, tx => tx.updateTable('app.generated_pdf').set({ status: 'failed', error: error.slice(0, 1000) })
      .where('tenant_id', '=', tenantId).where('id', '=', id).execute());
  }

  private async store(tenantId: string, id: string, pdf: Buffer, filename: string) {
    const now = new Date();
    const key = `${tenantId}/pdf/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.pdf`;
    await this.files.storage.put(key, pdf, 'application/pdf');
    try {
      await this.db.tenantTx(tenantId, async tx => {
        const f = await tx.insertInto('app.file_object').values({
          storage_key: key, filename, mime: 'application/pdf', size_bytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'),
          scan_status: 'clean', attached_to: JSON.stringify({ kind: 'generated_pdf', id, field: 'pdf' }),
        }).returning('id').executeTakeFirstOrThrow();
        await tx.updateTable('app.generated_pdf').set({ status: 'ready', file_id: f.id, error: null }).where('tenant_id', '=', tenantId).where('id', '=', id).execute();
      });
    } catch (e) {
      await this.files.storage.delete(key).catch(() => undefined);
      throw e;
    }
  }

  /** Waits for a generated_pdf row to settle (tests and synchronous callers). */
  async waitFor(tenantId: string, id: string, timeoutMs = 30_000): Promise<GeneratedPdfRow | undefined> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.db.tenantTx(tenantId, tx => this.load(tx, tenantId, id));
      if (!r || r.status === 'ready' || r.status === 'failed' || Date.now() > until) return r;
      await new Promise(res => setTimeout(res, 100));
    }
  }
}

export function pdfFilename(base: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'document';
  return `${clean}.pdf`;
}
