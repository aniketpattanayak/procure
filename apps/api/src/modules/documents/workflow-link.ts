import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { WorkflowRuntimeView } from '@procure/schema';
import type { Tx } from '../../core/db.service';
import { WORKFLOW_PORT, WorkflowPort } from '../../core/ports';

/**
 * The documents module's view of WORKFLOW_PORT (implemented by the workflow module). Resolved lazily from the
 * container — the workflow module injects DOCUMENTS_PORT, so constructor injection both ways would be a cycle — and
 * optional: without a workflow port, submit approves every line immediately (like a type with no workflow).
 */
@Injectable()
export class WorkflowLink {
  private resolved: WorkflowPort | null | undefined;
  constructor(private readonly moduleRef: ModuleRef) {}

  get port(): WorkflowPort | null {
    if (this.resolved === undefined) {
      try {
        this.resolved = this.moduleRef.get<WorkflowPort>(WORKFLOW_PORT, { strict: false }) ?? null;
      } catch {
        this.resolved = null;
      }
    }
    return this.resolved;
  }

  /** Test seam: replace (or remove with null) the workflow port; `undefined` re-resolves from the container. */
  override(port: WorkflowPort | null | undefined) {
    this.resolved = port;
  }

  async statusKeys(tx: Tx, docTypeId: string): Promise<{ key: string; label: string }[]> {
    return (await this.port?.statusKeys(tx, docTypeId)) ?? [];
  }

  async lineStages(tx: Tx, documentId: string): Promise<Record<string, Record<string, { pending: string; held: string }>>> {
    return (await this.port?.lineStages(tx, documentId)) ?? {};
  }

  async runtimeView(tx: Tx, documentId: string, viewer: { userId: string; permissions: string[] }): Promise<WorkflowRuntimeView | null> {
    return (await this.port?.runtimeView(tx, documentId, viewer)) ?? null;
  }
}
