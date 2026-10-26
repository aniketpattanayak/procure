# Phase 5 QA report — stock ledger, GRN chain, RTV, transfers, adjustments, counts, issue / return, re-order

Date: 2026-10-23. Environment: local sandbox (Node 22, Postgres 16, Redis on :6380, Chromium 141 headless). The
machine is shared with the Phase 3 bug fixer, the Phase 5 backend agent and the Phase 4/6/7 QA and reports agents; the
load average was 6–8 during the runs. Scope:
- `docs/contracts/phase-5-api.md`, ADR-0016, `packages/schema/src/stock.ts`;
- `apps/api/src/modules/{stock,inventory}/**`, `apps/web/src/features/stock/**`.

**Result: the stock ledger is correct and robust.** Balance = Σ movements held exactly under every race I tried:
- 80-operation mixed storms (receipts, issues, transfers both ways, block/unblock) on one item × node, WAC and FIFO;
- parallel API blocks;
- parallel opening loads;
- parallel transfer, GRN and issue approvals.

There were no deadlocks, no negatives and no lost or doubled postings. Value is conserved to the last 0.0001, and
idempotent replays post once. Cross-tenant isolation, permission keys, data scope and value hiding hold on every new
endpoint. The GRN chain works end to end, including tolerance at the exact boundary, gate rejections, and
QA reject → block → disposition → RTV → PO re-open.

**I filed 11 bugs: 0 high, 6 medium and 5 low.** I fixed 3 trivial isolated ones (002, 003, 005); the Phase 5 fixer fixed the other 8 (see "Fix round").
- The main functional issue is valuation: RTVs leave stock at the node average, or the oldest FIFO layers, instead
  of the receipt cost (QA5-BUG-001).
- **Performance misses the 500 ms target** for unfiltered balances, the ledger without an item filter, and valuation
  at 200k movements (QA5-BUG-006/007/008).

Item-filtered ledger, item summary, re-order and scoped balances are fast.

Every known bug has a reproducing `it.fails` / `test.fail` tagged with its id, or a plain test once fixed.

## How it was run
- Isolated environment: `export AGENT_REDIS_PORT=6380; source scripts/agent-env.sh qa5 2 4116 3116`, then `agent_db_reset`.
  - Dev DB is `procure_qa5`, test DB `procure_test_qa5`, Redis 6380 db 2/3, API :4116, web :3116 (`next dev --turbopack`).
  - Note: the `AGENT_REDIS_PORT=6380 source …` prefix form does not export the port to `agent_db_reset`; export it first.
- API tests ran from source with vitest. E2E ran with `E2E_NO_RESET=1 E2E_API_ORIGIN=http://localhost:4116 E2E_WEB_ORIGIN=http://localhost:3116`.
- During the run, the Phase 3 fixer's segregation-of-duties change (QA3-BUG-004) briefly broke `stock.docs.test.ts`, where the
  admin submitted and approved. A rebuild of `@procure/schema` in progress also gave transient 500s
  (`getTenantSetting … reading 'default'`). Both were gone at the final run; all QA store-document tests use a separate
  clerk (submitter) and admin (approver).
- Backend follow-ups were tested last, after re-pulling: FEFO, pendingReceipt incl. RTV, short-close / amend after
  receipt, `stock.cost_includes_tax`.

## What ran

| Suite | Command | Result |
| --- | --- | --- |
| Phase 5 API (existing + QA) | `npx vitest run test/stock test/grn test/issue test/ledger.test.ts test/qa-phase5` | **12 files, 163 passed, 16 skipped** (the opt-in perf suite). Includes 6 `it.fails` repros. |
| QA perf | `QA_PERF=1 npx vitest run test/qa-phase5-perf.test.ts` | 16/16 as expected: 7 within target, 8 `it.fails` (BUG-006/007/008), plus the seed integrity check |
| Typecheck / lint (QA files + fixes) | `npx tsc --noEmit`, `npx eslint test/qa-phase5-*.ts src/modules/stock/api/*.ts` | clean |
| E2E `phase5-stock.spec.ts` | Playwright, desktop | 2/2 pass. The first cold run timed out at login while the dev server compiled; it passes warm. |
| E2E `mobile-qa5-stock.spec.ts` (new) | Playwright, Pixel 7 | 1 pass + 1 expected fail (BUG-009) |
| Manual smoke | Playwright script, admin desktop 1366 px + phone 390 px, indenter desktop | 19 routes × 2 widths: no console or page errors, no API 4xx/5xx, no page-level horizontal scroll; indenter gets the "no access" page on /stock |

## New tests

### API (`apps/api/test/`)
- **`qa-phase5-helpers.ts`**: a full ledger integrity oracle, run as the DB owner. It checks:
  - every balance row's qty and value = Σ movements;
  - no movement without a balance row;
  - `item_avg_cost` = Σ per node;
  - no negatives;
  - every `pair_id` nets to 0 qty and 0 value;
  - optionally, Σ FIFO open layers = node qty.

  It also has clerk/approver helpers for store documents.
- **`qa-phase5-ledger.test.ts`** (28 tests, 3 `it.fails`).
  - **Concurrency:**
    - Mixed 80-operation storms (WAC and FIFO), including reversed-order transfer pairs as deadlock bait → only
      `STOCK_NEGATIVE` refusals, oracle clean, drift job clean.
    - 25 parallel `/stock/block` → exactly 10 × 200 and 15 × 409.
    - 8 parallel openings for one pair → 1 posted, 7 × 409 `STOCK_OPENING_EXISTS`.
    - 12 parallel transfer approvals store⇄bin → exact, value conserved.
  - **WAC:**
    - 0.333333 / 1.000001 / 99999.999999 costs, 0.0001 quantities, returns, transfers and blocks → exact conservation.
    - Each out is within 0.00005 of qty × avg.
    - Emptying a node leaves 0 value everywhere; `/stock/valuation` = 0.
  - **FIFO:** layers consumed oldest-first across receipts, an issue, a return and a transfer; the destination layer
    carries the averaged cost; values checked by hand.
  - **Block/unblock API:**
    - Pair ids are shared, value is carried and the node average is unchanged.
    - Over-unblock → 409.
    - Batch-level blocks; a batch-less block of batch stock → 409.
    - Bad bodies → 400.
  - **Opening rules:**
    - Refused once the pair moved (any batch); the whole load is atomic.
    - qty ≤ 0, negative cost, 5 decimals, `1e3`, a space, a wrong id, the same pair twice or an invalid date → 400.
    - A future date → 400 (BUG-002, fixed).
  - **Numbers:** oversized or invalid bodies and query strings → 400; overflows → 400 (BUG-003, fixed).
  - **Drift:**
    - Detects a tampered value, a tampered average qty, a movement inserted behind the ledger and a tampered FIFO
      layer, and notifies admins.
    - False positive after a WAC → FIFO switch (BUG-004).
  - **Idempotency:**
    - 3 parallel transfer approvals with one `Idempotency-Key` → posted once.
    - Re-running `post_stock` for the action → all duplicates.
    - `block_stock` (generic handler) run twice in parallel for one action → one pair.
  - **Re-order:**
    - 15 concurrent outs crossing the minimum → exactly 1 alert and 1 notification; the suggested qty goes up to max.
    - Yesterday's alert no longer throttles; an inactive rule stays silent.
    - Recipients are reorder holders in scope (not out-of-scope holders, not viewers).
    - Auto-indent drafts an indent line with the suggested qty.
    - 5 concurrent duplicate rule creates → 201 + 4 × 409.
  - **Counts:**
    - Batches with decimals; a rejected line posts nothing; found stock of an item with book 0 → `count_in`.
    - Empty node → 409; out-of-scope node → 404.
  - **RTV valuation** (BUG-001, WAC and FIFO).
- **`qa-phase5-security.test.ts`** (12 tests).
  - **403 per action key:** for 21 endpoints (stock + inventory), a user holding every key except that endpoint's own
    key gets 403, never 500. A user with no stock keys gets 403 everywhere, and so does the admin of a tenant without
    `store`/`grn`.
  - **Values:** null without `view_value` on balances, ledger, summary and the block response; a report asking for or
    filtering on `value` → 400.
  - **Status views:** the quarantine bucket is 0 in balances and summary and missing from the ledger;
    `status=quarantine` → 403; reports omit it; with no status view the pages are empty.
  - **Valuation:** respects status views (BUG-005, fixed).
  - **Data scope** (a user scoped to Main Store; its parent plant is out of scope):
    - Balances, ledger, summary, valuation, rules and below-min show the store subtree only; node filters on the plant
      → 404.
    - Block, opening, rule create/get/put/delete, moving a rule out of scope, and a count snapshot outside scope are
      refused.
    - A transfer *from* an out-of-scope node and an adjustment line *at* an out-of-scope node are refused.
  - **Cross-tenant** (tenant B using tenant A's ids):
    - Every stock endpoint with A's item, node, batch or rule ids → 4xx; A's rule survives B's PUT and DELETE.
    - Inventory lists filtered by A's PO, GRN, request or issue → empty.
    - `from-po`, `rtv/from-grn`, `issues/from-requests`, `returns/from-issues` with A's lines → 4xx.
    - GET or act on A's grn, rtv, issue_request, store_issue and store_return → 4xx.
    - Transfer to A's node, transfer of A's item, adjustment at A's node, direct issue of A's item, GRN with A's
      vendor/PO line → 4xx.
    - B's lists of all 8 new types do not contain any of A's ids.
    - A transfer whose `to_location` was forged in the DB to A's node is refused at approval, and no movement lands in A.
- **`qa-phase5-grn.test.ts`** (16 tests, 3 `it.fails`).
  - **Tolerance (5 %):**
    - Five partial GRNs (12.5 / 20 / 0.001 / 33.333 / 30), then pending 4.166 → max 4.3743; 4.375 → 400 and 4.374
      accepted.
    - The PO goes partially_received → received, then nothing is receivable.
  - **Two drafts** that each fit → the second submit is 409 `QTY_EXCEEDS_REMAINING`.
  - **Parallel submits:** 10 parallel GRN submits of 15 on a PO line of 100 → 6 succeed and received = 90.
  - **Parallel store approvals:** 8 in parallel → +40 exactly, oracle clean.
  - **Gate:**
    - A partial gate rejection → `rejected_at_receipt`; the PO is re-opened and only the approved part is posted.
    - A full gate rejection leaves the PO as before, with no movements.
  - **QA chain:**
    - 62.5 / 17.5 split; disposition → RTV.
    - 3 parallel RTV approvals with one `Idempotency-Key` → stock leaves once.
    - The PO is re-opened for 17.5 and re-received.
  - **Issues:**
    - Parallel issue approvals never go negative.
    - A store return comes back at the issue cost after the average moved.
  - **Follow-ups (re-pulled):**
    - FEFO takes the earliest expiry first, skips quarantined batches and spans batches.
    - pendingReceipt agrees across receivable lines and the PO document after a partial receipt, a gate rejection and
      an RTV.
    - Short-close after a partial receipt: nothing receivable, the open draft cannot be submitted, and an RTV does not
      re-open the PO.
    - Amend: no receipts while amending; the amended qty cannot go below the received qty.
    - `cost_includes_tax` gives 50 + 9 GST = 59 (50 when off).
    - Repros: BUG-001 (API path), BUG-010, BUG-011.
- **`qa-phase5-perf.test.ts`** (opt-in `QA_PERF=1`): see Performance.

### E2E (`e2e/`)

| Spec | What it proves | Result |
| --- | --- | --- |
| `phase5-stock.spec.ts` (existing) | Partial GRN through the chain raises stock; issue + partial return show in the ledger | pass |
| `mobile-qa5-stock.spec.ts` (new, Pixel 7) | 17 stock routes and Phase 5 document lists: h1 renders, no page horizontal scroll, no console/page errors, no API 5xx. axe (serious/critical) is clean on balances, ledger and count sheet | pass |
| `mobile-qa5-…` `[QA5-BUG-009]` | Count sheet "Counted" input visible at 390 px without sideways scrolling | expected fail |

## Performance (200,000 movements, one tenant: 250 items × 40 nodes, 10,000 balance rows, one year)
- **Seed:** the seed writes the movements in SQL; balances and average cost are derived from the ledger, and the
  integrity oracle passes on the seed.
- **Timing:** in-process request time, about the same as server time: 25 runs after a warm-up, admin, load
  average about 7.
- **Repeatability:** a second run gave the same picture (±20 %).

| Endpoint | rows | p50 ms | **p95 ms** | |
| --- | --- | --- | --- | --- |
| balances, first page | 50 | 2160 | **2617** | **QA5-BUG-006** |
| balances, node = plant subtree | 50 | 179 | 265 | ok |
| balances, `q` search | 50 | 156 | 241 | ok |
| balances, `belowMin` | 50 | 949 | **1375** | **QA5-BUG-006** |
| balances, page 21 (offset 1000) | 50 | 1310 | **1537** | **QA5-BUG-006** |
| ledger, no filter | 100 | 2282 | **2621** | **QA5-BUG-007** |
| ledger, item filter | 100 | 14 | 37 | ok |
| ledger, item + date range | 100 | 9 | 15 | ok |
| ledger, date range only | 100 | 1742 | **2229** | **QA5-BUG-007** |
| ledger, one node, no children | 100 | 72 | 117 | ok |
| item summary | 40 nodes | 10 | 22 | ok |
| valuation, all | 10,000 | 1439 | **1755** | **QA5-BUG-008** |
| valuation, `asOf` | 10,000 | 875 | **1119** | **QA5-BUG-008** |
| valuation, node | 5,000 | 696 | **757** | **QA5-BUG-008** |
| re-order (below min) | 50 | 7 | 13 | ok |

Root causes, from `EXPLAIN ANALYZE` as `app_user` under RLS:
- **Balances (BUG-006).** The UoM join is `u.id::text = i.data->>'uom'`. Under RLS the planner runs a nested loop with
  a seq scan of `master_record` for each of the 10,000 grouped rows (2.55M rows filtered): 2.86 s. The same query as
  owner, without RLS, takes 93 ms. The `node_names` and `subtree_available` subqueries are per page and fine.
  - Fix: resolve the UoM, node path and avg cost after `LIMIT` (page first, then decorate), or join on
    `u.id = nullif(i.data->>'uom','')::uuid` behind a uuid check.
- **Ledger (BUG-007).** The running balance is a window function over all of the tenant's movements, computed before
  the date and page filters. It sorts 200k rows (with an external merge to disk) and then nested-loops
  `master_record` for each row: 3.5 s.
  - Fix: page first by `(at, id)` using `stock_movement_at`, then compute `balanceAfter` only for the page's
    item × node × batch × status keys (balance at the page start + a window over the page). Alternatively, store
    `balance_after` on the movement, which the ledger already knows at post time.
- **Valuation (BUG-008).** Every call aggregates the whole movement table (≈ 0.55 s SQL) and returns all
  item × node rows **unpaginated**: 10,000 rows, a large JSON payload.
  - Fix: use `stock_balance` / `item_avg_cost` when `asOf` is absent, paginate, and serve historic `asOf` from
    balance minus movements after the date (or a monthly snapshot).

## Bugs

| Id | Severity | Area | Summary | Repro | Status |
| --- | --- | --- | --- | --- | --- |
| QA5-BUG-001 | Medium | api (valuation) | An `rtv` out is valued at the node average (WAC) or the oldest FIFO layers, not at the cost the returned goods came in at. The stock left behind is revalued by the difference. Example: Chennai 100 @ 10, receive 10 @ 100 and reject them all; the RTV leaves at 18.18, so 100 units are worth 1,818 instead of 1,000. Under FIFO the value can be stranded on a zero-qty quarantine row. | plain tests ×4 in ledger, ×1 in grn | **Fixed** (specific identification): the RTV post and the GRN's QA block/unblock carry `sourceMovementId` = the GRN line's receipt movement (`grn-stock.ts`). The ledger values them at that movement's unit cost — WAC: bounded by the node/row value, the last units take exactly what is left, the node average is re-derived; FIFO: that receipt's layer is consumed first (`stock-ledger.service.ts`). Other item/node or an in-side → 400. Row and node values stay = Σ movements (oracle clean). |
| QA5-BUG-002 | Low | api | `POST /stock/opening` accepts an `asOf` in the future. The movement is dated after "now", sorts after later movements in the running balance, and is excluded from today's valuation. | plain test (ledger) | **Fixed**: `asOf` > tenant today → 400 (`stock-command.service.ts`) |
| QA5-BUG-003 | Medium | api | Numbers that pass the schema regex overflow `numeric(18,4)` in Postgres and return a 500: re-order rule `minQty`/`reorderQty` with 15+ integer digits; opening qty × unitCost > 10^14. | plain tests (ledger) | **Fixed**: re-order rule quantities are limited to 14 integer digits and 4 decimals; opening qty × cost is checked against the numeric(18,4) maximum (400). Residual (not reachable in practice): a balance summed past 10^14 by many posts. |
| QA5-BUG-004 | Low | api (job) | Drift false positive: after a legitimate WAC → FIFO switch at a year boundary, carried-over stock has no layers. The nightly job reports every such item × node as `fifo` drift (and notifies admins) until the legacy stock is consumed. | plain tests ×2 (ledger) | **Fixed**: the FIFO layer check runs only while FIFO is the method in force, and accepts open layers in [node qty − carried-over qty still unconsumed, node qty] (carried-over = stock before the node's first layer less non-rtv outs since; `drift-check.ts`). Tampered layers above or below that band are still reported. |
| QA5-BUG-005 | Low | api (security) | `/stock/valuation` summed every status regardless of `stock:view.<status>`, so a user barred from quarantine saw its value. Balances, summary and reports hide it. | plain test (security) | **Fixed**: valuation filters on the held statuses (`stock-query.service.ts`) |
| QA5-BUG-006 | Medium | api (perf) | `/stock/balances` without a node or item filter: p95 2.6 s at 10k balance rows; `belowMin` 1.4 s; deep pages 1.5 s. RLS + text UoM join (see Performance). | perf tests (opt-in) | **Fixed**: group → page → decorate (materialized CTEs); UoM joined by uuid on the page only; `belowMin` resolved from the active rules first. p95 53 / 17 / 64 ms. |
| QA5-BUG-007 | Medium | api (perf) | `/stock/ledger` without an item filter (incl. date range only): p95 2.2–2.6 s at 200k movements. The running-balance window spans the whole tenant before paging. | perf tests (opt-in) | **Fixed**: keyset page first; `balanceAfter` per page row = balance row qty − later movements of the same key (index range). Running balance kept for every row. p95 11 / 63 ms. |
| QA5-BUG-008 | Medium | api (perf) | `/stock/valuation`: p95 0.76–1.76 s, aggregated from all movements on every call, and unpaginated (10,000 rows). | perf tests (opt-in) | **Fixed**: read from `stock_balance`; `asOf` = Σ movements before (when that is the smaller side) or balance − Σ movements after, aggregated before joining; paged (`limit` 1–5000, default 1000, offset `cursor`, `nextCursor`, `totalRows`; `totalValue` over all pages). p95 63 / 184 / 57 ms. |
| QA5-BUG-009 | Low | web (mobile) | On a 390 px phone the count sheet's "Counted" input sits off-screen inside the table scroller, and item codes are truncated with no name. The ledger's qty and balance columns are likewise hidden behind sideways scroll. Counting on a phone is a primary store use. Pixel 7 (412 px) just fits. | plain test (mobile-qa5-stock) | **Fixed** (count sheet): below `md` each line is a stacked card (same DOM, CSS only) with item, location/batch, book, Counted input, difference and remarks; table from `md` up. The ledger columns are unchanged (still in the scroller). |
| QA5-BUG-010 | Medium | api | FEFO allocation (batch-less issue) includes batches whose expiry date has passed, and issues them first. | plain tests ×2 (grn) | **Fixed**: FEFO and the submit-time availability check skip batches with `expiry_date` < the tenant's today; naming an expired batch → 409 `STOCK_BATCH_EXPIRED` at submit and again at approval, unless the new setting `stock.allow_expired_issue` (default false) (`issue-hooks.ts`, `issue-stock.ts`, `packages/schema` settings). |
| QA5-BUG-011 | Low | api | Item summary `openPoQty` uses `approved − short_closed − received + rejected_at_receipt`. It ignores `returned` when `rtv.reopens_po` is on, so after an RTV it disagrees with `receivable-po-lines` and the PO document (20 vs 28). | plain test (grn) | **Fixed**: computed with the shared `pendingReceipt` helper (`documents/qty.ts`) and `rtv.reopens_po` (`stock-query.service.ts`). |

### Details

**QA5-BUG-001: steps** (`qa-phase5-grn.test.ts`):
1. Opening of 100 @ 10 at Chennai for item 2.
2. PO for 10 @ 100; GRN at Chennai through gate and store.
3. Quality rejects all 10; disposition rejects.
4. Draft RTV; submit and approve.
- Expected: the RTV movement has unit cost 100 (the GRN line rate), and Chennai holds 100 units worth 1,000.
- Actual: unit cost 18.181818, and Chennai holds 100 units worth 1,818.18.

  The block in between moves value proportionally (`statusMoveValue`), so the quarantine row holds the average too.

**QA5-BUG-010: steps.** Opening at Pune Store has batch `X-EXPIRED` (expiry 2025-01-01, qty 5) and `X-GOOD` (2030, qty 5).
A direct store issue of 2 without a batch is approved.
- Expected: 2 are taken from `X-GOOD`.
- Actual: 2 are taken from `X-EXPIRED`. `fefoBalances` orders by expiry and has no `expiry_date >= today` filter.

## Fix round (Phase 5 fixer, 2026-10-23)
All 11 bugs are fixed; every `it.fails` / `test.fail` is now a plain test. Run on `export AGENT_REDIS_PORT=6380; source scripts/agent-env.sh fix5 5 4119 3119`.
- **Migrations:** none needed — the existing `stock_movement_at`, `stock_movement_item`, `stock_balance` primary key and
  `item_avg_cost` primary key carry the rewritten queries.
- **New setting:** `stock.allow_expired_issue` (boolean, default false).
- **Ledger:** `StockLedger.post` accepts `LedgerPost` (= `StockPost` + optional `sourceMovementId`, ledger-internal, not in
  `@procure/schema`). Handlers may return it.
- **New tests:** RTV valuation (WAC exact / bounded, FIFO own layer, bad source → 400), drift after a method switch
  (carried-over stock, partial / full consumption, tampered layers still caught, WAC year ignores old layers), FEFO
  expiry (named expired batch 409, batch-less cannot reach expired stock, setting allows it), and a read-side oracle:
  ledger `balanceAfter` on every page (no filter, item, node, movement type) equals the old whole-tenant window;
  balances = Σ movements; valuation now / asOf (both strategies) / paged = Σ movements and `totalValue` over all pages.

### Performance before / after (same machine, same 200k seed, `QA_PERF=1`, 25 runs, p95 ms)
"Before" is a fresh run of the unchanged queries on this machine (load ≈ 6–8; numbers differ from the QA table above).

| Endpoint | rows (after) | before p95 | **after p95** |
| --- | --- | --- | --- |
| balances, first page | 50 | 1136 | **53** |
| balances, node = plant subtree | 50 | 1114 | **63** |
| balances, `q` search | 50 | 447 | **264** |
| balances, `belowMin` | 50 | 619 | **17** |
| balances, page 21 (offset 1000) | 50 | 666 | **64** |
| ledger, no filter | 100 | 1612 | **11** |
| ledger, item filter | 100 | 32 | **10** |
| ledger, item + date range | 100 | 15 | **10** |
| ledger, date range only | 100 | 1637 | **63** |
| ledger, one node, no children | 100 | 80 | **13** |
| item summary | 40 nodes | 14 | **8** |
| valuation, all | 1,000 (page; was 10,000) | 1221 | **63** |
| valuation, `asOf` | 1,000 (page) | 944 | **184** |
| valuation, node | 1,000 (page; was 5,000) | 792 | **57** |
| re-order (below min) | 50 | 12 | **9** |

16/16 perf tests pass (all 15 endpoints p95 < 500 ms, seed integrity).

## Observations (not filed)
- **Zero-qty rows with value.** WAC is per node across statuses and batches. A partial issue from `available` while
  `quarantine` holds stock received at another cost can leave a zero-qty available row with value (example: −15).
  The node total is right, and the row is hidden in balances and reports (`qty <> 0`). The test pins the current
  behaviour.
- **Count sheet book qty.** It is frozen at the snapshot (document `created_at`). Movements between snapshot and
  approval are not reflected, so a count taken later posts a difference against a stale book. This is standard if
  the store freezes during counts; consider warning on approval when the item moved after the snapshot.
- **Re-order throttle timezone.** The throttle day is `current_date` in the DB session (UTC), not the tenant
  timezone. Around midnight IST, two alerts can land within an hour.
- **Item summary visibility.** `openPoQty` and `pendingIssueQty` in the item summary are visible to any `stock:action.view` holder,
  even without PO or issue-request view keys. This is low sensitivity.
- **PO status view grants.** `doc.po:view.partially_received` / `received` are copied only to grants that existed at
  provisioning. A buyer role created later loses sight of its POs after the first GRN until those views are
  granted. The role editor lists them.
- **Exposed `rate` field.** `stock_adjustment` lines expose `rate` (a value) in the document regardless of
  `stock:action.view_value`. This is document field access, configurable per tenant.

## Verdict
**Pass with conditions.** Ledger integrity, concurrency, idempotency, isolation, permissions and scope are solid,
and the GRN / RTV / issue flows are correct in quantity. Before go-live:
- fix **QA5-BUG-001** (RTV valuation) if stock value feeds accounting;
- fix **QA5-BUG-010** (expired batches issued);
- fix **QA5-BUG-006/007/008** for tenants with large ledgers. Item-filtered and scoped reads are already fast.

The low-severity bugs can follow.

**Update after the fix round:** all of the above, and the low-severity bugs, are fixed (see "Fix round"); the perf target is met at 200k movements.
