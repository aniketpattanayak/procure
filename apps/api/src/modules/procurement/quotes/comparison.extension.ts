import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { TemplateContextExtensions } from '../../templates';
import { INDENT } from '../installer/a-steps';
import { ComparisonService } from './comparison.service';

/**
 * Registers the `comparison` template context extension (contract phase 6 "Context extensions"): indent templates
 * that mention `comparison` get one ComparisonSheet per item. Registration makes the templates starter installer add
 * the "Comparison sheet" PDF layout (key `comparison_sheet`, non-default) — idempotently (ON CONFLICT DO NOTHING),
 * for new tenants at creation and for existing tenants on their next templates install pass.
 */
@Injectable()
export class ComparisonContextExtension implements OnModuleInit {
  constructor(
    private readonly comparison: ComparisonService,
    @Optional() @Inject(TemplateContextExtensions) private readonly extensions?: TemplateContextExtensions,
  ) {}

  onModuleInit() {
    this.extensions?.register({
      key: 'comparison', docTypeKeys: [INDENT],
      build: (tx, input) => this.comparison.forDocument(tx, input.tenantId, input.documentId),
    });
  }
}
