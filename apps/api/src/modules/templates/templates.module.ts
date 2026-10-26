import { Global, Module } from '@nestjs/common';
import { TEMPLATE_RENDERER } from '../../core/ports';
import { FilesModule } from '../files';
import { FormsModule } from '../forms';
import { DocumentContextBuilder } from './context.service';
import { TemplateContextExtensions } from './extensions';
import { TemplatesInstaller } from './installer';
import { PdfRenderer } from './pdf.renderer';
import { PdfJobs } from './pdf.service';
import { TemplateRendererService } from './renderer.service';
import { StarterTemplates } from './starters/install';
import { TenantProfile } from './system/tenant-profile';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Templates & PDF (Phase 6, ADR-0014): template CRUD, Handlebars rendering with a fixed helper set, the document
 * context builder, PDF rendering in the worker (headless Chromium), print endpoints, starter templates and the
 * `generate_pdf` workflow effect. Provides TEMPLATE_RENDERER (global) for the notify and reports modules.
 * DocumentsModule is global (DocumentsService, DocStore).
 */
@Global()
@Module({
  imports: [FilesModule, FormsModule],
  controllers: [TemplatesController],
  providers: [
    TemplatesInstaller, TemplateContextExtensions, TenantProfile, DocumentContextBuilder, StarterTemplates, TemplatesService, PdfRenderer, PdfJobs,
    TemplateRendererService,
    { provide: TEMPLATE_RENDERER, useExisting: TemplateRendererService },
  ],
  exports: [TemplatesInstaller, TemplateContextExtensions, TemplatesService, PdfJobs, StarterTemplates, TEMPLATE_RENDERER, TemplateRendererService],
})
export class TemplatesModule {}
