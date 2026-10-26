# Phase 1 QA report

Date: 2026-10-22. Environment: local sandbox (Node 22.22, Postgres 16 on :5432, Redis 7 on :6379, Chromium 141 headless).
Scope: Phase 1 (Foundation): tenancy/RLS, auth, platform console, tenant identity, against `docs/contracts/phase-1-api.md`.

**Result: Phase 1 works end to end. No cross-tenant leak was found at the DB or API level. 7 bugs are filed (0 critical,
2 high, 3 medium, 2 low). Each one has a reproducing test marked as expected-to-fail, so it will start "unexpectedly
passing" once it is fixed. Remove the `it.fails` / `test.fail` marker at that point.**

## What was run

| Suite | Command | Result |
| --- | --- | --- |
| API integration (vitest, real DB `procure_test`) | `cd apps/api && pnpm test` | **7 files, 68 tests, all green.** 64 are plain passes; 4 are known-bug repros marked `it.fails` (QA-BUG-001, -002 ×2, -003). Ran 3× for stability; the race repros reproduced 8/8. |
| E2E (Playwright 1.64.1, Chromium 141) | `pnpm e2e` | **11 tests, 11 as expected, 0 unexpected, 0 flaky.** 7 journeys pass; 4 known-bug repros marked `test.fail` (QA-BUG-004..007). Run both with Playwright starting the stack and with reused running servers. |
| RLS lint | `pnpm lint:rls` | OK (7 app tables, 0 allow-listed) |
| Lint / typecheck | `pnpm lint`, `pnpm typecheck`, `tsc -p e2e` | clean |

Baseline before QA work: 37 API tests, all passing. 31 new API tests were added.

### New API suites

- **`apps/api/test/tenancy-isolation.test.ts`** (19 tests, generated). It discovers every `app.*` base table from
  `information_schema` at runtime, so tables added later are covered without editing the suite. It seeds tenants A and B
  through the API (admin, user, role, user_role, notifications, sessions, audit rows) and inserts as the DB owner where
  Phase 1 has no route (`tenant_setting`, `permission_grant`). A guard test fails if a future table has no seed rows,
  because a table with no rows can't prove isolation.
  - DB level, connected as `app_user`:
    - Every table has `tenant_id`, RLS enabled and forced, and a `tenant_isolation` policy.
    - Context A sees its own rows and 0 of B's, including `where tenant_id = B`.
    - No context, or an empty-string context, returns 0 rows.
    - INSERT with B's tenant_id fails with 42501. A control insert with A's tenant_id succeeds, which proves the failure comes from RLS.
    - UPDATE that moves rows to B fails. UPDATE/DELETE aimed at B's rows touch 0 rows.
    - Every `platform.*` relation is unreadable (42501).
    - `platform.effective_*` cannot be called.
    - `app.my_limit/my_features/my_tenant_state/consume_quota` only answer for the tenant in context.
  - API level: tenant A's admin, both directly and while impersonated, calls every tenant by-id route with B's ids:
    - `GET/PUT /users/:id`, `deactivate`, `activate`, `reset-password`, `unlock`, `sessions`, `force-logout`
    - B's admin id
    - `POST /notifications/:id/read`
    - `DELETE /auth/sessions/:id`

    All return **404 NOT_FOUND** with no B data, and a before/after snapshot shows B unchanged. Also checked:
    - B's role or user can't be used as a reference from A (400).
    - A's lists never contain B's records.
    - A tenant token gets 403 on `/platform/*` with no data.
- **`apps/api/test/concurrency.test.ts`** (11 tests):
  - Refresh reuse race, 2 and 8 parallel refreshes with the same token: at most one 200, the rest `AUTH.REFRESH_REUSED`. Afterwards the whole family is revoked, including the winner's new refresh token and every access token. Other sign-ins are unaffected. Same result for platform sessions.
  - 10 parallel activates with 2 free slots: exactly 2 succeed.
  - 0 free slots: all refused.
  - Mixed creates and activates racing for 3 slots: exactly 3 succeed.
  - Parallel PUTs with the same `version`: one 200, one `VERSION_CONFLICT`.
  - Known-bug repros: QA-BUG-002 (×2) and QA-BUG-003.
- **`apps/api/test/concurrency.resilience.test.ts`** (1 test): QA-BUG-001 repro. It runs the built API as a child process and kills its idle DB connections. The test is skipped if `dist/` is missing.

### E2E (`e2e/`)

Config: `e2e/playwright.config.ts`. Projects: `desktop-chromium` and `mobile-pixel7`.
- **Browser.** `@playwright/test` 1.64.1 expects chromium-1248. The machine has chromium-1194, so the config sets `launchOptions.executablePath` to the preinstalled Chromium. You can override this with `PW_CHROMIUM_PATH`. Nothing is downloaded.
- **Starting the stack.** `webServer` starts the API (`node --env-file=../../.env dist/main.js`) and web (`next start`), or reuses servers already running on :4000/:3000. `E2E_BUILD=1` builds both first.
- **Deterministic data, two paths.** Playwright starts `webServer` before `globalSetup`, and dropping the DB under a running API crashes it (QA-BUG-001).
  - When Playwright starts the API, the API command runs `pnpm db:reset && pnpm db:seed` before booting.
  - When servers are reused (for example in CI), global setup truncates every `app.*`/`platform.*` table except the catalogs and then runs `pnpm db:seed`. The end state is the same.
  - In both cases Redis is flushed.
- **Rate limits.** Each test starts with fresh rate-limit counters. QA-BUG-006 explains why; `rate-limit.spec.ts` opts out of the reset.
- **Accessibility.** Axe checks use `@axe-core/playwright` 4.11.0, which was installable offline from the pnpm store. They cover WCAG 2.0/2.1 A+AA and count serious and critical violations only.

| Journey | Spec | Result |
| --- | --- | --- |
| **J1** Super Admin login → create plan (indent+grn, max_users 5) → tenant wizard (temp password captured from `temp-password`) → `max_users` override 8 with a reason → history shows it, and the API agrees (plan 5 / override 8 / effective 8) → tenant admin logs in with the temp password → forced to `/change-password` (and `/users` bounces back there) → `/dashboard` → sidebar has `nav-m-indent` and `nav-m-grn` and none of the other 4 modules; the old temp password is rejected | `j1-onboarding.spec.ts` | pass |
| **J9a** Tenant at 2/3 users (plan 10, override 3). Create #3 succeeds. Create #4 shows `user-limit-error`, and its text equals the server's problem `title` exactly. Usage shows `limit-max_users` with `data-level=full` and meter 3/3. The bell shows "1 unread" and the panel has "You have reached your plan limit of 3 active users"; the API returns an unread `limit_warning` with threshold 100 | `j9a-user-limit.spec.ts` | pass (the bell needs a reload, see QA-BUG-005) |
| **Impersonation** "Login as tenant" on seed tenant globex. The reason is required. The banner shows the tenant name and the Super Admin's name, and survives a reload. A user is created while impersonating. The tenant `app.audit_log` row has `impersonated_by` = the Super Admin with `actor_id` = the tenant admin, read through the DB because Phase 1 has no tenant-audit API. `impersonate_start` with the reason is in `GET /platform/audit`. Exit returns to the platform console and the platform session is intact | `impersonation.spec.ts` | pass (lands on the list, not the detail page, see QA-BUG-007) |
| **Lockout** 4 wrong passwords show "incorrect". The 5th shows "locked until HH:MM (about 15 min)", and the time matches the server's `meta.lockedUntil`. The right password while locked is still refused | `lockout.spec.ts` | pass |
| **Mobile (Pixel 7)** Login form fits; the sidebar is hidden and the `nav-open` drawer leads to Users; the users list renders, search filters it, and there is no horizontal scroll; the create-user dialog fits the viewport, creates a user and shows the temp password; touch targets are at least 24px | `mobile.spec.ts` | pass |
| **Axe (serious + critical = 0)** tenant login and platform login (`lockout.spec.ts`), users list on desktop (J9a) and mobile (`mobile.spec.ts`), tenant detail with entitlements and override history (J1), platform audit (impersonation) | various | pass. No serious or critical violations found |

Reports: `playwright-report/` (HTML) and `test-results/e2e-results.json`. Traces and screenshots are kept for failures.

### `packages/test-kit`

`@procure/test-kit` is a dependency-free fixture builder that wraps the public API:
- `plan`, `tenant`, `tenantWithAdmin`, `activeAdmin`, `user`, `createUserRaw`, `role`, `setOverride`, `impersonate`, `notifications`
- login and change-password helpers

It works over a pluggable transport: `supertestTransport(http)` for vitest and `fetchTransport(origin)` for Playwright or scripts. Super Admin creation is a hook, because there is no API for it. It is used by `concurrency.test.ts` and all E2E specs. Later phases should add builders here.

## Bug list

| ID | Sev | Area | Title |
| --- | --- | --- | --- |
| QA-BUG-001 | **High** | api | API process crashes when Postgres drops an idle pooled connection |
| QA-BUG-006 | **High** | api | Per-IP auth rate limit (30/min) counts `/auth/me` + `/auth/refresh`; normal browsing signs users out |
| QA-BUG-002 | Medium | api | Parallel `activate` of the same user → spurious `LIMIT_EXCEEDED` and duplicate audit rows |
| QA-BUG-003 | Medium | api | Concurrent override writes produce inconsistent override history |
| QA-BUG-004 | Medium | api/web | `limit_warning` notification links to `/settings/usage` (404 in web; route is `/usage`) |
| QA-BUG-005 | Low | web | Bell unread badge not refreshed after an action that notifies the current admin |
| QA-BUG-007 | Low | web | Impersonation Exit lands on tenant list, not the tenant detail page (README says detail) |

### QA-BUG-001 — API crashes when Postgres terminates an idle pooled connection (High, api)
- **Steps:** start the API (`node --env-file=../../.env dist/main.js`) and send a few requests so the pools hold idle connections. Then run `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='procure' AND state='idle' AND usename IN ('app_user','platform_user')`. Running `pnpm db:reset` with the API up has the same effect.
- **Expected:** pg drops the dead connection and the next query opens a new one. The process stays up.
- **Actual:** `node:events: throw er; // Unhandled 'error' event` / `error: terminating connection due to administrator command`, and the process exits with code 1. `DbService` creates both `pg.Pool`s without a `pool.on('error', …)` listener. The same thing happens on a DB failover, a pgbouncer or RDS restart, or an idle-timeout kill. In production that means a full outage until the orchestrator restarts the process.
- **Test:** `apps/api/test/concurrency.resilience.test.ts` (`it.fails`).
- **Fix hint:** attach `pool.on('error', log)` to both pools in `core/db.service.ts`, and also to the Kysely pools in `seed/demo.ts`.

### QA-BUG-006 — Auth rate limit counts session endpoints; normal browsing gets 429 and signs the user out (High, api)
- **Steps:** sign in to the platform console, then open about 15 pages (full loads) within a minute.
- **Expected:** brute-force limits on the login endpoints only, keyed by IP and account. `/auth/me`, `/auth/refresh` and `/auth/sessions` should use the normal API budget.
- **Actual:** `bootstrap.ts` counts every path containing `/auth/` against 30 requests per minute per IP. Each page load calls `/auth/refresh` and `/auth/me`, so after about 14 loads `/auth/me` returns 429. The web then treats the user as signed out and redirects to `/login?next=…`. A whole office behind one NAT IP shares this budget. During QA this also randomly signed out E2E runs.
- **Test:** `e2e/rate-limit.spec.ts` (`test.fail`). It records `429 /api/v1/auth/me` on reload #14.
- **Note:** the web should also not treat a 429 on refresh as "signed out".

### QA-BUG-002 — Parallel activate of the same user: false limit error and duplicate audit (Medium, api)
- **Steps:** a tenant with 1 free slot has a deactivated user U. Send 3 `POST /users/U/activate` at the same time.
- **Expected:** all three return 200 with U active (idempotent). There is one `activate` audit row, and no limit error, because U only uses one slot.
- **Actual:** you get `[200, 403 LIMIT_EXCEEDED.max_users, 403]`. With free slots instead, all succeed but write one `activate` audit row each. `UsersService.activate()` reads `isActive` before `lock_tenant_for_limit`, so callers waiting on the lock still see the stale "inactive" state. The active count never goes over the limit, so this is not a limit bypass.
- **Tests:** two `it.fails` cases in `concurrency.test.ts`.
- **Fix hint:** take the lock first, or re-read the row `FOR UPDATE` after locking, then return early if the user is already active.

### QA-BUG-003 — Concurrent override writes produce inconsistent history (Medium, api)
- **Steps:** send 5 `PUT /platform/tenants/:id/overrides` for `max_users` at the same time, with different values.
- **Expected:** the history forms a chain (each `oldValue` equals the previous `newValue`), and the newest history row equals the effective value.
- **Actual:** several rows share the same `oldValue`. The newest row by `changed_at` (transaction start time) is not the value that won, for example newest = 15 while effective = 13. `setOverride()` reads the existing override without `FOR UPDATE`, and history ordering uses `now()`. Override history is the audit trail for billing exceptions, so it has to be right.
- **Test:** `concurrency.test.ts` (`it.fails`).
- **Fix hint:** lock the `tenant_override` row (or take an advisory lock per tenant and key) before reading it, and order history by `clock_timestamp()` or by a sequence.

### QA-BUG-004 — Limit notification link points to a non-existent web route (Medium, api/web)
- **Steps:** fill a tenant's `max_users`, open the bell, and click "You have reached your plan limit…".
- **Expected:** the tenant Usage page (`/usage`).
- **Actual:** `users.service.ts` writes `link: '/settings/usage'`, and the web has no such route, so you get "Page not found". Notification links are part of the API ↔ web contract, but no route list is written down. Decide which side owns this.
- **Test:** `e2e/j9a-user-limit.spec.ts` (`test.fail`).

### QA-BUG-005 — Bell badge stale after an action that notifies the current admin (Low, web)
- **Steps:** as a tenant admin, create the user that reaches 80% or 100% of `max_users`.
- **Expected:** the bell shows "1 unread" straight away. The server created the notification for this admin in the same request.
- **Actual:** the badge stays at 0 until a full reload or the 60-second poll. `CreateUserDialog` and `UserDetailSheet` (activate) don't invalidate the `['notifications']` query.
- **Test:** `e2e/j9a-user-limit.spec.ts` (`test.fail`).

### QA-BUG-007 — Impersonation Exit lands on the tenant list instead of tenant detail (Low, web)
- **Steps:** open Tenant detail, choose Login as tenant, then Exit. Reproduced in 7/7 probe runs.
- **Expected:** `apps/web/README.md` says Exit "returns to the tenant detail page via the platform refresh cookie".
- **Actual:** you land on `/platform/tenants`. `exitImpersonation()` calls `router.replace('/platform/tenants/<id>')`. However, the tenant-area `AreaGuard` is still mounted when `me` switches to the platform principal, and its effect calls `router.replace(homeFor(platform))`, which is `/platform/tenants`, last.
- **Test:** `e2e/impersonation.spec.ts` (`test.fail`).

## Contract and implementation notes (not filed as bugs)

1. **No tenant audit read API.** The contract lists only `GET /platform/audit`. The tenant audit log, including `impersonated_by`, can't be checked through the API, so E2E reads `app.audit_log` as the DB owner. Add `GET /audit` (tenant admin) in Phase 2, or state in the contract that this is deferred.
2. **`/auth/login` lockout status.** The contract names the code `AUTH.ACCOUNT_LOCKED` but not the HTTP status. The implementation returns **423**. Write 423 into the contract.
3. **Notification `link` values** aren't in the contract (see QA-BUG-004).
4. **`next start` warning.** `next.config.ts` has `output: 'standalone'`, and `next start` prints "does not work with output: standalone". It works today, but the README, CI e2e job and this config all use `next start`. DevOps should switch to `node apps/web/.next/standalone/apps/web/server.js` or drop `standalone` for the e2e path.
5. **`pnpm e2e` on a fresh CI runner.** The CI e2e job runs `pnpm exec playwright install --with-deps chromium`. That installs chromium-1248 for `@playwright/test` 1.64.1, which takes precedence over the sandbox path because `/opt/pw-browsers/chromium-1194` won't exist there. Nothing to change, but note that the config only uses the preinstalled binary when it exists.
6. **Activate of an already-active user** returns 200 without counting against the limit. This is correct and useful, but the contract doesn't say so.
7. **`DELETE /auth/sessions/:id` with another subject's session id** returns 404 (good). Covered by the existing suite and now also cross-tenant.
8. **Impersonation actor.** Actions while impersonating record `actor_id` = the tenant admin and `impersonated_by` = the Super Admin. That matches the contract; I note it so Phase 2 audit UIs show both.

## Couldn't verify here

- **CI itself.** I couldn't run GitHub Actions. Locally I ran the same commands: test, lint, typecheck, lint:rls, and e2e with reused servers. That last one is the CI path, using the soft reset.
- **Real network conditions:** cross-origin cookies with `Secure` (prod), multiple tabs and Web Locks refresh serialisation in separate real browsers. One headless context per user was used.
- **Docker compose stack** (`infra/`): not exercised.
- **Accessibility beyond axe:** no manual screen-reader or keyboard-only pass. Colour contrast was checked only by axe and only in the light theme. Dark theme wasn't scanned.
- **Load:** `load/` is empty. Concurrency was tested at 2–20 parallel requests only.
- **Tenant/user lockout `security.lockout_minutes` other than the default:** the API suite covers a custom `max_failed_logins`. E2E uses the defaults (5 attempts, 15 minutes).

## Files added or changed by QA

- `apps/api/test/tenancy-isolation.test.ts`, `apps/api/test/concurrency.test.ts`, `apps/api/test/concurrency.resilience.test.ts`
- `packages/test-kit/{package.json,tsconfig.json,src/index.ts}`
- `e2e/{playwright.config.ts,global-setup.ts,tsconfig.json}`, `e2e/support/{env,fixtures,redis}.ts`, `e2e/*.spec.ts` (6 specs)
- `package.json` (root devDeps: `@axe-core/playwright` 4.11.0, `@procure/test-kit`), `apps/api/package.json` (devDep `@procure/test-kit`), `pnpm-lock.yaml`
- This report.

## Re-test (lead, 2026-10-22)

All seven bugs fixed and re-tested; every `.fails` / `test.fail` marker removed.

| Check | Result |
| --- | --- |
| `pnpm build`, `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm lint:rls` | pass (7 app tables) |
| API tests (`apps/api`) | 71 / 71 pass |
| Playwright (desktop + Pixel 7) | 11 / 11 pass, 0 expected-failures left |

Additional fix during re-test: the web client now treats 429 / 5xx / network errors on `/auth/refresh` as transient (retries with backoff, honours `Retry-After`) instead of signing the user out.

Backlog carried to Phase 2:
- Tenant Usage page lists limits whose feature is off (e.g. Custom forms 0 / 0 when Form builder is off); hide them for tenant users. Needs `featureKey` on `Entitlements.limits`.
- Playwright `webServer` uses `next start`, which warns under `output: 'standalone'`; switch to `node .next/standalone/apps/web/server.js` with static assets copied.
- Tenant audit log read API and timeline UI (Phase 3).
