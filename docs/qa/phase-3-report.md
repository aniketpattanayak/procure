# Phase 3 QA report — workflow engine, documents core, audit/timeline

Date: 2026-10-22. Environment: local sandbox (Node 22, Postgres 16, Redis, Chromium 141 headless). The machine is
shared with the Phase 4/6/7 agents: load average was 12–14 on 2 cores during the runs. Scope: `docs/contracts/phase-3-api.md`,
`packages/schema/src/{documents,workflow}.ts`, ADRs 0010–0012 and the Phase 3 web screens.

**Result: the Phase 3 journeys work end to end in the real UI against the real API.** That covers:
- line-level approval with hold, reject and reduction;
- routing by amount;
- designer versioning with retired keys;
- send back, forward and SLA;
- permissions and scope;
- mentions;
- a document type built from scratch;
- the audit log and the tamper check.

The engine's integrity holds under every race I tried, and the ledger stayed consistent throughout.

**I filed 17 bugs: 4 high, 6 medium and 7 low.** One high (QA3-BUG-013) was fixed by the lead during the run. The open highs are:
- two field-access leaks (the timeline shows hidden values; approver edits ignore field access);
- attachments cannot be uploaded from the UI;
- the form builder cannot publish a document type's header form.

**Performance meets the 300 ms target except for the item-wise list.** With a status filter it takes about 1 s at
200k lines (QA3-BUG-017). Every known bug has a reproducing `it.fails` / `test.fail` tagged with its id.

## How it was run (and why not from the shared build)

Other agents rebuilt the shared `apps/api/dist` with unfinished Phase 4–7 code while I was testing. The seed then
crashed (`ReportsModule` DI error), and a soft reset had already emptied the dev DB. I also found Redis db 0's BullMQ
repeatables wiped by someone else's run. So:
- **API tests** ran from `apps/api` source with `TEST_DB=procure_test_qa TEST_REDIS_DB=3`, on two code bases:
  - a snapshot of commit `c068240` (Phase 3 as committed; this is the verdict);
  - the current branch `batch/phase-4-6-7` (for information).
- **E2E** used ports 3000/4000 and the dev DB `procure`, with servers I started myself:
  - the API was the current branch build (it includes the lead's QA3-BUG-013 fix) from a scratch copy;
  - the web app was built from `c068240`, because the branch's web did not compile (Phase 4 WIP type errors);
  - Redis was a private instance on port 6391.

  The harness now supports this setup (all QA-owned):
  - `E2E_STACK_DIR`: global setup migrates and seeds from that build.
  - `E2E_REDIS_URL` / `REDIS_URL`.
  - Global setup now deletes every Redis key except BullMQ's `procure:*`. A FLUSHDB there used to remove the API's
    repeatable jobs, which are registered at boot, before global setup runs.
- **Performance** ran on a separate DB `procure_qa_load` with its own API on port 4391.

## What ran

| Suite | Command | Baseline (before QA) | After QA |
| --- | --- | --- | --- |
| Build | `pnpm build` | pass | pass on `c068240`. The branch web fails to compile (Phase 4 WIP, not Phase 3). |
| Typecheck | `pnpm typecheck`, `npx tsc -p e2e` | pass | pass |
| Lint | `pnpm lint` | pass | pass (QA files are lint-clean) |
| RLS lint | `pnpm lint:rls` | OK (36 app tables) | same |
| Formula | `pnpm --filter @procure/formula test` | 353 tests, 99.81 % statements / 98.2 % branches | unchanged |
| API (vitest), `c068240` + QA tests | `TEST_DB=procure_test_qa TEST_REDIS_DB=3 npx vitest run` | 37 files, 426 tests: 421 pass, **5 fail in `tenancy-isolation`** (Phase 4/6/7 tables from migrations 0011–0013 have no seed rows; not Phase 3) | **40 files, 467 tests.** The QA suites are as expected: 41 tests, 8 of them `it.fails` repros. The exception is the BUG-013 boot test: it is a plain `it` now that the bug is fixed on the branch, so it still fails on this pre-fix snapshot. The same 5 Phase 4+ tenancy-isolation failures remain and are excluded (their owners must extend `seedSide()`). |
| API, current branch `batch/phase-4-6-7` (includes the BUG-013 fix) | same | n/a | **66 files, 803 tests: 800 pass, 3 fail.** All 3 failures are outside Phase 3: `grn.chain`, `stock.docs`, `reports.exports` (Phase 4/5/7 WIP). All Phase 3 suites and all QA3 tests are as expected, the BUG-013 boot test included. `tenancy-isolation` passes on the branch. |
| E2E (Playwright, desktop + Pixel 7) | `pnpm e2e` with `E2E_STACK_DIR` | 26 tests: 25 pass, J1 fails (nav changed, as expected) | **49 tests: 44 pass and 5 are known-bug repros (`test.fail`)**. Final run results are in "E2E final run" below. |
| Performance | `load/phase-3/seed-documents.mjs` + `measure.mjs` | n/a | see below |

### Spec changes required by Phase 3 behaviour
- `e2e/j1-onboarding.spec.ts`: the Phase 1 `nav-m-<feature>` placeholders are gone. The test now asserts:
  - none of the placeholders remain;
  - Approvals is present;
  - document-type entries (`nav-docs-<key>`) come only from the plan's modules (Phase 4 provisions `indent` on the
    branch);
  - the plan-gated configuration entries are hidden (Document types needs `form_builder`, Workflows needs
    `workflow_designer`).
- `e2e/support/fixtures.ts` `Ui.nav`: waits for the link or the mobile menu, because document-type entries render
  after the shell.

## New tests

### API (`apps/api/test/`)
- **`qa-phase3-integrity.test.ts`** (25 tests, 3 `it.fails`). Real documents module, workflow engine and HTTP. After
  every race it checks this invariant on every line: requested = approved + rejected + cancelled + pendingApproval, and
  pendingApproval = Σ `wf_line_state` (pending + held).
  - **Concurrency:**
    - Two approvers decide the same pending qty at once, 5 rounds, with different splits → exactly one 200; the loser
      gets 409 `QTY_CHANGED`, `STAGE_NOT_ACTIVE` or `WORKFLOW_NOT_RUNNING`; one decide action; the ledger is not doubled.
    - The same race with the same `If-Match` → one 409 `VERSION_CONFLICT`.
    - **50 parallel submits on the Pune series** → `CPX-PUN/yy-yy/nnnn`, 50 consecutive numbers, no gaps, 50 instances.
    - The same draft submitted 5× in parallel → one number, one instance, requested written once.
    - Decide ∥ whole-document cancel (6 rounds) and decide ∥ line cancel (6 rounds) → serialised. The ledger is
      consistent either way and approved + cancelled = qty.
    - Two approvers unhold in parallel → one wins; one held event and one unheld event.
    - Send back to draft ∥ decide → the document ends in draft or approved, never both.
    - 5 parallel replays of one `Idempotency-Key` → all 200 with the same version and one action.
  - **Decimals:**
    - 0.3333 / 0.3333 / 0.3334 splits and 0.0001 decisions on 0.001 lines are exact.
    - A decision off by 0.0001 → 409.
    - A 5th decimal place → 400, nothing written.
    - Exponent, sign, comma, NaN and Infinity → 400.
    - A line qty with more decimals than the field stores → 400.
    - 99,999,999,999.999 flows through the ledger exactly.
    - Repros: overflow → 500 (BUG-002); UoM decimals ignored (BUG-003).
  - **Send-back loops:**
    - Finance ⇄ HOD five times, then approve → exactly one approved event per line, 5 send-back actions, buckets exact.
    - Send back to draft 3×: resubmit keeps the number, pendingApproval = the current qty, requested accumulates
      (append-only), 4 instances.
    - Send back to a skipped, later, unknown or same stage → 400.
    - A hold at a stage without `hold` → 403 `ACTION_NOT_ALLOWED`.
  - **Simulation vs real runs:**
    - The boundaries (₹1,00,000, ₹1,00,000.10, ₹4,99,999.50, ₹5,00,000) give the same route as real submissions when the
      total is supplied.
    - Repro BUG-009.
  - **Outbox:**
    - 6 concurrent relays with the real BullMQ queue: every business event is published once (`attempts = 1`) with
      job `outbox:<id>`; a second pass publishes nothing.
    - A rolled-back transaction (a failed submit, or a thrown tenantTx) leaves no event.
  - **Audit verifier:**
    - 5,200 rows across the 2,000-row batch boundary are verified in about 1 s.
    - A row changed in the middle (past the first batch) → `firstBadId` is that row; the check is recorded.
    - A deleted row → the chain is reported broken.
- **`qa-phase3-security.test.ts`** (14 tests, 5 `it.fails`).
  - **Cross-tenant:**
    - 27 Phase 3 routes with B's ids, a B-only document type key (`bonly`) and B's numbering series all return 404 and
      leak nothing. They cover:
      - document CRUD, submit, cancel, copy, actions, timeline, comments and attachments;
      - lists and counts;
      - doc-type update and deactivate;
      - workflow detail, versions, draft, publish and simulate;
      - numbering update and preview.
    - A's lists, inbox and audit exclude B, and B is unchanged.
    - B's line ids in A's decisions, B's users as forward or mention targets and B's files as attachments → 400/404/409,
      with nothing changed.
  - **Who can act:**
    - A stage-key holder outside the document's location → 404 on detail, timeline and actions, and absent from the
      inbox and list.
    - A submitter who holds the stage key → 403; the document is not in their inbox and `decide` is not in
      `allowedActions`.
    - Forged decisions (a line of another document, the same line twice, unhold of a foreign line, a type mismatch in
      the URL, `values` on a foreign line) → refused, with no change.
    - Repros: self-approval via escalation (BUG-004); idempotency replay by an unauthorised user (BUG-005).
  - **Field access** (`est_rate` hidden, `remarks` read-only):
    - Hidden in detail, lists, item view and `columns=`. `f.`/`sort=` on it → 400. Writing it → 403 `FIELD_READ_ONLY`.
    - Repros: the `q` oracle (BUG-006); timeline diffs (BUG-007); approver edits (BUG-008).
    - OBS-1 is pinned as a test.
  - **Forward:**
    - The target needs the type's view and the location in scope; the submitter is refused.
    - The forwardee decides, and `on_behalf_of` records the HOD.
  - **Publish validation:** `post_stock` / `block_stock` → `EFFECT_UNAVAILABLE`; a misplaced `route_to` →
    `BAD_ROUTE`; publish refused and the version unchanged.
- **`qa-phase3-sla.test.ts`** (2 tests):
  - A 0.01 h SLA through the real queue: the stage gets `due_at` = entered + 36 s and the first reminder at
    entered + 18 s.
  - The `workflow-sla` job is enqueued through BullMQ and run by the inline workers. It produces:
    - a reminder;
    - one escalation (a second run does not escalate again);
    - notifications with the document link;
    - timeline entries "Reminder sent at HOD approval" and "Escalated at HOD approval";
    - the inbox / `overdue=true` / counts flags, overdue in the detail and the list, and an `escalation` assignment;
    - outbox `workflow.sla_*` events.

    The escalation target (no stage key) can then decide.
  - Boot order like `main.ts` registers the repeatables. This is BUG-013, now **fixed**, so the test is a plain `it`.
- `tenancy-isolation.test.ts` was not extended. Its generated route list already covers the Phase 3 routes on a type
  that exists in both tenants (`isodoc`, `wfiso`). The B-only key and workflow-config cases are in
  `qa-phase3-security`.

### E2E (`e2e/`)

| Spec | What it proves | Result |
| --- | --- | --- |
| `j4-workflow.spec.ts` | **J4**:<ul><li>The indenter creates a 5-line Capex request in the UI. Line amounts and the header total are live (and change when a qty changes).</li><li>Submit gives `CPX-PUN/26-27/nnnn`. HOD is active; Finance and Director are skipped.</li><li>The approver opens it from the inbox (count = the API's), in **one action**: `a`, `j`, `a` on rows 1–2 (keyboard), hold row 3, reject row 4, and 200 of 300 on row 5. Submitting without reasons flags lines 3–5; the reasons are then filled in.</li><li>The restricted indenter can no longer see the on-hold document (views draft/rejected/waiting_hod).</li><li>Admin checks: all 25 qty bucket cells in the detail, line statuses, the item-wise qty cells, the timeline sentence "Approved 3 lines, held 1, rejected 2 at HOD approval" with the reduction reason, and an inbox row with 1 held line.</li><li>Unhold line 3 and approve it → partially approved; the inbox count goes down by 1.</li><li>The ledger (owner DB) shows requested/approved/held/rejected/cancelled per line exactly.</li></ul> | pass |
| `j5-routing.spec.ts` | Three requests: ₹50k → HOD only; ₹2L → HOD → Finance; ₹6L → HOD → Finance → Director. Stage states are checked at submit. Designer simulation (published source) shows the same outcome per stage and paints the canvas `data-sim`; the API simulate agrees (given the total). HOD approves in the UI. A Buyer-role user created for the test sees exactly the 2 Finance documents (count + rows), hold is disabled, and approves. The Director (admin) gives one outcome via "apply to all"; the workflow timeline is complete. | pass |
| `j6-designer.spec.ts` | Add "Plant head review":<ul><li>key auto-follows the name;</li><li>formula condition (a typo is flagged and blocks publish, then the fix is accepted);</li><li>Approver role;</li><li>12 h SLA, remind 4 h.</li></ul>Canvas shows the condition and SLA. Publish v2 generates the stage key and view. A v1 document stays on v1 (3 stages) while a new urgent document runs on v2 and reaches the new stage. Deleting Finance and publishing v3 while the v1 document waits there leaves the keys labelled "(retired)"; the Buyer still sees it in the inbox and approves it in the UI; the retired keys and grants then disappear. The seed definition is restored. | pass |
| `j6-…` `[QA3-BUG-010]` | The detail shows the workflow version. | expected fail |
| `j7-sendback-forward-sla.spec.ts` | **7a:** send back to the submitter (reason required) → the indenter's bell → the draft is editable; the timeline shows the sentence and reason; edit qty and resubmit → same number, pending = new qty.<br>**7b:** Finance sends back to HOD (the targets offered are `_draft` and `hod` only) → HOD re-approves from the inbox; timeline and reason; Finance approves.<br>**7c:** forward (the seeded HOD stage has no `forward` action, so a version with it is published) to a Pune colleague without the stage key → their inbox shows "Forwarded" → they approve → timeline "Forwarded to …".<br>**7d (BUG-013, fixed):** a 0.01 h SLA on the API's own 1-minute repeatable → escalation in the timeline.<br>**7e:** the same with the job scheduled every 5 s → overdue inbox switch, count and row; bell shows the reminder and "is overdue"; the admin's inbox has an `escalation` entry; timeline entries. | pass |
| `j7-…` `[QA3-BUG-011]` | After a send back to draft, the progress does not show the sending stage as done. | expected fail |
| `j8-permissions.spec.ts` | **8a:** the restricted indenter, with `est_rate` hidden on the Indent clerk role through the API:<ul><li>chips are exactly draft/rejected/waiting_hod;</li><li>an approved document is invisible (list, URL, API 404, `status=approved` → 403);</li><li>no approve button, act → 403;</li><li>no est_rate in the create form, list, item view, detail or API; writing it → 403.</li></ul>**8b:** a Chennai document is 404 for the Pune HOD (API and UI, absent from the inbox). A requester+HOD user cannot approve their own submission (403, not in the inbox, no approve button). | pass |
| `j9-collaboration.spec.ts` | The HOD comments with an @mention picked from the dropdown (a chip renders). The indenter's bell shows "mentioned you", which opens the document and the comment. Attachment through the API (the UI path is BUG-014) appears in the Attachments tab. The timeline shows the attachment, the comment, the workflow, submit and create entries, newest first. | pass |
| `j9-…` `[QA3-BUG-014]` | Attaching from the UI. | expected fail |
| `j10-doctype-scratch.spec.ts` | Wizard creates "Service Request …" (key auto, lines, pattern preview). The header field "Service window" (required) is added in the builder, but **publish goes through the API** because of BUG-015. A Pune numbering series is added through the numbering dialog. A 1-stage workflow is built in the designer and published. Keys are granted. A new requester raises one: the required custom field blocks submit, then `SRP/001`. The HOD approves from the inbox; the DB shows approved plus the custom value. | pass |
| `j10-…` `[QA3-BUG-015]` | The builder can publish `capex_header` with a new field. | expected fail |
| `j11-audit.spec.ts` | Audit filters:<ul><li>entity + entity id → create + update;</li><li>action → update;</li><li>the diff marks `values.purpose` as changed with before/after;</li><li>a future date range empties the list;</li><li>clear works.</li></ul>"Run check" is clean on the seeded DB. `e2e/support/tamper-copy.mjs` dumps the DB into `procure_qa_tamper`, tampers a row as the owner, and runs the real `AuditVerifier`: `before.ok`, then `after.firstBadId` = the tampered row with "changed after it was written". The copy is dropped. | pass |
| `a11y-phase3.spec.ts` | axe (WCAG 2.0/2.1 A+AA, serious + critical) on:<ul><li>the designer (stage panel, simulation drawer);</li><li>the document detail and timeline;</li><li>the approval screen with validation errors;</li><li>the inbox;</li><li>the list, excluding BUG-016's nodes (no other issues).</li></ul> | 4 pass |
| `a11y-…` `[QA3-BUG-016]` | Document-wise and item-wise lists. | expected fail |
| `mobile-phase3.spec.ts` (Pixel 7) | Inbox through the drawer, then the approval screen; no horizontal scroll; axe clean on both. Approve / hold with reason / reduce 8 → 6 with reason. Release the hold from the held panel and approve. Ledger and status are partially approved. | pass |

Support added: `e2e/support/phase3.ts` provides:
- seed sessions and ids;
- a Buyer user and users with roles;
- `apiCapex`;
- ledger reads;
- the Capex form filler and `pickItem`;
- `typeInto` (Playwright `fill()` appends on formatted currency inputs; keyboard users are fine);
- `scheduleSlaScan`.

`e2e/support/tamper-copy.mjs` and `E2E_STACK_DIR` support were also added.

### E2E final run
Full `pnpm e2e` with a fresh seed (soft reset + seed from the branch build): **49 tests, 49 as expected.** That is:
- 44 plain passes;
- 5 known-bug repros: `test.fail` for QA3-BUG-010, -011, -014, -015 and -016;
- 1 Phase 2 repro, QA2-BUG-008 in `j3`, which is still a known fail.

The suite takes 7.9 min. 23 of the tests are new for Phase 3 (desktop + Pixel 7).

## Performance (≈ 200k document lines, one tenant)

Seed: `load/phase-3/seed-documents.mjs 20000 10` inserts the data with SQL as the owner, in 86 s:
- 20,000 Capex documents × 10 lines, plus a 100-line document = **200,102 lines**;
- status mix 5 % draft, 30 % waiting HOD, 10 % waiting Finance, 5 % on hold, 35 % approved, 10 % partially
  approved, 5 % rejected, across 5 Pune/Chennai locations;
- workflow instances with stage and line state;
- `line_event` rows that sum exactly to `line_qty_summary`.

The script checks that summary = Σ events and pendingApproval = Σ `wf_line_state` (0 drift), then runs ANALYZE.

Measurement: `load/phase-3/measure.mjs 50`. For each scenario: 5 warm-up requests, then 50 sequential requests. Users
are the admin (all statuses) and the HOD (Pune scope). The client-side numbers below were taken at load average ≈ 13
on 2 cores, so they overstate a quiet server. I added the server-side execution time of the main statement from
`auto_explain` (log_analyze; `--explain` mode, plans in `load/results/phase-3/explain-*.txt`).

| Scenario | rows | p50 ms | **p95 ms** | main SQL (server) ms | |
| --- | --- | --- | --- | --- | --- |
| document-wise list, first page | 50 | 191 | **281** | 192 | ok (tight) |
| document-wise list, page 2 (cursor) | 50 | 194 | 348 | 151 | over under load |
| document-wise, status approved | 50 | 86 | 128 | 51 | ok |
| document-wise, `q` = number | 50 | 151 | 272 | 98 | ok |
| **item-wise, status waiting_hod** | 50 | 691 | **1,103** | **1,166** | **slow: QA3-BUG-017** |
| item-wise, status, page 2 | 50 | 943 | 1,195 | 982 | slow |
| item-wise, status (HOD, scoped) | 50 | 774 | 1,256 | 728 | slow |
| counts (admin) | 10 | 54 | 137 | 45 | ok |
| counts (HOD, scoped) | 7 | 40 | 118 | 41 | ok |
| inbox (HOD, 4,202 waiting docs in scope) | 50 | 316 | 493 | 267 | QA3-BUG-018 |
| inbox counts (HOD) | 1 | 306 | 471 | 208 | QA3-BUG-018 |
| detail of the 100-line document | 100 | 110 | 201 | ≤ 1 per statement | ok |
| timeline of the 100-line document | – | 34 | 68 | < 1 | ok |

Plans (`explain-flags.json` lists every Seq Scan on a big table):
- **Item-wise list:** the planner estimates 194 documents and 602 lines, but the real numbers are 20,003 and 60,102.
  It drives from a Seq Scan on `document` joined to the location, then a nested loop into `document_line` by
  document. It fetches all 60k matching lines with their `line_qty_summary` and master joins (≈ 330k buffer hits),
  then does a top-N sort. The `document_line_itemwise (tenant, type, status, created_at desc, id)` index, which could
  return the 51 rows directly, is never used.
- **Inbox:** collects every in-scope running instance (4,202) with its stage state, then sorts and limits. Seq Scan on
  `wf_instance`.
- **Document-wise first page:** Seq Scan on `document` (20k) plus a sort. It is within budget at this size but grows
  linearly.

## Bugs

| Id | Severity | Area | Summary | Repro | Status |
| --- | --- | --- | --- | --- | --- |
| QA3-BUG-001 | – | – | Withdrawn: 5-decimal decisions are correctly refused (400). Kept as a plain passing test. | – | – |
| QA3-BUG-002 | Medium | api | Qty/amount beyond `numeric(18,4)` → 500 "numeric field overflow" instead of a 400 on the field | plain test, integrity | **Fixed**: `DocumentsService.prepare` refuses qty/rate/amount/total_amount with more than 14 integer digits (400 on `lines.N.qty` / `lines.N.amount` / `total_amount`). |
| QA3-BUG-003 | Low | api | UoM `decimals` is ignored: 2.5 "Nos" can be requested, and an approver can approve 0.5 of a whole unit | plain test, integrity | **Fixed (polish round)**: a quantity has at most its unit's `decimals` (UoM master, 0–6; the ledger's 4 caps 4–6). Enforced server-side with a 400 `VALIDATION_FAILED` naming the unit, e.g. "Quantity 2.5 is not allowed: the unit \"NOS\" (Nos) takes whole numbers only.": line `qty` on save (`DocumentsService.prepare`, path `lines.N.qty`; covers GRN/issue/RTV/PO lines too), every entered ledger quantity (`DocStore.record`: decisions, holds, selections, receipts, accepted/rejected, issues, returns; computed remainders such as cancel/unhold/short-close are exempt so old data can still close), and stock opening / block quantities (item's unit). Test fixtures changed, not the rule: the shared `documents-helpers` unit now has 4 decimals (fractional, ledger precision); the whole-unit and 2-decimal cases have their own assertions; the Phase 5 block test uses 3-decimal quantities on its 3-decimal KG unit and asserts that a 4th decimal is a 400. |
| QA3-BUG-004 | Medium | api | Self-approval through SLA escalation: `escalateTo` (and `ifNoActor: assign_admins` with a lone admin) assigns the submitter, and an assignment bypasses `allowSelfApproval: false` | plain test, security | **Fixed (configurable)**: new tenant setting `workflow.block_self_approval` (default on). On: `EngineService.act` refuses the submitter on every path (rule or assignment) unless the stage has `allowSelfApproval`; escalation / no-actor assignments still assign them (the stage is never orphaned) and acting returns 403 "You submitted this document, so you cannot approve it. Forward it…"; the inbox and `canAct` hide it. Off: an assignment is a grant again (old behaviour). |
| QA3-BUG-005 | Low | api | `Idempotency-Key` replay is checked before stage authorisation: an in-scope user without the stage key gets 200 + DocumentRow by reusing an approver's key | plain test, security | **Fixed**: a replay is bound to the original actor; another user presenting the key gets 403. |
| QA3-BUG-006 | Medium | api | List search `q` (`custom::text ILIKE`) matches hidden fields and JSON key names, so hidden values can be guessed | plain test, security | **Fixed**: `q` matches only values (`jsonb_each_text`) of fields the caller may read (no key names, `__` keys, hidden or hidden-derived fields); `f.`/`sort=` on them → 400; `totalAmount` is null when `total_amount` is unreadable. |
| QA3-BUG-007 | **High** | api | Timeline "Edited" diffs include every header/line value without field access, so hidden values are disclosed to every viewer | plain test, security | **Fixed**: timeline diffs (and PO revision diffs) drop fields the viewer cannot read (`DocStore.hiddenFields`). |
| QA3-BUG-008 | **High** | api | Approver line edits (`editableLineFields`) go through `applyLineEdits` with `perms: null`, so read-only/hidden fields can be changed while deciding | plain test, security | **Fixed**: the engine passes the approver to `DocumentsPort.applyLineEdits` (new optional `actor` argument); hidden/read-only fields → 403 `FIELD_READ_ONLY`; the audit row names the approver. |
| QA3-BUG-009 | Low | api | `POST …/simulate` does not evaluate formulas (`total_amount`): sample lines alone route differently from a real document (the designer UI is fine) | plain test, integrity | **Fixed**: simulate computes the composed form's formulas from the sample (values the caller sends win). |
| QA3-BUG-010 | Low | web | The detail page never shows the workflow version a document runs on | plain test, j6 | **Fixed**: the progress strip ends with "Workflow version N". |
| QA3-BUG-011 | Low | api/web | Send back to draft (and cancel) marks active stages `done`: the draft's progress shows "HOD approval ✓ Done" although HOD sent it back | plain test, j7 + integrity | **Fixed**: stages still waiting go back to `pending` when the instance is sent back or cancelled. |
| QA3-BUG-012 | Low | web | The notifications panel stays open over the page after a notification navigates; the first click is swallowed | j7a/j9 (Escape workaround removed) | **Fixed**: the bell menu is controlled and closes when a notification navigates. |
| QA3-BUG-013 | **High → fixed** | api | `main.ts` started workers before module init, so no repeatable jobs ran in the API process (SLA scan, outbox relay, audit-verify). **Fixed by the lead** (init first, late repeats added immediately); verified by vitest and E2E J7d | plain tests now | Fixed (lead) |
| QA3-BUG-014 | **High** | web | Document attachments cannot be uploaded: the panel sends `fieldKey: 'attachments'` without `formKey` → 400 "formKey is required with fieldKey" | plain test, j9 | **Fixed**: `uploadFile` sends a field key only together with its form key (also fixes the create form's drop zone and the quote form). |
| QA3-BUG-015 | **High** | web | The form builder flags `total_amount = SUM(lines.amount)` on every doc-type header form as "Unknown field 'lines'" and disables Publish, so tenants cannot add header fields in the UI (the API accepts them) | plain test, j10 | **Fixed**: on `<type>_header` forms the builder checks formulas/conditions with the line form as the virtual `lines` grid (local issues and property editors). |
| QA3-BUG-016 | Medium | web | Document list sort headers are `<button aria-sort>` → axe critical `aria-allowed-attr` (document-wise and item-wise) | plain test, a11y-phase3 | **Fixed**: `aria-sort` moved to the sorted column's `role="columnheader"` cell (`DataTableColumn.ariaSort`). |
| QA3-BUG-017 | Medium | api (perf) | Item-wise list with a status filter: p95 ≈ 1.1 s (server ≈ 1.0–1.2 s) at 200k lines; the plan scans all matching lines (see Performance) | perf + `documents.list` paging test | **Fixed**: the default (created_at) page is read from `document_line_itemwise` / new `document_line_itemwise_all` (migration 0017) with the document/scope/search check per line, then summaries/masters for the page only. Main statement at 200k lines: 342 ms → < 1 ms (status filter) and 228 ms → < 1 ms (all statuses). |
| QA3-BUG-018 | Low | api (perf) | Inbox and inbox counts scale with in-scope waiting documents (4.2k → ≈ 210–270 ms server, p95 ≈ 470–490 ms under load); the document-wise first page is at 190 ms server | perf | **Fixed (inbox)**: the page walks active stages newest-first (new `wf_stage_state_active`, migration 0017) with a per-row "may I act" check, details for the page only (HOD page ≈ 105 ms → ≈ 4 ms server); counts are one rule set ∪ assignments without the de-dup/re-joins (≈ 105 → ≈ 60 ms). The document-wise first page is unchanged. |
| QA3-OBS-1 | Obs. | api | Hiding a formula input does not hide the formula (`amount`, `total_amount` reveal a hidden `est_rate`) | plain test, security | **Fixed**: formulas depending (transitively) on a hidden field are hidden on every read path (detail, lists, columns, search, sort, timeline). |

### Details (steps, expected, actual)
- **BUG-002.** POST `/docs/capex` with line `qty: "100000000000000"`, or `qty 10000000 × est_rate 100000000`.
  - Expected: 400 `VALIDATION_FAILED` on `lines.0.qty` / `amount`.
  - Actual: 500 `INTERNAL` (Postgres `numeric field overflow`).
- **BUG-003.** UoM "Nos" (decimals 0), an item on it, line qty 2.5 → 201. Approve 0.5 / reject 2.5 on qty 3 → 200.
  - Expected: 400 both times.
- **BUG-004.**
  1. The tenant admin submits a Capex request. Its HOD stage has a 24 h SLA that escalates to that admin.
  2. Run the SLA scan after the due time (`SlaService.run(now + 25 h)`).
  3. The admin decides at HOD.

  Expected 403 (self-approval off; forward already refuses the submitter). Actual: 200. The cause is the assignment
  fallback in `EngineService.act`. `activate()`'s assign_admins fallback has the same effect when the submitter is the
  only admin.
- **BUG-005.**
  1. The HOD approves with `Idempotency-Key: k`.
  2. The indenter (no stage key) POSTs a reject with the same key.

  Expected 403; actual 200 with the DocumentRow. Fix: authorise before the replay lookup, or bind the key to the actor.
- **BUG-006.** With `est_rate` hidden for the caller, `GET /docs/capex?view=item&q=4321.58` returns the line;
  `q=4321.59` returns nothing. `q=est_rate` matches every line (key names).
- **BUG-007.**
  1. The admin edits a draft (`est_rate` 4321.57 → 4321.58).
  2. A user for whom `est_rate` is hidden reads `/timeline`.

  The `changes` contain full line values including `est_rate`. Header hidden fields leak the same way.
- **BUG-008.** Stage `editableLineFields: ['est_rate', 'remarks']`. The approver's role has `remarks` read-only and
  `est_rate` hidden. A decide with `values: { remarks, est_rate }` → 200 and both are saved.
  - Expected: 403 `FIELD_READ_ONLY`.
- **BUG-009.** `simulate { values: {}, lines: [{ qty: 20, est_rate: 10000 }] }` → finance `skipped_condition`. A real
  document with that line → finance pending.
- **BUG-010.** Open any submitted document: no version text appears in the progress or info panel.
  `workflow.workflowVersion` is in the API.
- **BUG-011.** Send back to draft, then GET the document: `workflow.stages.hod.status = 'done'`, and the UI shows a tick.
  - Expected: a non-done state (e.g. pending / sent back).
- **BUG-012.**
  1. Click the bell.
  2. Click a notification → the page navigates, but the panel stays open.
  3. The next click on the page only closes it.
- **BUG-013** (fixed). See above. The vitest boot-order test and E2E J7d now pass on the branch.
- **BUG-014.** Detail → Attachments → choose a PNG → POST `/files` with `fieldKey=attachments` and no `formKey` → 400.
  Nothing can be attached (the create form's drop zone has the same issue). Fix: send no `fieldKey` for document
  attachments, or have the API accept it.
- **BUG-015.** Open `/config/forms/capex_header` (or a new type's header from the wizard). The issue panel shows "Total
  amount: Unknown field 'lines'" and Publish is disabled. The builder's local formula check needs the `lines` virtual
  grid (`combinedDefinition()`, already used by the designer).
- **BUG-016.** axe on `/docs/capex`: `aria-allowed-attr` (critical) on `button[aria-label="Sort by …"]`. Move
  `aria-sort` to the column header cell (`role="columnheader"`).
- **BUG-017 / 018.** See Performance. Suggested directions:
  - drive the item-wise query from `document_line_itemwise` with the location/scope filter as a semi-join (or
    denormalise the location path onto lines), and fetch summaries and masters only for the page's rows;
  - give the inbox a keyset on (stage `entered_at`, id) driven from `wf_stage_state` active rows.

### Observations (not filed as bugs)
- **OBS-1.** Hiding a formula input does not hide the formula: with `est_rate` hidden, `amount = qty × est_rate` and
  `total_amount` reveal it. Admins must hide `amount` too; the permission screen could warn about this.
- **OBS-2.** The contract and seed call the Director stage "document granularity", but granularity is workflow-level
  in the schema. The Capex workflow is `line`, so the Director sees line rows (one outcome works through "apply to all"
  or the API `outcome`). Either add per-stage granularity or reword the contract.
- **OBS-3.** The designer's SLA hours input has `min=1`, so sub-hour SLAs (allowed by the schema) need the API.
- **OBS-4.** Uploading a truncated PNG (`\x89PNG…` header only) → 500 `End-Of-Stream` from file-type sniffing
  (Phase 2 files area). It should be 400.
- **OBS-5.** The restricted indenter (seed views draft/rejected/waiting_hod) loses sight of their own request once it
  leaves HOD. This follows the brief's grants, but is worth a product decision (e.g. a "my submissions" view).
- **OBS-6.** Harness: Playwright `fill()` on formatted currency/decimal inputs appends to the raw value
  ("5000.0010000"). Real Tab / Shift+Tab / Ctrl+A editing works; specs use `typeInto`.

## What could not be verified
- The SLA reminder cadence over real hours (only the 0.01 h scale and a forced clock), and the nightly 02:30
  `audit-verify` firing on schedule. The job body was run directly and its registration checked.
- Concurrent outbox relays across two processes (`FOR UPDATE SKIP LOCKED` was exercised in-process with 6 parallel
  relays).
- Performance on a quiet machine: all timings were taken at load ≈ 13 on 2 cores. The server-side plan times are the
  reliable signal.
- The branch's web app (Phase 4 WIP does not compile): E2E ran the `c068240` web against the branch API.

## Fix round (Phase 3 bug-fix agent, 2026-10-23)

- Every bug above except QA3-BUG-003 is fixed. The fixes are listed in the bug table. Every `it.fails` / `test.fail` for a fixed bug is now a plain test with extra regression assertions. QA3-BUG-003 stays an `it.fails` (fixed later, see the polish round below).
- Migration `0017_docs_perf.sql` adds two indexes:
  - `document_line_itemwise_all` (tenant, type, created_at desc, id) where not deleted;
  - `wf_stage_state_active` (tenant, entered_at desc, instance, stage) where active.
- New tenant setting `workflow.block_self_approval` (default `true`).
- Port change: `DocumentsPort.applyLineEdits` gained an optional 5th argument `actor`. It is backward compatible.
- Runs on the fix slot (own DB, test DB, Redis and ports 4114/3114):
  - API vitest: 75 files, 920 passed and 16 skipped.
  - Phase 3 E2E (j4–j11, a11y-phase3, mobile-phase3): 23 passed.

## Polish round (2026-10-23)

- **QA3-BUG-003 fixed** (see the bug table); every Phase 3 bug is now fixed and no `it.fails` remains for it.
  - New `apps/api/src/modules/documents/uom.ts` (`uomRules`, `itemUomRules`, `fitsUom`, `uomMessage`, exported from the
    documents index), used by `DocumentsService.prepare`, `DocStore.record` and `StockCommandService.opening/block`.
  - Fixtures: `test/documents-helpers.ts` unit `decimals: '4'`; `test/qa-phase5-ledger.test.ts` block test on 3 decimals.
  - `[QA3-BUG-003]` in `qa-phase3-integrity.test.ts` is a plain test: a 0-decimal unit refuses qty 2.5 (path
    `lines.0.qty`) and an approval of 0.5 (nothing written), accepts whole decisions; a 2-decimal unit takes 1.25 and
    refuses 1.255.
- No migration for this item. Full API suite: see `phase-8-security-report.md` (polish round).

