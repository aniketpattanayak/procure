# Phase 5 API contract (FROZEN) — GRN, verification chain, stock ledger, store issue and return

Types: `packages/schema/src/stock.ts` (+ documents.ts, workflow.ts, procurement.ts). Migration `0015_stock.sql`.
ADR-0016. Built on the Phase 3 documents core + workflow engine (all transactions are system doc types) and the
Phase 4 PO (receipts are against PO lines). No tenant-specific code: which workflow stage posts or blocks stock is a
workflow effect chosen by the tenant.

## Stock ledger (stock agent) — `modules/stock`
`StockLedger.post(tx, posts: StockPost[], actorId)` is the ONLY way stock changes. In one transaction: lock the
affected `stock_balance` rows in key order (`SELECT … FOR UPDATE`, insert-on-conflict first), compute valuation for
outs (WAC: `item_avg_cost` of the node; FIFO: consume `valuation_layer` oldest-first; setting `stock.valuation`,
fixed per financial year — changing it mid-FY → 409), insert `stock_movement`, update balances, update WAC/FIFO
layers on ins, reject negative balances unless `stock.allow_negative`, idempotency via `idempotency_key`, outbox
`stock.moved`, re-order check after outs (`stock.below_min` event + in-app alert to `stock:action.reorder` holders,
throttled per rule per day; `auto_indent` drafts an indent line via the documents service).
Block/unblock/reject = paired movements (out of one status, into another) with `pair_id`. Transfers = paired
`transfer_out`/`transfer_in` with value carried at source cost.

Workflow effects registered (Phase 3 effect registry): `post_stock` (for the document's lines: GRN → receipt of
accepted qty into `stockStatus` (default available) at each line's receiving node, rate = PO line rate incl. tax
per setting `stock.cost_includes_tax` (default false); issue → issue; return → return; transfer → paired;
adjustment → adjustment in/out; count → count in/out for differences), `block_stock` (move qty of the decided lines
from available to quarantine — on GRN reject decisions uses the rejected qty), `unblock_stock`, `return_to_vendor`
(creates a draft `rtv` document for rejected/quarantined qty of the GRN lines). Effects are idempotent per
(wfActionId, effect index) using movement idempotency keys.

Endpoints (`stock:*` keys; data scope on node):
| Method | Path | Body / Query | Response |
| --- | --- | --- | --- |
| GET | `/stock/balances` | `StockQuery` | `Page<StockBalanceRow>` (by item × node [× batch]) |
| GET | `/stock/ledger` | `LedgerQuery` | `Page<StockLedgerRow>` (running balance per item×node in the page) |
| GET | `/stock/items/:itemId/summary` | – | per node available/quarantine/rejected, value, avg cost, open PO qty, pending issue qty |
| POST | `/stock/opening` | `OpeningBalanceInput` | `{ posted }` (`stock:action.opening`; only for item×node pairs with no movements yet) |
| POST | `/stock/block` | `BlockInput` | movement rows (`stock:action.block`) |
| GET/POST/PUT/DELETE | `/stock/reorder-rules[/:id]` | `ReorderRuleInput` | rules (`stock:action.reorder`) |
| GET | `/stock/reorder` | `?node=` | items below min with suggested qty |
| GET | `/stock/valuation` | `?node=&asOf=&cursor=&limit=` | value by item/node (needs `view_value`); paged (limit 1–5000, default 1000; offset `cursor`), `{ asOf, rows, totalValue, totalRows, nextCursor }` — `totalValue` covers all pages (QA5-BUG-008) |

Values are hidden (null) without `stock:action.view_value`. Nightly job recomputes balances from the ledger for a
sample and alerts on drift (same pattern as the quantity ledger).

Phase 5 fixes: an `rtv` out (and the GRN's QA block/unblock) names the GRN line's receipt movement
(`LedgerPost.sourceMovementId`, ledger-internal) and leaves at that movement's unit cost — specific identification
(WAC: bounded by the node value; FIFO: that receipt's layer first) (QA5-BUG-001). Batch-less store issues (FEFO) skip
batches whose `expiry_date` is before the tenant's today; naming an expired batch is 409 `STOCK_BATCH_EXPIRED` unless
`stock.allow_expired_issue` (default false) (QA5-BUG-010).

## Store documents (stock agent) — system types, installed by `StockInstaller` (pattern of `ProcurementInstaller`)
| Type | Feature | Notes |
| --- | --- | --- |
| `stock_transfer` | store | header from/to node (`location` = from, `to_location`); lines item, qty, batch; default workflow `approve` with `post_stock` on approve (paired) |
| `stock_adjustment` | store | lines item, node, batch, `direction` (in/out), qty, rate (in), reason; workflow `approve` → `post_stock` |
| `stock_count` | store | `POST /stock/counts/snapshot` creates a draft with book qty per item×batch at the node; counters enter counted qty; approval → `post_stock` differences as count_in/count_out |

## GRN and RTV (GRN agent) — `modules/inventory/grn/**`
- System types `grn` (feature `grn`) and `rtv` (return to vendor / debit note). Default GRN workflow (tenant-editable,
  published on provisioning) = the brief's chain: `gate` "Gate entry check" (approve/hold/reject/send_back; no
  stock effect) → `store` "Store verification" (`onApprove: post_stock` available) → `quality` "Quality check"
  (optional by `when` on item category data field `requires_qc`, `onReject: [block_stock, route_to: disposition]`)
  → `disposition` "Store disposition" (enabled; actions approve = keep blocked for rework, reject =
  `return_to_vendor`). Line granularity everywhere.
- `GET /inventory/receivable-po-lines` (`?vendor=&po=&item=&location=&q=`) → `Page<ReceivablePoLine>` (approved PO
  lines with pending receipt, scope by PO location); `POST /inventory/grn/from-po` (`GrnFromPo`) → GRN draft (one GRN
  per PO, or per vendor if lines span POs of the same vendor and setting `grn.multi_po` — default false).
- Ledger: GRN submit → `received` on PO lines (and `received` on their indent lines) under locks; quantity check:
  received ≤ (ordered − received so far) × (1 + `grn.over_receipt_pct`/100) else 409; accepted/rejected split
  recorded (`accepted`, `rejected_at_receipt`). A GRN line rejected by the workflow BEFORE `post_stock` ran (e.g.
  at gate) writes `rejected_at_receipt` for that qty (goods sent back at the gate; never enters stock) and re-opens
  the PO line's pending receipt. PO status moves to `partially_received` / `received` via recomputeStatus rules for
  `po` (status keys added: `partially_received`, `received`).
- RTV: lines reference GRN lines + qty + reason; approval → `rtv` stock movement out of quarantine/rejected (or
  available if returned after acceptance) and `returned` ledger event on the PO line (re-opens pending receipt when
  setting `rtv.reopens_po` = true, default true). Debit note PDF via Phase 6 starter template `rtv_debit_note`.
- `GET /inventory/returnable-grn-lines` (`?vendor=&grn=&item=&q=&cursor=&limit≤500`; `doc.rtv:action.add`) →
  `Page<ReturnableGrnLine>` (GRN lines with `returnable` = accepted − returned − qty in open RTVs > 0, scope by GRN
  location); `POST /inventory/rtv/from-grn` (`RtvFromGrn` `{ lines: [{ grnLineId, qty, fromStatus?, reason? }],
  values?, submit? }`; `doc.rtv:action.add` + `…submit` when `submit`) → one draft (or submitted) RTV per vendor;
  quantities re-checked under row locks (409 `QTY_EXCEEDS_REMAINING`).
- Plan with `grn` but **without `store`**: GRN and RTV are still installed, with a stock-less default workflow (the
  chain above without `post_stock` / `block_stock`, so no `disposition` stage; RTV approval moves no stock). Receipts
  are still tracked on the PO (`received` at submit, `rejected_at_receipt` for every rejection — nothing enters
  stock). When `store` is added later, an untouched stock-less workflow (version 1) is upgraded to the full chain by
  the installer; an edited one is left to the tenant admin.
- Receipts against the same PO line across multiple GRNs; partial everything; batch/expiry per line (creates
  `stock_batch`); photos; invoice details.

## Issue and return (GRN agent) — `modules/inventory/issue/**`
- System types `issue_request` (requisition: department, location, lines item + qty + required date + purpose;
  workflow `approve`), `store_issue` (lines: item, qty, batch, issue location; source request line or direct when
  `flow.issue.without_indent`), `store_return` (lines reference issue lines; qty ≤ issued − returned; return status
  available/quarantine). Each has its own default workflow; `post_stock` on approve.
- `GET /inventory/issuable-lines` → `Page<IssuableLine>` (approved request lines with pending issue + available
  stock at the issuing node); `POST /inventory/issues/from-requests`; `GET /inventory/returnable-lines` →
  `Page<ReturnableLine>`; `POST /inventory/returns/from-issues` (`ReturnFromIssues` `{ lines: [{ issueLineId, qty,
  status?: available|quarantine, location?, reason?, values? }], values?, submit? }`; `doc.store_return:action.add`) →
  store return draft (or submitted); ledger events `issued` on request lines and `returned` on issue lines; partial
  and multiple issues/returns.
- Consumption reporting by location/department uses issue lines (reports source registered).

## Reports sources (registered with the reports catalogue)
`engine:stock_balance`, `engine:stock_ledger` (by the stock agent), `engine:receipts` (GRN lines with PO/vendor/
on-time flags) by the GRN agent.

## Seed
acme: feature overrides `grn`, `store` on; opening balances for the 5 items at Main Store; re-order rules for 2
items; GRN chain demo: two partial GRNs against the approved PO (gate → store posts stock → quality rejects 50 kg →
blocked → disposition returns to vendor via RTV); an issue request + partial issue + partial return; one transfer
Main Store → Bin A1.
