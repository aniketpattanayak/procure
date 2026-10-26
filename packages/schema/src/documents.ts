import { z } from 'zod';
import { Uuid } from './common';
import { FormDefinition } from './forms';

/**
 * DOCUMENTS CORE CONTRACT (Phase 3, frozen). ADR-0010.
 * Every transaction (custom types now; indent/PO/GRN/issue … in Phases 4–5) is a document of a document type:
 * header form + optional line form + settings. The workflow engine, numbering, permissions, timeline and list
 * views work on any type through this one shape.
 */

/**
 * System field keys. When a header/line form declares a field with one of these keys (with `system: true`), its
 * value is stored in the real column instead of `custom`. Engines read only these.
 */
export const HEADER_SYSTEM_FIELDS = {
  location: { column: 'location_node_id', type: 'lookup', required: true },  // lookup source kind 'location'
  doc_date: { column: 'doc_date', type: 'date', required: true },
  required_by: { column: 'required_by', type: 'date', required: false },
  party: { column: 'party_id', type: 'lookup', required: false },              // lookup to a master (vendor …)
  total_amount: { column: 'total_amount', type: 'currency|formula', required: false },
} as const;
export const LINE_SYSTEM_FIELDS = {
  item: { column: 'item_id', type: 'lookup', required: false },               // lookup → item master
  uom: { column: 'uom_id', type: 'lookup', required: false },
  qty: { column: 'qty', type: 'decimal', required: true },
  rate: { column: 'rate', type: 'currency', required: false },
  amount: { column: 'amount', type: 'currency|formula', required: false },
  required_date: { column: 'required_date', type: 'date', required: false },
  location: { column: 'location_node_id', type: 'lookup', required: false },  // defaults to the header location
} as const;

/** For formula evaluation the engine wraps the line form as a virtual grid named `lines` inside the header form.
 *  Line formulas resolve bare names to the line first, then the header (exactly like grid rows in
 *  formula-language.md). Header formulas aggregate lines with `lines.<field>`, e.g. total_amount = SUM(lines.amount). */
export const LINES_KEY = 'lines';

export const DocTypeSettings = z.object({
  /** Label of the numbered document, e.g. 'Capex No.' */
  numberLabel: z.string().max(40).default('No.'),
  /** Status keys after which header/lines are locked unless a workflow stage unlocks (default: locked once submitted). */
  editableStatuses: z.array(z.string()).default(['draft']),
  /** Show the item-wise list view (needs a line form). */
  itemWiseView: z.boolean().default(true),
  /** Columns shown by default in the document-wise / item-wise lists (system keys or custom field keys). */
  documentColumns: z.array(z.string()).max(20).default(['number', 'doc_date', 'location', 'status', 'total_amount']),
  itemColumns: z.array(z.string()).max(20).default(['number', 'line_no', 'item', 'qty', 'status', 'pending_approval']),
  /** Allow cancelling individual lines after submit (with reason). */
  allowLineCancel: z.boolean().default(true),
  /** Show this type in the sidebar under Modules. */
  showInMenu: z.boolean().default(true),
  icon: z.string().max(40).default('file-text'),
});
export type DocTypeSettings = z.infer<typeof DocTypeSettings>;

/** POST /config/doc-types — creates the type, its header + line forms (with system fields), permission keys,
 *  a default numbering series and an empty workflow (no stages = auto-approve on submit). */
export const DocTypeCreate = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().trim().min(2).max(60),
  pluralName: z.string().trim().min(2).max(60),
  description: z.string().max(500).optional(),
  hasLines: z.boolean().default(true),
  /** Line quantities are against an item master (adds `item` + `uom` system fields). */
  itemLines: z.boolean().default(true),
  settings: DocTypeSettings.default({}),
  /** Optional initial custom fields (system fields are added automatically). */
  headerDefinition: FormDefinition.optional(),
  lineDefinition: FormDefinition.optional(),
  numberPattern: z.string().max(80).default('{PREFIX}/{FYS}/{SEQ:5}'),
});
export const DocTypeUpdate = DocTypeCreate.pick({ name: true, pluralName: true, description: true, settings: true }).partial().extend({ version: z.number().int() });

export interface DocTypeSummary {
  id: string;
  key: string;
  name: string;
  pluralName: string;
  description: string | null;
  kind: 'system' | 'custom';
  isActive: boolean;
  headerFormKey: string;
  lineFormKey: string | null;
  settings: DocTypeSettings;
  /** Status keys/labels that exist for this type (draft + one per workflow stage + outcomes). */
  statuses: { key: string; label: string; tone: 'neutral' | 'blue' | 'amber' | 'green' | 'red' }[];
  version: number;
}

// ---------------------------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------------------------

/** Tokens: {PREFIX} (doc type key upper-cased unless the pattern has literal text), {LOC} location code,
 *  {FY} '2026-27', {FYS} '26-27', {YYYY}, {YY}, {MM}, {SEQ:n} zero-padded sequence (n 1–9). */
export const NumberingSeriesInput = z.object({
  docTypeKey: z.string(),
  name: z.string().trim().min(1).max(80),
  locationNodeId: Uuid.nullable().default(null),
  pattern: z.string().min(1).max(80).refine(p => /\{SEQ:[1-9]\}/.test(p), 'Pattern must contain {SEQ:n}'),
  reset: z.enum(['never', 'fy', 'month']).default('fy'),
  isActive: z.boolean().default(true),
});
export interface NumberingSeriesRow {
  id: string; docTypeKey: string; name: string; locationNodeId: string | null; locationName: string | null;
  pattern: string; reset: 'never' | 'fy' | 'month'; isActive: boolean;
  /** What the next number would be right now for this series (not reserved). */
  preview: string; version: number;
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

/** Quantities per line. Stored buckets + derived pending figures. All decimal strings. */
export interface QuantityBuckets {
  requested: string; approved: string; held: string; rejected: string; cancelled: string; shortClosed: string;
  overApproved: string; selected: string; ordered: string; received: string; accepted: string;
  rejectedAtReceipt: string; issued: string; returned: string;
  /** requested − approved − rejected − cancelled (includes held; over-approval does not re-open approval). */
  pendingApproval: string;
  /** approved + overApproved − ordered − shortClosed (Phase 4; equals approved for custom types). */
  pendingOrder: string;
  /** ordered − received (Phase 4/5). */
  pendingReceipt: string;
}

export const LineWrite = z.object({
  /** Existing line id when editing; omit for a new line. Lines omitted from an update are deleted (draft only). */
  id: Uuid.optional(),
  /** Values keyed by line form field keys (system keys map to columns). */
  values: z.record(z.string(), z.unknown()),
});

export const DocumentWrite = z.object({
  /** Values keyed by header form field keys (system keys map to columns). */
  values: z.record(z.string(), z.unknown()),
  lines: z.array(LineWrite).max(1000).default([]),
});
export const DocumentUpdate = DocumentWrite.extend({ version: z.number().int() });

export interface DocumentLineRow {
  id: string;
  lineNo: number;
  values: Record<string, unknown>;          // system + custom, keyed by form field keys
  refs: Record<string, Record<string, string>>;
  statusKey: string;
  qty: QuantityBuckets;
  /** Where the line's remaining quantity sits in the workflow: stage -> { pending, held }. */
  stages: Record<string, { pending: string; held: string }>;
  cancelledReason: string | null;
  version: number;
}

export interface DocumentRow {
  id: string;
  docTypeKey: string;
  number: string | null;
  statusKey: string;
  statusLabel: string;
  values: Record<string, unknown>;
  refs: Record<string, Record<string, string>>;
  files: Record<string, unknown>;
  formVersionId: string;
  lineFormVersionId: string | null;
  isLocked: boolean;
  /** Amendment revision (0 = original). */
  revNo: number;
  submittedAt: string | null;
  submittedBy: { id: string; name: string } | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
  lines: DocumentLineRow[];
  workflow: WorkflowRuntimeView | null;
  /** Buttons the caller may use right now (permission ∩ state), so the UI never guesses. */
  allowedActions: ('edit' | 'delete' | 'submit' | 'cancel' | 'cancel_lines' | 'close' | 'copy' | 'comment' | 'attach' | 'decide' | 'unhold' | 'send_back' | 'forward')[];
  version: number;
}

/** Workflow state as shown on a document (filled by the workflow module). */
export interface WorkflowRuntimeView {
  instanceId: string;
  workflowVersion: number;
  status: 'running' | 'completed' | 'cancelled';
  stages: {
    key: string; name: string; status: 'pending' | 'active' | 'done' | 'skipped' | 'disabled'; skipReason: string | null;
    enteredAt: string | null; dueAt: string | null; completedAt: string | null; overdue: boolean;
    /** Stage keys the caller can act on. */
    canAct: boolean;
    /** Who can act (names), for "waiting for …". */
    actors: string[];
  }[];
  /** Per stage: actions configured for that stage (approve, partial, reject, hold, send_back, forward). */
  stageActions: Record<string, string[]>;
  /** 'line' = per-line quantities; 'document' = one outcome for all lines (send `outcome` in decide). */
  granularity: 'line' | 'document';
  /** Per stage: line fields approvers may edit while deciding (Stage.editableLineFields). */
  editableLineFields: Record<string, string[]>;
  /** Per stage: decisions that need a reason (Stage.requireReasonOn). */
  requireReasonOn: Record<string, string[]>;
}

/** List query for GET /docs/:type. Filters on system columns and custom fields. */
export const DocListQuery = z.object({
  view: z.enum(['document', 'item']).default('document'),
  status: z.union([z.string(), z.array(z.string())]).optional(),   // status view keys the caller holds
  q: z.string().trim().max(200).optional(),                         // number, custom text, item code/name (item view)
  location: Uuid.optional(),                                        // + descendants
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  item: Uuid.optional(),
  party: Uuid.optional(),
  sort: z.string().regex(/^-?[a-z_][a-z0-9_]*$/).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  savedView: Uuid.optional(),
  /** Exact-value filters on custom fields: f.<field>=<value>. */
});

/** Document-wise list row. */
export interface DocListRow {
  id: string; number: string | null; statusKey: string; statusLabel: string; docDate: string;
  location: { id: string; name: string }; totalAmount: string | null; lineCount: number;
  createdBy: string | null; createdAt: string; submittedAt: string | null;
  /** Requested columns from custom fields: key -> display value. */
  columns: Record<string, unknown>;
  overdue: boolean;
}
/** Item-wise list row (one per line across documents). */
export interface ItemListRow {
  lineId: string; documentId: string; number: string | null; lineNo: number; statusKey: string; statusLabel: string;
  item: { id: string; code: string; name: string } | null; uom: string | null; location: { id: string; name: string };
  requiredDate: string | null; qty: QuantityBuckets; columns: Record<string, unknown>;
}

export const CancelInput = z.object({ reason: z.string().trim().min(3).max(500), lineIds: z.array(Uuid).optional() });
export const CloseInput = z.object({ reason: z.string().trim().min(3).max(500), lineIds: z.array(Uuid).optional() });

// ---------------------------------------------------------------------------------------------
// Collaboration, timeline, saved views, audit
// ---------------------------------------------------------------------------------------------

/** Mentions are written as @[Name](user:<uuid>) in the body; the server extracts and validates ids. */
export const CommentInput = z.object({ body: z.string().trim().min(1).max(5000), parentId: Uuid.optional() });
export interface CommentRow { id: string; parentId: string | null; body: string; mentions: { id: string; name: string }[]; createdBy: { id: string; name: string }; createdAt: string; editedAt: string | null; canEdit: boolean }

export const AttachmentInput = z.object({ fileId: Uuid, note: z.string().max(500).optional() });
export interface AttachmentRow { id: string; file: { id: string; filename: string; mime: string; sizeBytes: number; url: string | null; thumbUrl: string | null }; note: string | null; createdBy: { id: string; name: string }; createdAt: string }

export type TimelineKind = 'created' | 'updated' | 'submitted' | 'status' | 'workflow' | 'comment' | 'attachment' | 'cancelled' | 'closed' | 'quantity' | 'audit';
export interface TimelineEntry {
  id: string;                 // stable per source: 'audit:123', 'wf:<uuid>', 'comment:<uuid>' …
  kind: TimelineKind;
  at: string;
  actor: { id: string; name: string } | null;
  onBehalfOf?: { id: string; name: string } | null;
  impersonatedBy?: { id: string; name: string } | null;
  title: string;              // human sentence, e.g. "Approved 2 lines, held 1, rejected 1 at HOD approval"
  detail?: string | null;     // comment text / reason
  changes?: { field: string; label: string; before: unknown; after: unknown }[];
  lineDecisions?: { lineNo: number; approve?: string; hold?: string; reject?: string; reason?: string | null }[];
}

export const SavedViewConfig = z.object({
  columns: z.array(z.string()).max(40).optional(),
  filters: z.record(z.string(), z.unknown()).default({}),   // same keys as DocListQuery (+ f.<field>)
  sort: z.string().optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
});
export const SavedViewInput = z.object({
  scopeKey: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(80),
  config: SavedViewConfig,
  shared: z.boolean().default(false),
  sharedRoleIds: z.array(Uuid).default([]),
  isDefault: z.boolean().default(false),
});
export interface SavedViewRow { id: string; scopeKey: string; name: string; config: z.infer<typeof SavedViewConfig>; shared: boolean; sharedRoleIds: string[]; isDefault: boolean; isMine: boolean; version: number }

export const AuditQuery = z.object({
  entity: z.string().optional(), entityId: z.string().optional(), actorId: Uuid.optional(), action: z.string().optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
});
export interface AuditRow { id: string; at: string; actor: { id: string; name: string } | null; impersonatedBy: { id: string; name: string } | null; action: string; entity: string; entityId: string | null; before: unknown; after: unknown; ip: string | null; userAgent: string | null }
export interface AuditCheckRow { checkedAt: string; rowsChecked: number; ok: boolean; firstBadId: string | null; detail: string | null }

/** Domain events written to the outbox (ADR-0012). Payload shapes are documented in the API contract. */
export type DomainEventType =
  | 'document.created' | 'document.submitted' | 'document.updated' | 'document.cancelled' | 'document.closed'
  | 'document.status_changed' | 'workflow.stage_entered' | 'workflow.decided' | 'workflow.completed'
  | 'workflow.sent_back' | 'workflow.forwarded' | 'workflow.sla_reminder' | 'workflow.sla_escalated'
  | 'comment.created' | 'comment.mentioned' | 'limit.warning';
