import { Injectable } from '@nestjs/common';
import type { Tx } from '../../core/db.service';

/**
 * Context extension hook: other modules add data to the document context under `key` (e.g. procurement adds
 * `comparison` for the comparison sheet). An extension runs only when the template being rendered mentions its key,
 * so expensive data is computed only for templates that print it. Extensions must be read-only.
 */
export interface TemplateContextExtension {
  /** Top-level context key the extension fills, e.g. 'comparison'. */
  key: string;
  /** Doc type keys it applies to (empty = all). */
  docTypeKeys: string[];
  build(tx: Tx, input: { tenantId: string; documentId: string; docTypeKey: string; context: Record<string, unknown> }): Promise<unknown>;
}

@Injectable()
export class TemplateContextExtensions {
  private readonly list = new Map<string, TemplateContextExtension>();

  register(ext: TemplateContextExtension): void {
    if (!/^[a-z][a-zA-Z0-9_]{1,40}$/.test(ext.key)) throw new Error(`invalid context extension key ${ext.key}`);
    this.list.set(ext.key, ext);
  }

  has(key: string): boolean {
    return this.list.has(key);
  }

  keys(): string[] {
    return [...this.list.keys()];
  }

  /** Runs the extensions relevant to `docTypeKey` whose key appears in any of `sources`. */
  async apply(tx: Tx, sources: (string | null | undefined)[], input: { tenantId: string; documentId: string; docTypeKey: string; context: Record<string, unknown> }) {
    const text = sources.filter(Boolean).join('\n');
    for (const ext of this.list.values()) {
      if (ext.docTypeKeys.length && !ext.docTypeKeys.includes(input.docTypeKey)) continue;
      if (!text.includes(ext.key)) continue;
      input.context[ext.key] = await ext.build(tx, input);
    }
  }
}
