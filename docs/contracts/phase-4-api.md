# Phase 4 API contract (FROZEN) — Indent → vendor quotes → selection → purchase order

Types: `packages/schema/src/procurement.ts` (+ documents.ts, workflow.ts). Migration `0011_procurement.sql`.
ADR-0013. Built ON the Phase 3 documents core and workflow engine: indent, vendor selection and PO are **system
document types** (`doc_type.kind = 'system'`), so lists (document-wise + item-wise), detail, line-level workflow
approvals, numbering, timeline, comments, attachments, saved views and permissions all come from Phase 3. This phase
adds the procurement behaviour around them. Golden rule still applies: no tenant-specific code; every switch is a
setting, form field, workflow or permission.

## Provisioning (system doc types)
Every tenant whose plan has the module gets the type (on tenant creation via the installer, and an idempotent
`ProcurementInstaller.ensure(tx)` run by the seed and on boot for existing tenants):

| Type key | Module feature | Header system fields | Line system fields |
| --- | --- | --- | --- |
| `indent` | `indent` | location, doc_date, required_by + custom `department` (lookup → new system master `department`), `priority` (select Normal/Urgent), `purpose` | item, uom, qty, required_date, `remarks`, `attachments` (files) |
| `vendor_selection` | `vendor_quotes` | location, doc_date | `indent_line` (hidden system ref), item, uom, qty, `vendor` (lookup vendor, required), rate, amount, `quote` (hidden ref), `over_qty` (read-only), `reason` |
| `po` | `purchase` | location (ship-to), doc_date, party (vendor, required), currency, `payment_terms` (lookup), `terms` (multilookup → terms), `freight`, `other_charges`, `discount_amount`, total_amount (formula), `expected_date` | item, uom, qty, rate, `discount_pct`, `tax_code` (lookup → `tax_code`, autofill from item), amount (formula), `schedule` (grid: date, qty), `source_line` (hidden ref), `expected_date` |

New system masters (installer): `department` (code, name), `tax_code` (code, name, `rate_pct` decimal, `cess_pct`
decimal; seeded GST0/5/12/18/28). Item master gains system field `tax_code` (lookup → tax_code). Vendors already
carry `state_code`; locations may carry custom `state_code` (installer adds it to the location form if missing).

Default workflows (published v1 on provisioning, tenant-editable): indent — `verify` "Verification" (line
granularity, approve/hold/reject/send_back); vendor_selection — `approve` "Selection approval"; po — `approve` "PO
approval" (line granularity). Default numbering: `IND/{FYS}/{SEQ:5}`, `VS/{FYS}/{SEQ:5}`, `PO/{FYS}/{SEQ:5}`.

Extra permission keys (beyond Phase 3's generated ones): `doc.indent:action.log_quote`, `doc.indent:action.compare`,
`doc.indent:action.short_close`, `doc.vendor_selection:action.over_approve`, `doc.po:action.followup`,
`doc.po:action.amend`, `doc.po:action.short_close`, `doc.po:action.create_direct`.

Flow settings (Phase 1 SettingsRegistry keys; flipping them hides menus/keys via `requires_setting`):
`flow.indent.enabled` (indent tab + quote/compare keys), `flow.vendor_selection.enabled` (selection type; when off,
POs are created directly from approved indent lines), `flow.po.direct_allowed` (`create_direct`; PO without any
source line), `selection.max_over_approval_pct`. New setting `procurement.landed_cost_formula`
(default `rate * (1 + tax_pct / 100) + freight_per_unit`).

## Ledger semantics (indent line buckets)
- Indent submit → `requested`; indent workflow → `approved` / `held` / `rejected` (Phase 3 engine).
- Selection **submit** → `selected` on each indent line (qty of its selection lines), `over_approved` for the excess
  above approved (needs `…over_approve`, reason, ≤ max %); selection workflow rejection/reduction →
  `selection_cancelled` on the indent line. Concurrency: lock the indent lines' summaries; selectable =
  approved + over_approved − selected + selection_cancelled − short_closed.
- PO **submit** → `ordered` on each source line (selection line AND its indent line; for indent sources just the
  indent line); PO workflow rejection/reduction of a line → `order_cancelled`. Orderable from a source =
  (selection: its approved qty − ordered + order_cancelled; indent with selection off: approved + over_approved −
  ordered + order_cancelled − short_closed). Two buyers ordering the same remaining qty concurrently → exactly one
  succeeds (409 `QTY_EXCEEDS_REMAINING` for the other).
- PO line cancel / short-close → `order_cancelled` / `short_closed` on PO line + `order_cancelled` back on the source
  line(s) for the unreceived qty. Indent short-close → `short_closed` for the unordered remainder.
- `line_link` rows: indent line → selection line (`selected`), selection/indent line → PO line (`ordered`).

## Endpoints
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/procurement/indent-lines/:lineId/quotes` | `?all=true` (include superseded) | `VendorQuoteRow[]` | `doc.indent:action.view` |
| POST | `/procurement/indent-lines/:lineId/quotes` | `VendorQuoteInput` | `VendorQuoteRow[]` (one per line incl. `alsoForLineIds`) | `doc.indent:action.log_quote`; line must be approved (or over-approvable) and not closed |
| PUT | `/procurement/quotes/:quoteId` | `VendorQuoteInput` | `VendorQuoteRow` (new version; old `is_current = false`) | `…log_quote` |
| GET | `/procurement/indent-lines/:lineId/comparison` | `?qty=` (default pending selection) | `ComparisonSheet` | `…compare` |
| GET | `/procurement/items/:itemId/comparison` | `?location=` | `ComparisonSheet` across open indent lines of the item | `…compare` |
| GET | `/procurement/selectable-lines` | `?item=&location=&q=&cursor=` | `Page<OrderableLine>` (approved indent lines with selectable qty) | `doc.vendor_selection:action.add` |
| POST | `/procurement/selections` | `SelectionCreate` | `DocumentRow` (vendor_selection) | `doc.vendor_selection:action.add` (+ `…submit` if `submit`) |
| GET | `/procurement/orderable-lines` | `?vendor=&item=&location=&q=&cursor=` | `Page<OrderableLine>` | `doc.po:action.add` |
| POST | `/procurement/po/from-lines` | `PoFromLines` | `DocumentRow[]` (one draft PO per vendor) | `doc.po:action.add` |
| POST | `/docs/po` (generic) | `DocumentWrite` | direct PO without sources | `doc.po:action.create_direct` + setting |
| GET | `/docs/po/:id/taxes` | – | `{ lines: Record<lineId, TaxLine[]>, totals }` | `doc.po:action.view` |
| GET / POST | `/docs/po/:id/followups` | `FollowupInput` | `FollowupRow[]` / `FollowupRow` | view / `doc.po:action.followup` |
| POST | `/docs/po/:id/amend` | `AmendInput` | `DocumentRow` (status `amending`, editable) | `doc.po:action.amend`; only approved/partially approved, not fully received |
| DELETE | `/docs/po/:id/amend` | – | `DocumentRow` (back to the current revision's values and status) | `doc.po:action.amend`; abandons an amendment that was not resubmitted |
| GET | `/docs/po/:id/revisions` | – | `RevisionRow[]` | view |
| POST | `/docs/indent/:id/short-close` | `ShortCloseInput` `{ reason, lineIds? }` | `DocumentRow` | `doc.indent:action.short_close`; `short_closed` for each line's unordered remainder (`IndentShortCloseService`) |
| POST | `/docs/po/:id/short-close` | `ShortCloseInput` `{ reason, lineIds? }` | `DocumentRow` | `doc.po:action.short_close`; `short_closed` on PO lines + `order_cancelled` back on the source lines for the unreceived qty |

Short-close is implemented per type (the two routes above), not as a generic `/docs/:type/:id/short-close`: other
types have no such route (404) and use the generic `POST /docs/:type/:id/close` (Phase 3 `CloseInput`) instead.
*(Contract amended at release review to match the implementation; earlier drafts listed a generic `:type` route.)*

PO save pipeline additions: GST engine fills `app.line_tax` and the PO totals (taxable, cgst/sgst/igst, grand) on
every save; `schedule` rows must sum to line qty (error on `lines.N.schedule`); `expected_date` = earliest open
schedule date unless a follow-up revised it; T&C bodies snapshotted into the document on approval; currency from
the vendor (default tenant currency).

Amendment flow: `amend` snapshots the current PO as `document_revision` rev N (rev 0 = first approval), sets status
`amending` (document editable for qty/rate/schedule/terms, lines may be added; lines with receipts can't go below
received qty — Phase 5 enforces), resubmit computes the diff, writes rev N+1 (`open`), runs the PO workflow on the
amended document, and on approval applies ledger deltas (`ordered` / `order_cancelled`) and marks the revision
`approved`; on rejection restores the snapshot values (revision `rejected`). `rev_no` shown as "Rev 2" on the PO.

Follow-ups: append-only; a follow-up with `revisedExpectedDate` updates the PO (or line) `expected_date` and the
detail shows the history (previous → new, reason, who, when). Outbox `po.followup_logged`.

Outbox events added: `indent.quote_logged`, `selection.submitted`, `po.created_from_lines`, `po.amended`,
`po.followup_logged` (plus the generic Phase 3 document/workflow events, which carry `docTypeKey`).

## Reports sources contributed (Phase 7 catalogue hooks)
Register engine sources `vendor_quote` and `po_followup` with the reports module's catalogue registry (Phase 7 API
`registerSource` — if not present yet, export plain functions describing the columns; the reports agent wires them).

## Seed (demo)
acme: plan override features `vendor_quotes`, `purchase`, `indent` on; vendors (3 with GSTINs and state codes: one
in Maharashtra (27, same as Pune), one in Tamil Nadu (33), one in Karnataka (29)); items get tax codes; Pune Plant gets
`state_code = 27`; one approved 5-line indent with quotes from 3 vendors incl. a slab quote (₹50/kg up to 999 kg,
10% off at 1,000 kg+), a vendor selection splitting one line 300 kg A / 400 kg B, and one approved PO with a
follow-up.
