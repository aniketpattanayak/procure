# Phases 4 / 6 / 7 QA report (QA47)

Date: 2026-10-22/23. Environment: local sandbox, agent slot `qa47` (`AGENT_REDIS_PORT=6380 source scripts/agent-env.sh qa47 12 4112 3112`):
dev DB `procure_qa47`, test DB `procure_test_qa47`, Redis 6380/12–13, API :4112 (`apps/api/dist`, `RUN_WORKERS=inline`), web :3112
(production `next build` of a scratch copy of `apps/web` — the shared `.next` and the 8 GB box could not take a `next dev`
alongside the other agents; Chromium crashed on dev bundles). Chromium 141 (`/opt/pw-browsers/chromium-1194`), Node 22.22.
Scope: Phase 4 procurement, Phase 6 templates/PDF/notifications, Phase 7 reports engine, against
`docs/contracts/phase-4-api.md`, `phase-6-api.md`, `phase-7-api.md` and ADRs 0013–0015.

**Result: the happy paths work end to end in the real UI (indent → quote → comparison → selection → PO → PDF → email
preview; report builder → run → dashboard). Ledger maths, GST, RLS isolation and permission gating are solid —
every Phase 4/6/7 endpoint returned 404 for another tenant's ids and 403 for a missing action key. I filed 10 bugs:
1 critical (fixed in QA), 1 high, 5 medium (1 fixed in QA), 3 low (1 fixed in QA). The critical one: outgoing
webhooks could never be delivered on Node ≥ 20 — the pinned-IP `lookup` answered in the wrong shape, so every
real delivery failed and endpoints would auto-disable after 50 attempts. The existing suite stubs the transport,
so it never saw this. The high one: PO PDFs and emails show a grand total short by the header discount.**

Verdict: **conditional pass** — ship after QA47-BUG-007 (wrong PO grand total on the document sent to vendors) is fixed;
the Medium items should be scheduled for the next round.

## What ran

| Suite | Command | Baseline (before QA) | After QA |
| --- | --- | --- | --- |
| Phase 4/6/7 API suites (20 files) | `cd apps/api && pnpm vitest run test/procurement test/templates test/notify test/reports` | 20 files, 250 tests, all green | 250 still green, except 2 in `reports.engine.test.ts` that broke between runs from another agent's change (see "Not filed") |
| New QA suites | `… test/qa-batch-` | – | **3 files, 52 tests, all as expected**: 46 pass, 6 known-bug repros (`it.fails`) |
| Combined final run | both of the above in one run | – | 23 files, 302 tests: 300 as expected, 2 drift failures (see above) |
| E2E smoke | `E2E_NO_RESET=1 E2E_API_ORIGIN=http://localhost:4112 E2E_WEB_ORIGIN=http://localhost:3112 npx playwright test -c e2e/playwright.config.ts qa47-batch-smoke --project desktop-chromium --output <own dir>` | – | 2 tests, both pass (3 full runs; one earlier run timed out once in J-R under machine load, then passed) |
| Lint | `npx eslint` on all QA files + the 3 touched sources | – | clean |

Pass `--output` to a private directory. `test-results/e2e` is shared: other agents' runs delete trace files under a
running test (ENOENT on `.playwright-artifacts-0`).

## New tests

### API (`apps/api/test/`)
- **`qa-batch-procurement.test.ts`** (19 tests, 2 `it.fails`)
  - Partial quantities end to end, in one flow:
    - Indent 100 is approved at 60. The over-approval cap is computed on the approved 60, not the requested 100: 67 is refused (409) and nothing is half-applied.
    - Selecting 30 for A + 36 for B (over by 6, needs a reason) records `over_qty`.
    - The selection approver trims B to 30, which writes `selection_cancelled`.
    - One `from-lines` call creates 4 draft POs, one per (vendor, ship-to): A@Pune, B@Pune, C@Pune, A@Chennai.
    - Drafts reserve nothing.
    - Partial PO approval (approve 25, reject 5) puts the 5 back as orderable.
    - Ordering 11 against 10 remaining → 400. Two concurrent submits for the last 10 → exactly one gets 409 `QTY_EXCEEDS_REMAINING`.
  - Over-approval rules:
    - Setting 0 → never allowed.
    - Missing key → 409.
    - Key but no reason → 400.
    - The cap counts earlier over-approvals.
    - A short-closed remainder cannot be selected.
  - GST:
    - Vendor 27 → Pune 27: CGST + SGST.
    - Vendor 29 → Pune: IGST.
    - Ship-to Chennai with no state code: IGST.
    - Vendor with no state code: IGST.
    - Header discount is allocated before tax; freight is not taxed.
    - Half-up rounding per component (GST5 on 99.99).
    - Line discount > 100 % or < 0 → 400. A header discount larger than the net value is capped.
  - Amendments:
    - Rate + freight change produces a header + line diff and goes back to approval.
    - GST is recomputed on approval; the ledger is untouched.
    - Needs the amend key; a draft PO cannot be amended.
    - Over-source amendment behaviour (BUG-003).
  - Quotes:
    - Revising a superseded version → 409; history is kept; the vendor cannot change.
    - Slab boundary at 999 vs 1000 kg.
    - Lump-sum freight per unit and landed cost; best quote picked.
    - Garbage qty → 400.
    - Out-of-range numbers (BUG-004, fixed).
  - Permissions: a view-only user gets 403 on all 14 Phase 4 actions:
    - `log_quote` (log and revise)
    - `compare` (line and item)
    - indent `short_close`
    - selection `add` and `submit`
    - PO `add` (orderable and from-lines)
    - `followup`
    - `amend` and withdraw
    - PO `short_close`
    - `create_direct`

    A Chennai-scoped buyer sees 404 or empty results for Pune lines everywhere.
  - Cross-tenant: B's ids on 14 Phase 4 routes (plus print and messages) → 404, with no B data in any body and B's ledger unchanged.
- **`qa-batch-notify.test.ts`** (21 tests, 2 `it.fails`)
  - Template injection, 6 payloads, each via preview and save:
    - constructor chain
    - `lookup` constructor
    - `__proto__`
    - the classic `split` / `apply` RCE chain
    - `each` over the prototype
    - `valueOf` / `toString`

    All render inert or are refused.
  - Compile errors at save: unknown helpers, partials, `log`, `helperMissing`, inline / decorator syntax.
  - Document data with HTML and `{{7*7}}` is escaped and never re-evaluated.
  - A 200 KB+ template → 400. A 60-deep `each` nest → no 500.
  - PDF network lock (real Chromium). Nothing reaches a local listener from any of these:
    - CSS `@import`, `@font-face`, `background`
    - prefetch / preload / icon
    - `<base>`
    - object, embed, video poster
    - SVG `<image>`, srcset
    - form `input[type=image]`
    - an http iframe
    - header/footer template images

    A `file://` iframe's marker text is absent from the PDF (checked with `pdftotext`). The meta refresh case is BUG-009.
  - Trigger rules fire exactly once:
    - The same event handled 6× (5 concurrently) → 1 message per rule and recipient (email + in-app).
    - A new outbox event → a new message.
  - Quota 3/month:
    - 4 concurrent consumers → exactly 3 sends counted and the rest `blocked_limit`.
    - The 100 % notice is sent once.
    - Manual send while exhausted is blocked.
  - Webhooks, SSRF: 34 URL forms → 400:
    - IP literal tricks: `127.1`, `2130706433`, `0x7f.0.0.1`, `0177.0.0.1`, mapped/NAT64/6to4 IPv6, ULA, link-local
    - metadata endpoints
    - `.local` / `.internal` / `localhost.`
    - credentials in the URL, http, ftp
    - mixed DNS answers, NXDOMAIN, multicast, broadcast
  - Webhooks, HMAC:
    - The secret is shown once, encrypted at rest, and absent from get/list/audit.
    - The signature verifies; it fails when tampered, signed with the wrong secret, or outside the replay window.
  - Webhooks, delivery:
    - Send-time DNS re-check blocks before connecting.
    - 3xx is a failure.
    - The **real** HTTPS transport (local TLS server) delivers, and does not follow redirects (BUG-008, fixed).
  - Permissions: 19 Phase 6 actions → 403 without their keys.
  - Cross-tenant: 18 Phase 6 routes with B's template / rule / webhook / message / PDF job / document ids → 404, and B is unchanged.
- **`qa-batch-reports.test.ts`** (12 tests, 2 `it.fails`; the 3 Phase 7 bugs, one of them fixed in QA)
  - 15 non-catalogue ids × 5 places (columns, filters, groupBy, sort, chart) → 400, never 500. Internal / unknown source keys → 400/403/404.
  - SQL injection:
    - 7 payloads × 5 text operators are bound literally, with `%` / `_` escaped.
    - Typed values, params and `datePreset` with SQL → 400 or ignored.
    - Tampered keyset cursors → 400 (BUG-011, fixed).
  - Scope + field access:
    - A report shared with a restricted role that includes a hidden field → 400, with no values in the body; its export is refused up front.
    - The plain shared report and its CSV export contain only in-scope rows.
    - List exports (document-wise and item-wise) honour scope and the hidden header field.
    - CSV formula injection is neutralised (`'=HYPERLINK…`).
    - Dashboard widgets (KPI, table, doc counts) on a shared dashboard run with the viewer's scope.
    - Revoking the role between export request and processing → the job fails with no file.
  - Permissions: 13 missing-key cases → 403. Dashboard sharing is BUG-010.
  - Cross-tenant: 15 Phase 7 calls with A's report / schedule / export / dashboard / widget ids → 404 or 400, with nothing of A in any body. The suite deletes its schedule at the end, because `SchedulesService.scan` is global.

### E2E (`e2e/qa47-batch-smoke.spec.ts`)
- **J-P:** in the UI:
  - Create an indent (location, department, item, qty), then submit.
  - The indent is approved by a second admin via the API, because self-approval is refused.
  - Log a quote in the quotes tab dialog; comparison best = that vendor.
  - Vendor selection page: the quoted vendor is pre-filled; submit. Approval via API.
  - Order page: pick the line and create the PO; it has GST values. Submit through the confirm dialog. Approval via API.
  - Print / PDF dialog generates the PDF.
  - The email send dialog shows the preview with the PO number.
- **J-R:** builder:
  - Source Purchase Orders; add columns via "+ → Add as column"; preview; save; run.
  - Dashboard designer: add a table widget on that report and a doc-count widget; save; widgets render.
  - Table widget data has rows.

## Bug list

| ID | Sev | Area | Title | Repro |
| --- | --- | --- | --- | --- |
| QA47-BUG-008 | **Critical** (fixed in QA) | api | Real webhook transport fails every delivery on Node ≥ 20 ("Invalid IP address: undefined") | `qa-batch-notify` › real HTTPS transport |
| QA47-BUG-007 | **High** (Fixed) | api | PO template context `totals.grand` subtracts the header discount again (the GST engine already allocated it into taxable) → PO PDF / email grand total and amount in words short by the discount; the starter PO layout also shows a second "Discount" row | `it.fails`; Fixed: `context.service.ts` subtracts only the discount not already allocated into taxable (`totals.discountBeforeTax` / `discountAfterTax` / `preDiscount` added); starter PO layout shows "Less: discount" above Taxable value; the installer upgrades unmodified `po_standard` rows (body byte-equal to the previous starter) idempotently. Tests: `it` + 2 regressions |
| QA47-BUG-001 | Medium (Fixed) | api | Over-approved qty rejected by the selection approver stays in `over_approved` → selectable again by a buyer without `over_approve` and without a reason | `it.fails`; Fixed: `selection.service.ts` `onOutcome` writes a new ledger event `over_approval_cancelled` (over_approved −qty, migration `0018_qa47_fixes.sql`) for the over-approval no longer in use. Tests: `it` + ledger/re-over-approve assertions |
| QA47-BUG-003 | Medium (Fixed) | api | A PO amendment raising qty beyond the source's remainder is accepted at resubmit; the approver's approval then fails 409 and the PO stays in approval until someone rejects | `it.fails` + observed test; Fixed: `revisions.service.ts` `resubmit` dry-runs the qty deltas against the source remainder (`PoLedger.checkDeltas`) → 409 `QTY_EXCEEDS_REMAINING` to the buyer. Tests: `it` + within-remainder regression |
| QA47-BUG-006 | Medium (Fixed) | api | Template preview / print / email context is built as the system: a role's hidden fields (e.g. line `est_rate`) are rendered for that user | `it.fails`; Fixed: context builder strips the viewer's hidden fields (incl. dependent formulas, amounts/taxes/totals when the amount is hidden) for preview, print (PDF cache gains an access variant; a PDF with more access than the caller is 404) and manual sends (sender's access, stored on the message for the attachment/WhatsApp). Automatic sends/effects stay full. Tests: `it` + regression |
| QA47-BUG-010 | Medium (Fixed) | api | Dashboards can be shared with / made the default for any role with only `dashboards:action.edit` (no `reports:action.share`), so one user can replace every role's home dashboard | `it.fails`; Fixed: `dashboards.service.ts` requires `reports:action.share` to add shared / default roles (existing roles can be kept or removed without it). Tests: `it` + regression |
| QA47-BUG-004 | Medium (fixed in QA) | api | Quote numbers unbounded: tax % 150 accepted; tax ≥ 1000 % / rate / freight / MOQ ≥ 10^14 → 500 numeric overflow | regression test |
| QA47-BUG-005 | Low (Fixed) | api | `GET /procurement/items/:id/comparison` with another tenant's (or any unknown) item id → 200 empty sheet instead of 404 (no data leaks) | `it.fails`; Fixed: `comparison.service.ts` `forItem` 404s unless the id is a live item master record of the tenant. Tests: `it` + regression |
| QA47-BUG-009 | Low (Fixed) | api | `<meta http-equiv="refresh">` in a PDF layout intermittently fails rendering ("Printing failed", 1/3 in the run). The network lock holds | logging test (timing-dependent, so not `it.fails`); Fixed: `pdf.renderer.ts` `stripNavigation` removes every `<meta http-equiv>` before rendering and the page is served only once (no reload). QA test now asserts 0 failures + regressions |
| QA47-BUG-011 | Low (fixed in QA) | api | Tampered report keyset cursor whose value does not cast to the sort type → 500 | regression test |

QA47-BUG-002 was withdrawn: a line discount above 100 % is already refused. The test stays as a regression test.

### QA47-BUG-008: webhook transport broken (Critical, fixed)
`apps/api/src/modules/notify/webhooks.service.ts` `httpsTransport` pins the vetted IP with a custom `lookup` that
always answers `(null, address, family)`. Node 22's `net` uses `autoSelectFamily` and calls `lookup` with
`{ all: true }`, expecting an array. Every connection failed before sending. Verified with a 10-line script.
**Fix (QA):** answer `[{ address, family }]` when `options.all`. A test against a local TLS server now covers a real
204 delivery and a 302 that is not followed.

### QA47-BUG-007: PO PDF / email grand total wrong with a header discount (High)
`modules/templates/context.service.ts` computes `grand = taxable + tax + freight + other − discount`. For POs, `taxable`
comes from `app.line_tax`, which already has the header discount allocated (`tax/gst.ts`).
Repro: (1000 − 100) × 1.18 + 50:
- PO `grand_total` = 1112.00 (correct)
- context `totals.grand` = 1012.00
- the starter PO layout prints Taxable 900, then "Discount − 100", then Grand total 1,012.00

Not fixed in QA, because the right fix also changes the starter layout, which is stored per tenant. Suggested fix:
- only subtract the part of the discount not already in `taxable` (`discount − (lineTotal − taxable)`);
- show the discount above "Taxable value".

### QA47-BUG-001: over-approval survives a selection rejection (Medium)
`modules/procurement/selection/selection.service.ts` `onOutcome` writes `selection_cancelled` but never reverses
`over_approved`. Selectable = approved + over_approved − selected, so after the approver cuts the excess, the excess
is selectable again with no key and no reason. Fix: when the cancelled qty exceeds the line's remaining approved
headroom, record a negative `over_approved` (or an `over_approval_cancelled` bucket) for that part.

### QA47-BUG-003: amendment over source qty (Medium)
`modules/procurement/revisions/revisions.service.ts` `resubmit` validates vendor and rate but not orderable qty. The
`ledger.order(..., { check: true })` happens only in `finalize` on approval, so the approver gets a 409 they cannot
resolve except by rejecting. Fix: run the same orderable check on the positive deltas at resubmit (409 to the buyer).

### QA47-BUG-006: field access not applied to template contexts (Medium)
`TemplatesController.preview` checks document visibility, then `ContextService.build` loads the row with
`ENGINE(tenantId)`. Any user with `config.templates:action.view` (or `print`) can render hidden header/line fields.
Decide per contract: either strip hidden fields for the requesting user in preview / print, or document that PDFs
are company documents (but preview with a user-supplied body should still strip them).

### QA47-BUG-010: dashboard sharing ungated (Medium)
`modules/reports/dashboards.service.ts` `validate` checks that the roles exist but not `reports:action.share`. The
contract gates sharing to roles for reports. Apply the same key (and arguably restrict `isDefaultForRoleIds` to
admins).

### QA47-BUG-004 / 011 (fixed in QA)
- `procurement/quotes/quotes.service.ts` `validate`: rejects rate / MOQ / freight ≥ 10^14 and tax % > 100 (column precision
  `numeric(18,4)` / `numeric(7,4)`).
- `reports/compiler.ts` `fetchPage`: a class-22 Postgres error on a cursor page → 400 `page.cursor`.

### QA47-BUG-005 / 009 (Low)
- `procurement/quotes/comparison.service.ts` `forItem` should 404 when the item is not a visible item master record.
- `templates/pdf.renderer.ts`: abort main-frame navigations after the first `goto` (e.g. `page.on('framenavigated')` /
  `route` checks `request.isNavigationRequest()` and fulfils with the original HTML), or strip `meta[http-equiv=refresh]`.

### Fix round (agent fix47, 2026-10-23)
All open Phase 4/6/7 bugs above are fixed (see the table). Schema: `db/migrations/0018_qa47_fixes.sql` (ledger event
`over_approval_cancelled`; `generated_pdf.access_key` + `hidden_fields` with the cache key widened; `outbound_message.render_hidden`).
Contract additions (backward compatible): template context `totals.discountBeforeTax`, `totals.discountAfterTax`,
`totals.preDiscount`; `TemplateRenderer.documentContext(tx, id, { viewer | hidden })`, `pdfForDocument(…, { hidden })`,
optional `hiddenFields()`. UI: generic document lists format currency-typed header/line columns with the field's (else the
tenant's) currency (`features/documents/doc-list-page.tsx` `cellText`), e.g. PO "Grand total" ₹24,392.00.

## Performance observations
Dev API latency (acme seed, small volumes, 30 calls each, measured while a `next build` ran on the same 8 GB box):

| Endpoint | p50 | p95 |
| --- | --- | --- |
| `GET /procurement/selectable-lines` | 22 ms | 49 ms |
| `GET /procurement/orderable-lines` | 20 ms | 49 ms |
| `GET /procurement/indent-lines/:id/comparison` | 24 ms | 80 ms |
| `GET /docs/po/:id/taxes` | 14 ms | 67 ms |
| `GET /docs/po/:id` | 28 ms | 55 ms |
| `POST /config/templates/preview` (PO) | 40 ms | 87 ms |
| `POST /docs/po/:id/print` (cached) | 20 ms | 131 ms |
| `POST /reports/:id/run` (built-in) | 20 ms | 29 ms |
| `POST /dashboards/widgets/:id/data` | 26 ms | 40 ms |

- Real Chromium PDF render: about 0.3–1.5 s per page. Browser reused.
- 10k-row xlsx export: in `reports.exports`, unchanged from baseline.
- `reports.perf` (bulk volume test): passes, 6–12 s depending on load.
- The procurement E2E flow (about 40 API calls through the ledger) runs in 1.2–2.5 s in vitest.

No regression and no hot spot found at these volumes. A large-volume procurement load (selectable/orderable lines
over 50k indent lines) was not run in this batch. Recommended before go-live, since `selectable-lines` scans
`line_qty_summary` with an arithmetic predicate (no index can serve `approved + over_approved − selected > 0`).

## Not filed / notes
- **Drift during QA:** `reports.engine.test.ts` › "CRUD … built-ins read-only" and "built-in reports run" started failing
  between my baseline and final runs. New procurement built-ins (`builtin_indent_ageing`, `builtin_po_vs_grn`, …) were
  added by another agent, and the tests hard-code the built-in list. The owner of those built-ins should update the
  tests. Unrelated to the QA fixes.
- The web typecheck/build is currently broken by in-progress Phase 5 code (`features/stock/*` i18n keys). Not this
  batch. I built a scratch copy with `ignoreBuildErrors`.
- Doc-wise list exports show `Total amount` = qty × est_rate. For a single-line document this reveals a hidden
  `est_rate`. That is a field-design issue (derived visible field), not an export bug.
- `landedTotal` in the comparison sheet drops trailing zeros (`54100`, not `54100.00`) despite `fmt(…, 2)`. Cosmetic.
- Jumping from 66 % to 100 % of a quota in one send emits only the 100 % notice (no 80 %). Acceptable; noted for product.
- `{{#> layout}}fallback{{/layout}}` saves (no partials are registered, so only the fallback renders). Harmless.
- Restart note: the machine restarted mid-run. All work was re-verified after the restart (DBs intact, servers restarted).

## Files added or changed by QA
- Added:
  - `apps/api/test/qa-batch-procurement.test.ts`
  - `apps/api/test/qa-batch-notify.test.ts`
  - `apps/api/test/qa-batch-reports.test.ts`
  - `e2e/qa47-batch-smoke.spec.ts`
  - this report
- Fixed (each marked with its QA47 id in a comment):
  - `apps/api/src/modules/notify/webhooks.service.ts` (BUG-008)
  - `apps/api/src/modules/procurement/quotes/quotes.service.ts` (BUG-004)
  - `apps/api/src/modules/reports/compiler.ts` (BUG-011)
- `apps/api/dist` was **not** rebuilt (Phase 5 type errors in the tree). The fixes are exercised by vitest (source),
  and reach the running API on the next build.
