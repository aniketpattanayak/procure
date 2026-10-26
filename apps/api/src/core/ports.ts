import type { Effect, MyPermissions, WorkflowRuntimeView } from '@procure/schema';
import type { Tx } from './db.service';

/**
 * Seams between the documents module and the workflow module (Phase 3, frozen). Both modules depend on these
 * interfaces in core; neither imports the other (avoids the Nest import cycles hit in Phase 2).
 *
 *   documents  --(WORKFLOW_PORT)-->  workflow      submit starts a workflow; detail pages ask for runtime view
 *   workflow   --(DOCUMENTS_PORT)--> documents     ledger events, status recompute, document snapshot for routing
 *   any module --(EFFECTS)---------> handlers      fixed effect vocabulary; modules register what they implement
 */

export const DOCUMENTS_PORT = Symbol('DOCUMENTS_PORT');
export const WORKFLOW_PORT = Symbol('WORKFLOW_PORT');
export const EFFECT_REGISTRY = Symbol('EFFECT_REGISTRY');

/** Everything routing/effects need about a document, with header + line values keyed by form field keys. */
export interface DocumentSnapshot {
  id: string;
  tenantId: string;
  docTypeId: string;
  docTypeKey: string;
  number: string | null;
  statusKey: string;
  locationNodeId: string;
  locationPath: string;        // ltree text, for scope checks
  createdBy: string | null;
  submittedBy: string | null;
  values: Record<string, unknown>;                 // header (system + custom)
  lines: { id: string; lineNo: number; qty: string; values: Record<string, unknown>; isCancelled: boolean }[];
  /** Lookup attributes for formula evaluation (header lookups + per-line lookups), as the forms engine builds them. */
  lookups: Record<string, Record<string, unknown> | null>;
  lineLookups: Record<string, Record<string, Record<string, unknown> | null>>; // lineId -> field -> attrs
  version: number;
}

export type LedgerEventType =
  | 'requested' | 'approved' | 'held' | 'unheld' | 'rejected' | 'cancelled' | 'short_closed' | 'over_approved' | 'over_approval_cancelled'
  | 'selected' | 'selection_cancelled' | 'ordered' | 'order_cancelled' | 'received' | 'accepted'
  | 'rejected_at_receipt' | 'issued' | 'returned';

export interface LedgerEvent {
  lineId: string;
  type: LedgerEventType;
  qty: string;                 // decimal string > 0
  refLineId?: string | null;
  wfActionId?: string | null;
  stageKey?: string | null;
  reason?: string | null;
}

export interface DocumentsPort {
  /** Loads the document FOR UPDATE (header row) plus lines; throws NOT_FOUND when absent. */
  snapshot(tx: Tx, documentId: string, opts?: { lock?: boolean }): Promise<DocumentSnapshot>;
  /**
   * Appends ledger events and updates line_qty_summary in the same tx. Locks the affected summary rows in line-id
   * order. Throws AppError 409 QTY_INVARIANT with meta {lineId, bucket} when a bucket would go negative or
   * approved + rejected + cancelled would exceed requested + over_approved.
   */
  recordQuantities(tx: Tx, documentId: string, events: LedgerEvent[], actorId: string | null): Promise<void>;
  /** Recomputes and stores line + document status keys (from ledger + workflow line state + explicit states). */
  recomputeStatus(tx: Tx, documentId: string): Promise<{ statusKey: string; changed: boolean }>;
  setLocked(tx: Tx, documentId: string, locked: boolean): Promise<void>;
  /** Marks the document closed (effect close_document / workflow completion with nothing left). */
  close(tx: Tx, documentId: string, reason: string, actorId: string | null): Promise<void>;
  /** Returns a submitted document to draft (send back to creator). The assigned number is kept. */
  returnToDraft(tx: Tx, documentId: string, actorId: string | null, reason: string): Promise<void>;
  /**
   * Applies approver edits to editable line fields (validated against the line form) during a decision. With `actor`
   * the approver's field access applies too (hidden/read-only fields → 403 FIELD_READ_ONLY) and the audit names them.
   */
  applyLineEdits(
    tx: Tx, documentId: string, edits: { lineId: string; values: Record<string, unknown> }[], allowedFields: string[],
    actor?: { userId: string | null; perms: MyPermissions | undefined },
  ): Promise<void>;
  /** Writes a domain event to the outbox in the same transaction. */
  emit(tx: Tx, eventType: string, aggregate: { kind: string; id: string | null }, payload: Record<string, unknown>): Promise<void>;
}

export interface WorkflowPort {
  /**
   * Called inside the submit transaction after numbering and `requested` ledger events. Starts an instance on the
   * current published version; with no workflow or zero runnable stages every line is approved immediately.
   */
  start(tx: Tx, documentId: string, actorId: string): Promise<void>;
  /** Cancels the running instance (document cancelled / returned to draft). */
  cancel(tx: Tx, documentId: string, reason: string, actorId: string | null): Promise<void>;
  /** Called when lines are cancelled after submit: removes their remaining qty from all stages. */
  linesCancelled(tx: Tx, documentId: string, lineIds: string[]): Promise<void>;
  /** Runtime view for the detail page (null when the document never entered a workflow). */
  runtimeView(tx: Tx, documentId: string, viewer: { userId: string; permissions: string[] }): Promise<WorkflowRuntimeView | null>;
  /** Per line: stage -> {pending, held} for qty still inside the workflow. */
  lineStages(tx: Tx, documentId: string): Promise<Record<string, Record<string, { pending: string; held: string }>>>;
  /** Status keys a doc type can be in (for registry views + list chips): waiting_<stage> per stage of the current version. */
  statusKeys(tx: Tx, docTypeId: string): Promise<{ key: string; label: string }[]>;
}

/** Effect handler contract. Handlers run inside the action's transaction; external side effects (email, PDF)
 *  must go through the outbox/queue, never directly. Handlers must be idempotent per (wfActionId, effect index). */
export interface EffectContext {
  tx: Tx;
  tenantId: string;
  documentId: string;
  stageKey: string | null;
  wfActionId: string | null;
  actorId: string | null;
  /** For onApprove: qty approved per line in this action. */
  approved?: { lineId: string; qty: string }[];
  rejected?: { lineId: string; qty: string }[];
}
export type EffectHandler = (effect: Effect, ctx: EffectContext) => Promise<void>;

export interface EffectRegistry {
  register(effect: Effect['effect'], handler: EffectHandler, opts?: { requiresFeature?: string }): void;
  /** Effects usable by a tenant right now (handler registered + feature in plan). */
  available(tenantFeatures: string[]): Effect['effect'][];
  run(effect: Effect, ctx: EffectContext): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Phase 6 seam: template rendering (implemented by the templates/PDF module, used by the trigger engine and
// report schedules). Context shape is documented in packages/schema/src/notify.ts.
// ---------------------------------------------------------------------------------------------
export const TEMPLATE_RENDERER = Symbol('TEMPLATE_RENDERER');

export interface RenderedMessage { subject: string | null; body: string; templateVersion: number }

export interface TemplateRenderer {
  /** Builds the standard Handlebars context for a document (tenant, document, lines, totals, terms, approvals). */
  documentContext(tx: Tx, documentId: string, opts?: RenderAccess): Promise<Record<string, unknown>>;
  /** Renders a template (email/inapp/pdf body; WhatsApp variables) with the given context. Never performs I/O. */
  render(tx: Tx, templateId: string, context: Record<string, unknown>): Promise<RenderedMessage & { whatsappVariables?: string[] }>;
  /** Queues (or reuses) a PDF for the document+template at its current version; returns the generated_pdf id.
   *  `waitMs` > 0 waits for the file (used when attaching to an email). */
  pdfForDocument(tx: Tx, documentId: string, templateId: string | null, opts?: { waitMs?: number; hidden?: RenderHiddenFields | null }): Promise<{ id: string; fileId: string | null }>;
  /** Field keys `viewer` cannot read on the document (none for the system). Optional for test doubles. */
  hiddenFields?(tx: Tx, documentId: string, viewer: RenderAccess['viewer']): Promise<RenderHiddenFields>;
  /**
   * Simple tabular PDF (report / list exports) through the same locked-down Chromium renderer as document PDFs: no
   * JavaScript, every network request aborted. Optional for test doubles; reports offer PDF only when present.
   */
  renderTablePdf?(input: TablePdfRequest): Promise<Buffer>;
}

export interface TablePdfRequest {
  title: string;
  subtitle?: string | null;
  header: string[];
  rows: (string | number | boolean | null | Date)[][];
  note?: string | null;
  landscape?: boolean;
}

/** QA47-BUG-006: field access of a render (a user's preview / manual send); omitted = system view (every field). */
export interface RenderHiddenFields { header: string[]; line: string[] }
export interface RenderAccess { viewer?: { tenantId: string; userId: string | null; perms: MyPermissions | null } | null; hidden?: RenderHiddenFields | null }
