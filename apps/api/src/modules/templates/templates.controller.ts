import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { MyPermissions, PdfJobRow, PrintInput, TemplateInput, TemplateRow, Uuid } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../core/auth/permissions';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { Zod } from '../../core/zod';
import { docAction, DocActor, DocumentsService } from '../documents';
import { UuidParam } from '../identity';
import { PdfJobs } from './pdf.service';
import { TemplateListQuery, TemplatesService, TemplateUpdate } from './templates.service';

const NO_PERMS: MyPermissions = { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };
const actorOf = (perms: MyPermissions | undefined): DocActor => {
  const p = tenantPrincipal();
  return { tenantId: p.tenantId, userId: p.userId, perms: perms ?? NO_PERMS };
};
const TYPE_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const typeKeyOf = (k: string) => {
  if (!TYPE_KEY.test(k)) throw AppError.notFound('Document type');
  return k;
};

const PreviewInput = z.object({ template: TemplateInput, documentId: Uuid.optional() });
const TestPdfInput = z.object({ documentId: Uuid.optional() });
const FieldsQuery = z.object({ docType: z.string().regex(TYPE_KEY).optional() });

@TenantOnly()
@Controller()
export class TemplatesController {
  constructor(
    private readonly db: DbService,
    private readonly templates: TemplatesService,
    private readonly docs: DocumentsService,
    private readonly pdfs: PdfJobs,
  ) {}

  // ------------------------------------------------------------------ config/templates
  @Get('config/templates')
  @Requires('config.templates:action.view')
  list(@Query(new Zod(TemplateListQuery)) q: z.infer<typeof TemplateListQuery>): Promise<TemplateRow[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.templates.list(tx, p.tenantId, q));
  }

  @Get('config/templates/context-fields')
  @Requires('config.templates:action.view')
  contextFields(@Query(new Zod(FieldsQuery)) q: z.infer<typeof FieldsQuery>) {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.templates.contextFields(tx, p.tenantId, q.docType ?? null));
  }

  @Post('config/templates/preview')
  @HttpCode(200)
  @Requires('config.templates:action.view')
  preview(@Body(new Zod(PreviewInput)) body: z.infer<typeof PreviewInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, async tx => {
      if (body.documentId) await this.visibleDocument(tx, a, body.documentId, body.template.docTypeKey);
      return this.templates.preview(tx, body.template, body.documentId ?? null, a);
    });
  }

  @Post('config/templates')
  @Requires('config.templates:action.edit')
  create(@Body(new Zod(TemplateInput)) body: z.infer<typeof TemplateInput>): Promise<TemplateRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.templates.create(tx, p.tenantId, p.userId, body));
  }

  @Put('config/templates/:id')
  @Requires('config.templates:action.edit')
  update(@Param('id', new UuidParam('Template')) id: string, @Body(new Zod(TemplateUpdate)) body: z.infer<typeof TemplateUpdate>): Promise<TemplateRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.templates.update(tx, p.tenantId, p.userId, id, body));
  }

  @Delete('config/templates/:id')
  @Requires('config.templates:action.edit')
  remove(@Param('id', new UuidParam('Template')) id: string): Promise<TemplateRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.templates.remove(tx, p.tenantId, p.userId, id));
  }

  @Post('config/templates/:id/test-pdf')
  @HttpCode(200)
  @Requires('config.templates:action.view')
  async testPdf(@Param('id', new UuidParam('Template')) id: string, @Body(new Zod(TestPdfInput)) body: z.infer<typeof TestPdfInput>, @CurrentPermissions() perms?: MyPermissions): Promise<PdfJobRow> {
    const a = actorOf(perms);
    const target = await this.db.tenantTx(a.tenantId, async tx => {
      const t = await this.templates.load(tx, a.tenantId, id);
      if (t.channel !== 'pdf') throw new AppError(400, 'VALIDATION_FAILED', 'Only PDF layouts can be test-printed.');
      if (body.documentId) return { doc: await this.visibleDocument(tx, a, body.documentId, t.doc_type_key), t };
      const doc = await this.latestVisible(tx, a, t.doc_type_key);
      if (!doc) throw AppError.conflict('There is no document you can see to test this layout with. Create one first.');
      return { doc, t };
    });
    return this.pdfs.print(a.tenantId, a.userId, target.doc.id, target.doc.typeKey, target.t.id, a);
  }

  // ------------------------------------------------------------------ printing
  @Post('docs/:type/:id/print')
  @HttpCode(200)
  async print(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(PrintInput)) body: z.infer<typeof PrintInput>,
    @CurrentPermissions() perms?: MyPermissions): Promise<PdfJobRow> {
    const a = actorOf(perms);
    const key = typeKeyOf(type);
    await this.db.tenantTx(a.tenantId, async tx => {
      const t = await this.docs.typeFor(tx, a, key);
      if (!a.perms!.keys.includes(docAction(key, 'print'))) throw AppError.forbidden();
      await this.docs.access(tx, a, t, id);
    });
    return this.pdfs.print(a.tenantId, a.userId, id, key, body.templateId ?? null, a);
  }

  @Get('pdf-jobs/:id')
  async job(@Param('id', new UuidParam('PDF job')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<PdfJobRow> {
    const a = actorOf(perms);
    const row = await this.db.tenantTx(a.tenantId, async tx => {
      const r = await this.pdfs.load(tx, a.tenantId, id);
      if (!r) throw AppError.notFound('PDF job');
      if (r.created_by !== a.userId) {
        // Not the requester: allowed when the caller may print and see that document.
        const d = await tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select('t.key')
          .where('d.tenant_id', '=', a.tenantId).where('d.id', '=', r.document_id).executeTakeFirst();
        if (!d || !a.perms!.keys.includes(docAction(d.key, 'print'))) throw AppError.notFound('PDF job');
        try {
          await this.docs.access(tx, a, await this.docs.typeFor(tx, a, d.key), r.document_id);
        } catch {
          throw AppError.notFound('PDF job');
        }
      }
      // QA47-BUG-006: a PDF rendered with more field access than the caller has is not theirs to fetch.
      if (!(await this.pdfs.coversViewer(tx, a, r))) throw AppError.notFound('PDF job');
      return r;
    });
    await this.pdfs.heal(a.tenantId, row);
    return this.pdfs.toJobRow(a.tenantId, row);
  }

  // ------------------------------------------------------------------ helpers
  /** The document if the caller can see it (type view key, scope, status view) and it matches the template's type. */
  private async visibleDocument(tx: Tx, a: DocActor, documentId: string, docTypeKey: string | null): Promise<{ id: string; typeKey: string }> {
    const d = await tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select(['d.id', 't.key'])
      .where('d.tenant_id', '=', a.tenantId).where('d.id', '=', documentId).where('d.is_deleted', '=', false).executeTakeFirst();
    if (!d) throw AppError.notFound('Document');
    if (docTypeKey && d.key !== docTypeKey) throw new AppError(400, 'VALIDATION_FAILED', 'This document is of another type than the template.', undefined, [{ path: 'documentId', message: 'Pick a document of the template\'s type.' }]);
    await this.docs.access(tx, a, await this.docs.typeFor(tx, a, d.key), d.id);
    return { id: d.id, typeKey: d.key };
  }

  private async latestVisible(tx: Tx, a: DocActor, docTypeKey: string | null): Promise<{ id: string; typeKey: string } | null> {
    let q = tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select(['d.id', 't.key'])
      .where('d.tenant_id', '=', a.tenantId).where('d.is_deleted', '=', false);
    if (docTypeKey) q = q.where('t.key', '=', docTypeKey);
    for (const d of await q.orderBy('d.created_at', 'desc').limit(25).execute()) {
      try {
        await this.docs.access(tx, a, await this.docs.typeFor(tx, a, d.key), d.id);
        return { id: d.id, typeKey: d.key };
      } catch { /* not visible: try the next one */ }
    }
    return null;
  }
}
