/** Public surface of the templates & PDF module (Phase 6, ADR-0014). Other modules import only from here. */
export { TemplatesModule } from './templates.module';
export { TemplatesInstaller } from './installer';
export type { TemplatesInstallContext, TemplatesInstallStep } from './installer';
export { TemplateContextExtensions } from './extensions';
export type { TemplateContextExtension } from './extensions';
export { TemplatesService, toTemplateRow, htmlDocument, unescapeText } from './templates.service';
export { TemplateRendererService } from './renderer.service';
export { PdfJobs, PDF_QUEUE, pdfFilename } from './pdf.service';
export { DocumentContextBuilder, displayValue, documentUrl } from './context.service';
export { StarterTemplates, STARTER_KEYS, STARTER_TEMPLATES } from './starters/install';
export { TemplateEngine, HELPERS, MAX_TEMPLATE_BYTES, RENDER_TIMEOUT_MS } from './engine';
export { amountInWords, formatDate, formatMoney, formatNumber, qrSvg } from './format';
