import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { DocumentRow, MyPermissions } from '@procure/schema';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';

/**
 * Provider the documents module registers (token 'DOCUMENT_ROW_READER') to build the canonical DocumentRow returned
 * by POST /docs/:type/:id/actions (the contract's response type). Resolved lazily — no provider cycle.
 */
export interface DocumentRowReader {
  documentRow(tx: Tx, documentId: string, viewer: { userId: string; perms: MyPermissions | undefined }): Promise<DocumentRow>;
}
export const DOCUMENT_ROW_READER = 'DOCUMENT_ROW_READER';

@Injectable()
export class DocumentRowBuilder {
  private reader: DocumentRowReader | null = null;
  constructor(private readonly moduleRef: ModuleRef) {}

  build(tx: Tx, documentId: string, viewer: { userId: string; perms: MyPermissions | undefined }): Promise<DocumentRow> {
    if (!this.reader) {
      try {
        this.reader = this.moduleRef.get<DocumentRowReader>(DOCUMENT_ROW_READER, { strict: false });
      } catch {
        throw new AppError(503, 'DOCUMENTS_UNAVAILABLE', 'Documents are not available right now.');
      }
    }
    return this.reader.documentRow(tx, documentId, viewer);
  }
}
