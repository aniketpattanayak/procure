import { Injectable } from '@nestjs/common';
import type { Tx } from '../../core/db.service';
import type { RenderAccess, RenderedMessage, RenderHiddenFields, TablePdfRequest, TemplateRenderer } from '../../core/ports';
import { DocumentContextBuilder } from './context.service';
import { PdfRenderer } from './pdf.renderer';
import { PdfJobs } from './pdf.service';
import { tableHtml, tablePdfOptions } from './table-pdf';

/** A table PDF may take longer than a document PDF (thousands of rows). */
const TABLE_PDF_TIMEOUT_MS = 60_000;
import { TemplatesService } from './templates.service';

/** TEMPLATE_RENDERER implementation (core/ports.ts) used by the notify and reports modules. */
@Injectable()
export class TemplateRendererService implements TemplateRenderer {
  constructor(
    private readonly contexts: DocumentContextBuilder,
    private readonly templates: TemplatesService,
    private readonly pdfs: PdfJobs,
    private readonly pdf: PdfRenderer,
  ) {}

  async documentContext(tx: Tx, documentId: string, opts: RenderAccess = {}): Promise<Record<string, unknown>> {
    return (await this.contexts.build(tx, documentId, [], opts)).context;
  }

  hiddenFields(tx: Tx, documentId: string, viewer: RenderAccess['viewer']): Promise<RenderHiddenFields> {
    return this.contexts.hiddenFor(tx, viewer, documentId);
  }

  /** Renders email/pdf as HTML, in-app/WhatsApp as plain text; WhatsApp variables in index order. */
  async render(tx: Tx, templateId: string, context: Record<string, unknown>): Promise<RenderedMessage & { whatsappVariables?: string[] }> {
    const tenantId = await this.contexts.tenantIdOf(tx);
    const t = await this.templates.load(tx, tenantId, templateId);
    const out = this.templates.renderWith({
      channel: t.channel, subject: t.subject, body: t.body, name: t.name,
      whatsappVariables: (t.whatsapp_variables ?? []) as { index: number; expr: string }[],
    }, context);
    const text = t.channel === 'inapp' || t.channel === 'whatsapp';
    return {
      subject: out.subject, body: text ? out.text : out.html, templateVersion: t.version,
      ...(t.channel === 'whatsapp' ? { whatsappVariables: out.whatsappVariables } : {}),
    };
  }

  pdfForDocument(tx: Tx, documentId: string, templateId: string | null, opts?: { waitMs?: number; hidden?: RenderHiddenFields | null }): Promise<{ id: string; fileId: string | null }> {
    return this.pdfs.pdfForDocument(tx, documentId, templateId, opts);
  }

  /** Report/list export as a PDF table. Network-locked: the resolver serves no files, so nothing outside the page loads. */
  async renderTablePdf(input: TablePdfRequest): Promise<Buffer> {
    const res = await this.pdf.render(tableHtml(input), tablePdfOptions(input), async () => null, TABLE_PDF_TIMEOUT_MS);
    return res.pdf;
  }
}
