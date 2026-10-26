# Phase 7 API contract (FROZEN, builder engine part) — reports, report builder, dashboards, exports

Types: `packages/schema/src/reports.ts`. Migration `0013_reports.sql`. ADR-0015. This batch builds the engine, the
builder, dashboards and background exports. The **ready-made** procurement/stock reports (indent ageing, PO vs GRN,
vendor performance, stock ledger …) are definitions added after Phases 4–5 land, on this same engine.

## Engine
- **Catalogue registry** (`ReportsCatalogue.registerSource(def)` exported by `modules/reports`): each source declares
  its base query (Kysely builder factory), its allow-listed fields (`CatalogueField` + SQL expression), joins
  available (location, item, item.category, vendor, created_by …), and how scope/field access apply. Built-in
  sources, generated at run time from configuration (no code per tenant):
  - `doc:<type>` — documents of a type; fields: system columns, status label, location (+ path names), party,
    creator, submitted at, every header custom field (`custom.<key>` typed from the current header form), workflow
    current stage, overdue flag.
  - `doc_line:<type>` — lines; fields: header fields + line system/custom fields + all `QuantityBuckets` +
    item master attributes (code, name, any item data field incl. lookups like category name).
  - `master:<key>` — master records; fields: code, name, active, every data field (lookups resolved to name).
  - `engine:*` — registered by modules (Phase 4 `vendor_quote`, `po_followup`; Phase 5 `stock_ledger`,
    `stock_balance`).
- **Compiler**: definition → parameterised SQL via Kysely (no string concatenation of user input; field ids map
  only to catalogue expressions). Applies RLS (tenantTx), data scope (`ScopeService` on the source's location
  column for the source's tab key), field access (hidden fields removed from the catalogue for that user), view
  permissions (doc sources only include statuses the user can view). Aggregates + GROUP BY, totals row, sorting,
  keyset pagination for detail rows, `rowLimit` (max 100k; UI pages 200), statement timeout 15 s.
- **Permissions**: running a report needs `reports:action.view` + view access to its source tab (`doc.<type>`,
  `master.<key>`, or the engine source's declared key). Building needs `reports:action.build` (feature
  `report_builder`). Sharing to roles needs `reports:action.share`.

## Endpoints
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/reports/sources` | – | `SourceCatalogue[]` (only sources the user may read; fields filtered by field access) | `reports:action.view` |
| GET | `/reports` | – | report list (built-in + mine + shared with my roles) | `reports:action.view` |
| GET / POST / PUT / DELETE | `/reports[/:id]` | `ReportInput` | report | build / owner; built-ins are read-only (copy to customise) |
| POST | `/reports/:id/run` | `ReportRunInput` | `ReportResult` | view (+ source access) |
| POST | `/reports/preview` | `{ definition, params }` | `ReportResult` (first 200 rows) | `reports:action.build` |
| POST | `/reports/:id/schedules` / GET / DELETE | `ScheduleInput` | schedule rows | `reports:action.schedule`; run as the creating user; each run is an export job (xlsx / csv / pdf). When ready: in-app notification with the link to user recipients, and an email to every recipient (users at their account email + literal addresses, case-insensitive de-duplication) through the notify email channel as a system message (no template) with a signed download link valid until the export expires (7 days; absolute when `FILE_URL_BASE` is set, plus the in-app `/exports/:id` link). Notify applies the `email` feature / provider gate and the `email_per_month` quota per recipient (over quota → `blocked_limit`); idempotency key `report:<exportJobId>` per address |
| POST | `/exports` | `ExportRequest` | `ExportJobRow` (queued) | per kind: report view / list tab view + `…export` action where it exists |
| GET | `/exports` / `/exports/:id` | – | `ExportJobRow[]` / row (signed file URL when ready; files expire after 7 days) | requester |
| GET / POST / PUT / DELETE | `/dashboards[/:id]` | `DashboardInput` | dashboard | `dashboards:action.view` / `…edit` |
| GET | `/dashboards/mine` | – | the user's default dashboard (role default → personal → built-in "My work": inbox counts + doc counts per type) | any |
| POST | `/dashboards/widgets/:widgetId/data` | `{ dashboardId }` | widget data (`kpi`: value + delta; `chart`; `table`; `doc_counts`: status counts with list links) | view |

Exports: queue `exports` (concurrency 2), streams rows in 5k batches to xlsx (exceljs streaming writer) / csv / pdf
(simple table via `TEMPLATE_RENDERER.renderTablePdf` — the templates module's network-locked Chromium renderer; first
5,000 rows with a note when truncated, 60 s render timeout; `400` only when no renderer is registered), stores a file (`file_object`, not counted
against storage limit; deleted after 7 days by a daily job), notifies the requester (in-app "Your export is ready").
List exports (`kind: 'list'`) reuse the documents list query + filters (both views) and master list query. Large
master imports move to this queue (ADR-0012 supersedes ADR-0007) — not in this batch unless time permits.

## Built-in reports in this batch (sources from Phases 1–3)
"Pending approvals by user and stage" (engine source `workflow_pending` — registered by you over wf tables),
"Documents by status and location" (any doc type, param doc type), "Audit trail" (engine source `audit` with
`admin.audit:action.view`), "Users and roles". Procurement/stock built-ins follow Phases 4–5.

## Standard report pack (system reports, `modules/reports/pack/`)
Installed per tenant by `installReportBuiltins` (BUILTINS_VERSION 2; idempotent, advisory-locked, refreshed on
version bump / daily) as `kind: 'builtin'` (read-only; copy to customise). A system report is listed / readable only
when the tenant has its source's feature and the viewer holds the source's view key (`ReportsCatalogue.available`);
columns over fields the viewer cannot see (e.g. stock value without `stock:action.view_value`) are dropped at run time.
- Procurement: indent status & ageing, pending procurement approvals by stage & approver, vendor quote comparison
  history, rate history by item & vendor, PO pending delivery, PO vs GRN, vendor performance, purchase value by
  vendor / item / location / month.
- Stock: stock summary by location, stock ledger, item movement summary (opening / in / out / closing for a period),
  consumption by department & location, re-order / below-minimum, expiring batches, quarantine & rejected stock.
- Dashboards "Procurement overview" / "Store overview" (`layout.builtin`, `layout.requires`, `layout.features`):
  visible with a required key + feature; default (`/dashboards/mine`) for non-admin viewers holding the keys, after a
  company-built role default; `isDefaultForRoleIds` = roles granting the keys (recomputed on install).
- Engine additions: sources `purchase_lines`, `stock_movement_summary` (consumes the run's date range),
  `stock_consumption`, `stock_reorder`; extensions of `vendor_quote` (rank, lowest rate, % above lowest) and
  `stock_balance` (days to expiry, expiry bucket); doc sources gain `age_days` / `age_bucket`; `workflow_pending`
  gains `doc_type.module` and resolves stage-key holders for stages without actors. Ratio fields
  (`SourceField.ratio`) average as weighted ratios of sums. Any report accepts `params.dateFrom` + `params.dateTo`.
