import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AppError } from '../../core/errors';
import { DOCUMENTS_PORT, DocumentsPort } from '../../core/ports';

/**
 * Lazy handle on the documents module's DocumentsPort. Resolved at call time (not constructor injection) so the
 * two modules never form a provider cycle (documents injects WORKFLOW_PORT, workflow uses DOCUMENTS_PORT).
 */
@Injectable()
export class DocsPortRef {
  private override: DocumentsPort | null = null;
  private cached: DocumentsPort | null = null;
  constructor(private readonly moduleRef: ModuleRef) {}

  get(): DocumentsPort {
    if (this.override) return this.override;
    if (!this.cached) {
      try {
        this.cached = this.moduleRef.get<DocumentsPort>(DOCUMENTS_PORT, { strict: false });
      } catch {
        throw new AppError(503, 'DOCUMENTS_UNAVAILABLE', 'Documents are not available right now.');
      }
    }
    return this.cached;
  }

  available(): boolean {
    try { this.get(); return true; } catch { return false; }
  }

  /** Test seam: replaces the port (null restores the real one). */
  use(port: DocumentsPort | null) {
    this.override = port;
  }
}
