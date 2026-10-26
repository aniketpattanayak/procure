# Phase 3 API contract (FROZEN) — documents core + workflow engine

Base `/api/v1`. Types: `packages/schema/src/documents.ts`, `workflow.ts`. Migrations `0008_documents.sql`,
`0009_workflow.sql`. Module seams: `apps/api/src/core/ports.ts` (DocumentsPort, WorkflowPort, EffectRegistry),
queues: `core/queue.service.ts`, worker entry `src/worker.ts`. ADRs 0010–0012. Every rule from Phase 2 (permissions,
views, field access, data scope, audit in the same transaction) applies.

## Permission keys generated per document type
Registry rows in `app.permission_def`: static keys with `source = 'form'`, `source_id = doc_type.id`; stage keys and
stage views with `source = 'workflow'`, `source_id = workflow_def.id`.

Tab `doc.<key>` (group label `Modules`, `scoped: true`; system types later also `requires_feature = module_key`).
Actions: `view, add, edit, delete, submit, cancel, close, copy, comment, attach`, plus **one per workflow stage**
`stage_<stageKey>` ("Act on <stage name>"). Views: `draft, on_hold, partially_approved, approved, rejected,
cancelled, closed` plus **one per stage** `waiting_<stageKey>`. Stage keys/views are regenerated when a workflow is
published (removed stages' keys are deleted together with their grants; renamed stage labels update). Creating a doc
type writes the static keys; the workflow module writes the stage keys. Bump permver after either.

Data scope: lists, detail and every action filter by `document.location_node_id` within the caller's scope for
`doc.<key>` (out of scope → 404). Creating requires the chosen location in scope.

## Document types & numbering (documents agent)
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/doc-types` | – | `DocTypeSummary[]` (types the caller can view; all for `config.doc_types:action.view`) | any |
| POST | `/config/doc-types` | `DocTypeCreate` | `DocTypeSummary` | `config.doc_types:action.add`. Creates header form `<key>_header` (system fields `location` (lookup, source location, required), `doc_date`, `required_by`, `total_amount` (formula `SUM(lines.amount)` when lines have `amount`)) and, if `hasLines`, line form `<key>_line` (system `item` (lookup → item, if `itemLines`), `uom` (lookup → uom, autofilled from item), `qty` (decimal, required), `rate`, `amount` (formula `qty * rate`), `required_date`). Default numbering series. Counts against `custom_forms`. |
| PUT | `/config/doc-types/:key` | `DocTypeUpdate` | `DocTypeSummary` | `config.doc_types:action.edit` |
| POST | `/config/doc-types/:key/deactivate` \| `/activate` | – | `DocTypeSummary` | same |
| GET | `/config/numbering?docType=` | – | `NumberingSeriesRow[]` | `config.numbering:action.view` |
| POST / PUT | `/config/numbering` / `/config/numbering/:id` | `NumberingSeriesInput` (+ `version`) | `NumberingSeriesRow` | `config.numbering:action.edit`. One active series per (type, location); pattern must contain `{SEQ:n}`; editing a pattern never renumbers issued documents. |
| GET | `/config/numbering/:id/preview` | `?locationId=&date=` | `{ number }` | `…view` |

Header/line forms are ordinary forms (Phase 2 form builder, `kind = 'transaction'`): system fields above cannot be
removed; tenants add any custom fields. The forms module must accept the doc-type form keys and the `lines` virtual
grid for formula scope (documents agent may extend the forms module's evaluation adapter for this — coordinate via
exported functions only).

Numbering: series = most specific active series whose location is the document's location or nearest ancestor,
else the one with no location. Number assigned in the submit transaction: `UPDATE numbering_counter … RETURNING`
(insert-on-conflict first) so concurrent submits never collide or skip. `{FY}` uses the tenant's `fy_start_month`.

## Documents (documents agent)
| Method | Path | Body / Query | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/docs/:type` | `DocListQuery` + `f.<field>` | `Page<DocListRow>` (view=document) or `Page<ItemListRow>` (view=item) | `doc.<type>:action.view` + each requested status view key; no `status` = all statuses the caller holds |
| GET | `/docs/:type/counts` | same filters minus status | `{ statusKey, label, count }[]` for permitted views (chips with counts) | `…view` |
| POST | `/docs/:type` | `DocumentWrite` | `DocumentRow` (draft, no number) | `…add` |
| GET | `/docs/:type/:id` | – | `DocumentRow` (with `workflow`, line `qty` buckets, `stages`, `allowedActions`) | `…view` + view of its status |
| PUT | `/docs/:type/:id` | `DocumentUpdate` | `DocumentRow` | `…edit`; only while status ∈ `settings.editableStatuses` and not locked; lines omitted = deleted (draft only) |
| DELETE | `/docs/:type/:id` | – | 204 | `…delete`; draft only (soft delete) |
| POST | `/docs/:type/:id/submit` | `{ version }` | `DocumentRow` | `…submit`. Validates (same pipeline as save, plus required system fields and ≥ 1 line with qty > 0 when the type has lines), assigns number, writes `requested` events, locks, `WorkflowPort.start`, outbox `document.submitted`. |
| POST | `/docs/:type/:id/cancel` | `CancelInput` | `DocumentRow` | `…cancel`. Whole document (not in a final state) or `lineIds`; writes `cancelled` events for each line's remaining qty (pending + held in workflow), `WorkflowPort.linesCancelled/cancel`. Reason required. |
| POST | `/docs/:type/:id/close` | `CloseInput` | `DocumentRow` | `…close` (short-close remaining qty; used by Phase 4 for ordered qty — for custom types closes the doc) |
| POST | `/docs/:type/:id/copy` | – | `DocumentRow` (new draft with same values/lines, no number) | `…add` + `…copy` |
| GET | `/docs/:type/:id/timeline` | – | `TimelineEntry[]` newest first (audit, workflow actions with line decisions, comments, attachments, quantity events summarised, status changes) | `…view` |
| GET / POST | `/docs/:type/:id/comments` | `CommentInput` | `CommentRow[]` / `CommentRow` | view / `…comment`. Mentions `@[Name](user:<id>)` must be active users of the tenant; each mentioned user gets an in-app notification (`kind: 'mention'`, link to the document) and outbox `comment.mentioned`. |
| PUT / DELETE | `/docs/:type/:id/comments/:commentId` | `CommentInput` / – | `CommentRow` / 204 | author only, within 15 minutes for edit; delete is soft and shows "comment removed" |
| GET / POST / DELETE | `/docs/:type/:id/attachments[/:attId]` | `AttachmentInput` | `AttachmentRow[]` / `AttachmentRow` / 204 | view / `…attach` (file must be clean, tenant-owned; sets `file_object.attached_to`) |
| GET / POST / PUT / DELETE | `/saved-views[/:id]` | `?scope=` / `SavedViewInput` | `SavedViewRow[]` / row | any user for personal views; shared views need the tab's `…view` and only tenant admins or holders of `admin.roles:action.edit` may share to roles |

Status computation (documents agent, `recomputeStatus`): per line from ledger + workflow line state:
`cancelled` (requested fully cancelled) · `waiting_<s>` for the earliest active stage holding pending qty ·
`on_hold` (only held qty remains in workflow) · `rejected` (approved = 0 and nothing pending/held) ·
`partially_approved` (approved > 0 and approved < requested − cancelled, nothing pending/held) · `approved` ·
`closed`. Document: `draft` before submit; else the first of `waiting_<earliest stage across lines>`, `on_hold`,
`partially_approved` (mix of approved and rejected/reduced lines), `approved`, `rejected`, `cancelled`, `closed`.
Labels: `waiting_<s>` → stage `statusLabel` or "Waiting for <stage name>".

## Workflow (workflow agent)
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/config/workflows` | – | `{ docTypeKey, name, publishedVersion, hasDraft, stageCount }[]` | `config.workflows:action.view` |
| GET | `/config/workflows/:docType` | – | `WorkflowDetail` | same |
| PUT | `/config/workflows/:docType/draft` | `WorkflowDraftSave` | `WorkflowDetail` (with `draftIssues`) | `…edit` |
| DELETE | `/config/workflows/:docType/draft` | – | `WorkflowDetail` | `…edit` |
| POST | `/config/workflows/:docType/publish` | `WorkflowPublish` | `WorkflowDetail` | `…publish`; rejects with issues; regenerates stage permission keys + views; running documents stay on their version |
| GET | `/config/workflows/:docType/versions[/:v]` | – | rows / `WorkflowDefinition` | `…view` |
| POST | `/config/workflows/:docType/simulate` | `SimulateInput` | `SimulateResult` | `…view` |
| POST | `/docs/:type/:id/actions` | `WorkflowActionInput`, headers `If-Match: <document version>` (optional but recommended), `Idempotency-Key` | `DocumentRow` | stage key `doc.<type>:action.stage_<stage>` + actor rules + scope; decide/unhold/send_back/forward must be in the stage's `actions` |
| GET | `/approvals` | `?docType=&stage=&overdue=&cursor=&limit=` | `Page<InboxItem>` | `approvals:action.view` |
| GET | `/approvals/counts` | – | `InboxCounts` | same |

Engine rules (all server-side, one transaction per action, document row `FOR UPDATE` first, then
`wf_line_state` rows in line-id order):
- **Start**: resolve stages in order; evaluate `when` with `@procure/formula` against the header values + `lines`
  aggregates (lookups available); skipped/disabled stages recorded in `wf_stage_state` with `skip_reason`. Parallel
  groups activate together. All submitted qty enters the first runnable stage(s) as `pending`. No runnable stage →
  every line approved immediately (`approved` events, action `auto_approve`).
- **Who can act**: holds `stage_<key>` permission; document location in scope; matches any actor rule (or any
  rule empty); not the submitter unless `allowSelfApproval`; or has an active `wf_assignment` (forward/escalation).
  No eligible user at stage entry → `ifNoActor` (skip with log, or assign tenant admins via `wf_assignment`).
- **decide** (line granularity): for each decision, `approve + hold + reject` must equal that line's current
  `pending` at the stage (decimal-exact); lines not mentioned stay pending. Reason rules per `requireReasonOn`;
  a reduction (approve < pending with reject > 0 or partial) needs a reason. Effects: approve → moves qty to the
  next stage group (or out: ledger `approved` after the last stage); hold → `held` at this stage + ledger `held`;
  reject → ledger `rejected`. Document granularity: `outcome` applied to all pending lines.
- **quorum 'all'**: each resolved actor records a decision; the stage completes when all have decided; merged
  approve = minimum approved per line; any reject rejects that line's qty.
- **unhold**: held → pending at the same stage + ledger `unheld`.
- **send_back** to an earlier stage: all qty in workflow at later stages moves back to that stage as pending; to
  `_draft`: `WorkflowPort.cancel`, document returns to draft (editable), lines' requested qty reset via ledger
  `cancelled` for remaining pending qty and resubmission writes new `requested` events (ledger stays append-only).
- **forward**: adds a `wf_assignment` for the target user (who must hold `doc.<type>:action.view` and have the
  location in scope) — they can then act on that stage.
- **Completion**: when no qty remains pending/held at any stage → instance `completed`, `onComplete` effects,
  outbox `workflow.completed`.
- **Effects** run via `EffectRegistry` in the same transaction; Phase 3 registers `lock_editing`,
  `unlock_editing`, `close_document`, `notify` (in-app), `emit` (outbox), `route_to`. Others are rejected at
  publish as `EFFECT_UNAVAILABLE` until their module registers them.
- **SLA**: on stage activation set `due_at = entered_at + sla.hours`, `next_reminder_at` per `remindEveryHours`.
  Repeatable job `workflow-sla` every minute (queue `workflow`): sends reminders (in-app notification to eligible
  actors, `wf_action` 'remind', outbox `workflow.sla_reminder`), and at `due_at` escalates once (assign
  `escalateTo` via `wf_assignment`, notify, outbox `workflow.sla_escalated`). Overdue flags in inbox and detail.
- **Concurrency**: two actors deciding the same pending qty → the second gets 409 `QTY_CHANGED` (pending no longer
  matches) or `VERSION_CONFLICT` with `If-Match`. Same `Idempotency-Key` → original result, no second action.
- In-app notifications: stage entered → eligible actors (`approval_pending`); decision → submitter
  (`document_decided`); mentions; SLA reminder/escalation. Cap fan-out at 200 users per event.

## Audit (documents agent)
| Method | Path | Query | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/audit` | `AuditQuery` | `Page<AuditRow>` | `admin.audit:action.view` |
| GET | `/audit/checks` | – | `AuditCheckRow[]` (latest 30 for this tenant) | same |
| POST | `/audit/checks` | – | `AuditCheckRow` (runs the chain verification now for this tenant) | `admin.audit:action.verify` |
Nightly repeatable job `audit-verify` (02:30 UTC) verifies every tenant's chain + the platform chain and stores
`platform.audit_check` rows; a failure notifies tenant admins and logs an error.

## Outbox & queues (documents agent)
Outbox relay: repeatable job every 2 s (queue `outbox`) — `SELECT … FROM app.outbox_event WHERE published_at IS NULL
ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED` under the platform role, publish each to queue `events` with
`jobId = outbox:<id>`, set `published_at`. Phase 3 consumer on `events`: none required beyond logging (in-app
notifications are written directly in the business transaction); Phase 6 adds the trigger engine.

## Seed (demo)
`acme`: custom document type **Capex Request** (`capex`): header custom fields `purpose` (textarea, required),
`priority` (select Normal/Urgent), `justification` (textarea, `visibleWhen: priority = 'Urgent'`,
`requiredWhen` same); line form: item, uom, qty, `est_rate` (currency, required), `amount = qty * est_rate`,
`remarks`. Numbering `CAPEX/{LOC}/{FYS}/{SEQ:4}` with a Pune-specific series `CPX-PUN/{FYS}/{SEQ:4}`.
Workflow (seeded by the workflow agent, published v1): `hod` "HOD approval" (role Approver, any, SLA 24 h remind
every 8 h, escalate to tenant admin) → `finance` "Finance review" (`when: total_amount > 100000`, role Buyer, actions
approve/reject/send_back) → `director` "Director approval" (`when: total_amount >= 500000`, users: acme admin,
document granularity). Roles get `doc.capex:*` keys sensibly; the indenter gets add/edit/submit/view on capex and
views draft + rejected + waiting_hod. Two sample documents in different states.
