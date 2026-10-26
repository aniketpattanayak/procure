# Phase 2 QA report

Date: 2026-10-22. Environment: local sandbox (Node 22, Postgres 16 on :5432, Redis on :6379, Chromium 141 headless via
`/opt/pw-browsers/chromium-1194`). Scope: Phase 2 engines (permission registry, location tree, form builder, masters,
cascading lookups, formula engine, files) against `docs/contracts/phase-2-api.md`, `docs/contracts/formula-language.md`
and ADRs 0005–0008.

**Result: the Phase 2 journeys work end to end in the real UI against the real API (J2 cascade + form builder, J3
restricted user, locations, form versioning, import, formula editor, limits, Pixel 7). Performance is well inside the
target: every p95 is under 61 ms on 50,000 records, against a 300 ms target. Security is where the problems are. I filed 9 bugs:
1 critical, 3 high, 3 medium and 2 low. The critical one is a privilege escalation: any user with `admin.users:action.add` or
`…edit` can make themselves or anyone else a tenant administrator. Every bug except the perf note has a reproducing
test marked as expected-to-fail (`it.fails` / `test.fail`) with its id. When a fix lands, the test will "unexpectedly pass" and
the marker should be removed.**

## What ran

| Suite | Command | Baseline (before QA) | After QA |
| --- | --- | --- | --- |
| Build | `pnpm build` | pass | pass |
| Typecheck | `pnpm typecheck`, `npx tsc -p e2e` | pass | pass |
| Lint | `pnpm lint` | pass | pass |
| RLS lint | `pnpm lint:rls` | OK (17 app tables, 0 allow-listed) | same |
| API integration (vitest, `procure_test`) | `cd apps/api && pnpm test` | 20 files, 227 tests, all green | **22 files, 294 tests, all as expected**. 284 are plain passes and 10 are known-bug repros (`it.fails`). Ran twice in a row; the race repros reproduced both times (`qa-phase2-integrity` also ran 3× on its own). |
| Formula engine | `pnpm --filter @procure/formula test` | 8 files, 353 tests, 99.81% statements / 98.2% branches | unchanged (no QA changes needed) |
| E2E (Playwright, desktop + Pixel 7) | `pnpm e2e` | 11 tests, all green (Phase 1) | **26 tests, 26 as expected**. 24 pass and 2 are known-bug repros (`test.fail`). Ran once with Playwright starting the stack (`db:reset` path, standalone web), and repeatedly per spec with reused servers (soft-reset path). |
| Performance smoke | `node load/phase-2/seed-master-records.mjs && node load/phase-2/measure.mjs` | n/a | see below |

No Phase 1 E2E spec had to change. Its journeys still pass under the permission-driven sidebar and the Phase 2 users
list views.

### Backlog item fixed: standalone web server for Playwright
The `web` webServer now runs `node e2e/support/start-web.mjs`. The script copies `apps/web/.next/static` (and `public/`
if one exists) into `.next/standalone/apps/web/` and starts `server.js` on :3000. The `next start` /
`output: 'standalone'` warning is gone. The full suite passed with this server.
**DevOps:** the CI e2e job and `apps/web/README.md` still use `next start`; switch them the same way.

### Harness fix found during the run (QA-owned, not a product bug)
The soft reset in `e2e/global-setup.ts` truncated every `platform.*` table except the two Phase 1 catalogs. That
included `platform.permission_def`, the migration-seeded registry from 0005. After a soft reset, tenant admins held no
`admin.*` or `config.*` keys and every admin page showed "You don't have access". `KEEP` now includes
`platform.permission_def`, and global setup fails loudly if any kept catalog is empty.

## New tests

### API (`apps/api/test/`)
- **`qa-phase2-security.test.ts`** (58 tests, 8 `it.fails`)
  - **Escalation by non-admins:**
    - Creating a tenant admin, or self-promoting to admin, with `users:add` / `users:edit`.
    - Assigning roles through `POST /users` / `PUT /users/:id` `roleIds`.
    - Lifting a Deny on one's own account.
    - Setting a field to `editable` over a role lock.
    - Widening location scope by assigning an all-locations role.
    - Control: the escalation checks that do work (role tabs, user allow, the Administrator role).
  - **Cross-tenant:** tenant A's admin calls 22 Phase 2 routes with B's ids or B-only keys:
    - Records by id under the same master key (`item`, and `qa_thing`, which exists in both tenants).
    - Usage.
    - B-only master list, options, template, export.
    - Config form, versions, render, draft, publish.
    - Master update and deactivate.
    - `GET /files/:id`.

    All return 404 with no B data, and B is unchanged. B ids used as references from A are 400 (lookup, image), and
    `options?include=<B id>` returns nothing.
  - **Signed file URLs:**
    - Valid URL → bytes.
    - Rejected with 403:
      - flipped signature;
      - changed `exp`;
      - a genuinely signed but expired URL;
      - a `w` the signature doesn't cover;
      - A's signature on B's id;
      - no signature;
      - a truncated signature;
      - a garbage or SQL-ish tenant id.
    - A correctly signed URL routed to the wrong tenant → 404 with no bytes.
  - **Uploads:**
    - Rejected:
      - PE/ELF executables and shell scripts renamed `.png`/`.pdf`/`.jpg`/`.txt`;
      - HTML or SVG, raw or renamed;
      - a real PNG named `.png.exe` or with no extension.
    - A script or HTML named `.txt` → stored as `text/plain`, served as an attachment with `nosniff`.
    - GIF/JS and PNG/HTML polyglots → served only as `image/*` with `nosniff`.
    - An image field refuses a PDF.
    - Path traversal and CRLF in file names are neutralised.
  - **Formula / prototype injection:**
    - 27 hostile expressions are refused by `/config/forms/validate` with an issue on the field, including:
      - `constructor`, `__proto__`, `qty.constructor.constructor`, `HASOWNPROPERTY(qty)`;
      - `process.exit(1)`, `require('fs')`, `eval`, `Function`, arrow functions, template literals, `new`;
      - 60-deep nesting and 300-term expressions.
    - `Object.prototype` is unchanged after each one.
    - Expressions over 2,000 characters are rejected; injected `visibleWhen` and validation expressions are rejected.
    - A publish carrying an injected formula is 400 and leaves the version unchanged.
    - Record `data` carrying `__proto__` / `constructor` keys is stripped (DB row has only real fields) and pollutes nothing.
    - Hidden fields never appear in `options?attrs=`, and `f.<hidden>` / `sort=<hidden>` are 400.
- **`qa-phase2-integrity.test.ts`** (9 tests, 2 `it.fails`)
  - **`record_ref` delete protection:**
    - A UoM used by an item → 409 `RECORD_IN_USE` with `usedBy` [{Items, 1}]. A deactivated item still counts. After
      re-pointing or deleting the item, the delete succeeds.
    - A category used by a sub-category → 409 until the sub-category is deleted.
    - Race between deleting a UoM and saving a new reference to it (QA2-BUG-006).
  - **Concurrency:**
    - Two publishes of the same draft version → exactly one 200 and one 409, ×3 rounds, version numbers unique.
    - 6 concurrent saves with the same unique value (mixed case) → exactly one 201, the rest 409 on that field.
    - 6 concurrent creates with the same explicit code → one 201, the rest 409, never 500.
    - 12 parallel auto-numbered creates → `QA-0001…0012`, no gaps or duplicates.
  - **Location move races:** after each round, every node is checked for `path = parent.path || 'n'||id`,
    `depth = nlevel(path)` and no cycle. Two cases:
    - Overlapping parent/child/grand-parent moves: consistent.
    - X under Y's child while Y moves under X's child: **cycle** (QA2-BUG-005).
- **`tenancy-isolation.test.ts`** (extended only): the generated "B ids → 404" route list now also covers
  `/masters/item/records/:id` (GET, PUT, deactivate, activate, DELETE, usage), `/masters/uom/records/:id` (GET, DELETE)
  and `/files/:id`. It runs both directly and while impersonated, and all routes return 404.

### E2E (`e2e/`)

| Spec | What it proves | Result |
| --- | --- | --- |
| `j2-cascade-form.spec.ts` | **J2**. As the acme admin: wizard creates **Item Group** (key/plural auto-filled). In the builder, add lookup `sub_category` → Item Sub-category (required) and publish. In the Item builder, add `group` (lookup → item_group, filterBy `sub_category`), `landed_rate` (first typed as `std_rat * 1.05`: squiggle plus a suggestion naming `std_rate`; then fixed; sample value 200 → 210) and `photo` (image), then publish. The API confirms the definitions. New item through the UI: sub-category and group wait for their parent (hint). Category A offers only D/E/F; B offers only H; C shows an empty state (no error). Changing category clears sub-category **and** group; group options follow sub-category (G-D1/G-D2 for D, G-H1 for H). The formula updates live (200 → 210, 100 → 105). The PNG uploads and previews (`naturalWidth > 0`). Save works and the code is generated. The list row shows category/sub-category/group labels and a loaded thumbnail. The API agrees (`landed_rate` "105.00", file 120×80 clean). The API rejects category B + sub-category D with 400 on `sub_category`, and a group from another sub-category with 400 on `group`. | pass |
| `j3-restricted-user.spec.ts` | **J3**. On the permission screen the admin gives "Indent clerk" `master.item` view/add/edit, the `inactive` view only, `std_rate` hidden and `hsn_code` read-only. The API returns exactly those grants, and the scope is still Pune Plant + descendants. The indenter's sidebar has Items and Locations but no Users/Roles/Settings/Forms/Master designer/Usage or other masters. The list shows only the inactive item, with no Active/All chips and no Import/Export/Edit-form buttons. `std_rate` is not in the column chooser, list or sheet. `hsn_code` is read-only. There are no Deactivate/Delete buttons. API: `view=active`/`all` → 403; deactivate/activate/delete/export/template → 403; other masters, `/users`, `/config/forms` → 403. Changing `hsn_code` → 403 `FIELD_READ_ONLY` with `meta.field`, and so is writing a hidden `std_rate`. A permitted rename succeeds and keeps the hidden value. `/locations/tree?scope=mine` returns only the Pune subtree. A per-user Deny on `add` → API 403 and no Add button after reload. | pass |
| `j3-…` `[QA2-BUG-008]` | A user whose only view is `inactive` should see that single chip. | expected fail |
| `locations.spec.ts` | Fresh tenant. Levels renamed in Settings › Labels to Site/Warehouse/Rack (saved; API agrees). Sites, a warehouse and racks are built in the tree, and each add dialog names its level. The warehouse moves to the other site, and both racks follow (pathNames, level label, detail breadcrumb). Deactivating the site cascades to 3 descendants (the dialog says so), and activating a rack under an inactive parent → 409. Delete is blocked while a role's scope references the node (`location-used-by` shown) and works once the reference is removed. Deleting a node with children → 409. | pass |
| `forms-masters.spec.ts` | **Versioning:** a v1 record still shows `size` after v2 removes it, with a version notice, and new records don't offer it. Editing re-saves on the current version id and the API still has `size: 'L'`. **Import:** the template downloads (OOXML). A CSV with `qty = -4` on spreadsheet row 3 → one report row (row 3, qty), commit disabled, 0 records. The fixed file has a clean dry run (still 0 records), then commit → P1–P3 with the `uom` code resolved to its id, shown in the list. **Formula editor:** `qtty * rate` → squiggle exactly on `qtty`, a suggestion of `qty`, and an issue in the builder. Sample values 3 × 12.5 → 37.5. `a = b + 1`, `b = a + 1` → a `FORMULA_CYCLE` issue naming `a → b → a`. Publish is refused (current version unchanged), and the server's validate returns the same loop. | pass |
| `limits.spec.ts` | **custom_forms = 1:** another admin takes the last slot while the wizard is open → the wizard shows `master-limit-error` with the server's exact title. On reload "New master" is disabled with a visible explanation. **max_locations = 2:** `locations-limit` is `full`, and Add shows `location-limit-error` with the server title. **storage_gb:** the Super Admin sets the override to 0 on globex in the console. The globex admin's image upload on a new item shows the server message (`LIMIT_EXCEEDED.storage_gb` title) and nothing is attached. The override is removed afterwards. | pass |
| `a11y-phase2.spec.ts` | axe (WCAG 2.0/2.1 A+AA, serious + critical) on: the permission screen (role, Items tab with field access, scope editor), the location tree with a node selected, the master record form (new and view mode), and the form builder. | 3 pass; builder = expected fail (QA2-BUG-007) |
| `mobile-phase2.spec.ts` (Pixel 7) | Master record form: the sheet fits the screen; 2-level cascade with an empty state; live formula (100 → 118.00); image upload with preview; save; axe clean. The location tree is reached through the drawer and expands with no horizontal scroll. On the permission screen the tab list becomes `perm-tab-select`; granting `master.tool:action.view` saves (API agrees) with no horizontal scroll. | pass |

Support added:
- `e2e/support/phase2.ts`: seed sessions, multipart upload, owner-SQL reads, a dependency-free PNG generator, and lookup / CodeMirror / publish helpers.
- `e2e/support/start-web.mjs`.
- Test-kit Phase 2 builders: `call`, `ok`, `builderTenant`, `createMaster`, `publishForm`, `formFields`, `record`, `records`, `recordIds`, `roleWithKeys`, `signedInUser`, `location`, `locationTree`.
- Config: `actionTimeout` 20 s, and the mobile project matches `mobile*.spec.ts`.

## Performance (50,000 records in one master)

Seed: `load/phase-2/seed-master-records.mjs` inserts 50,000 acme `item` records with SQL as the owner. Their data is
shaped like API saves (uom/category/sub_category ids, decimals, formula value, current form version), 90% are active,
and the matching `record_ref` rows are included. The seed takes about 4 s and finishes with `ANALYZE`.

Measurement: `load/phase-2/measure.mjs` makes 5 warm-up calls, then **50 sequential requests per scenario**, timed by the
client over loopback against the built API. Plans come from `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` run **as `app_user` with
the tenant context set**, so RLS is part of each plan. They are saved in `load/results/phase-2/`, with the numbers in
`summary.json`.

| Scenario | p50 | **p95** | max | Plan |
| --- | --- | --- | --- | --- |
| `GET /masters/item/records` (first page, 50) | 5.1 ms | **6.9 ms** | 7.4 | Index Scan `master_record_list`, 0.3 ms |
| `…?q=bolt` | 6.5 | **10.1** | 14.2 | Index Scan `master_record_list` + filter, 4.3 ms |
| `…?q=PERF-049999` (rare term, worst case) | 50.8 | **60.5** | 64.5 | walks the whole `master_record_list` index |
| `…?q=zzzz` (no match, worst case) | 48.0 | **53.3** | 54.0 | same, 47 ms |
| `…?f.category=<A>` (16,669 matches) | 8.6 | **10.5** | 12.8 | Index Scan `master_record_list` + `data @>` filter, 4.0 ms |
| `/masters/item/options?q=steel&filter=category:<A>` | 21.1 | **26.3** | 27.0 | **Seq Scan on master_record**, 17 ms |
| `/masters/item/options?q=st&filter=sub_category:<D>` | 19.6 | **21.2** | 25.5 | **Seq Scan on master_record**, 16 ms |
| `…?sort=-std_rate` page 2 (data-key sort, extra) | 42.6 | **53.1** | 58.1 | **Seq Scan** + top-N sort, 40 ms |

All scenarios meet the 300 ms target with plenty of headroom. There are three seq scans on `master_record`, which I've
filed as low-severity QA2-BUG-009. They are fast at 50k rows but grow linearly with the tenant's table. Rare-term
searches on the records list also scan the whole list index (about 50 ms here).

## Bug list

| ID | Sev | Area | Title | Repro |
| --- | --- | --- | --- | --- |
| QA2-BUG-001 | **Critical** | api | `users:add`/`users:edit` holders can create tenant admins, self-promote, and assign any role (incl. Administrator) via `roleIds`, bypassing the escalation checks | 4 × `it.fails` in `qa-phase2-security` |
| QA2-BUG-002 | **High** | api | User overrides allow self-escalation: a manager can lift a Deny on their own account and make a role-locked field `editable` for themselves | 2 × `it.fails` |
| QA2-BUG-003 | **High** | api | Scope escalation: assigning a role whose scope covers all (or other) locations is not checked against the caller's own scope | `it.fails` |
| QA2-BUG-005 | **High** | api | Concurrent location moves can create a cycle and corrupt `path` (two subtrees moved under each other) | `it.fails` in `qa-phase2-integrity` |
| QA2-BUG-004 | Medium | api | `/masters/:key/options?filter=<hidden field>:<guess>` is an oracle for hidden field values | `it.fails` |
| QA2-BUG-006 | Medium | api | Deleting a master record races with a save that references it, leaving a live record pointing at a deleted one | `it.fails` |
| QA2-BUG-007 | Medium | web | Form builder canvas fails axe: critical `aria-allowed-attr` and serious `nested-interactive` / `list` | `test.fail` in `a11y-phase2` |
| QA2-BUG-008 | Low | web | With a single permitted view, the records list shows no view chip at all (brief/contract: show the permitted chips) | `test.fail` in `j3-restricted-user` |
| QA2-BUG-009 | Low | api (perf) | Seq scans on `master_record` for `options` with `q` (and for data-key sorts). Rare-term list searches walk the whole list index | perf note, `load/results/phase-2/` |

### QA2-BUG-001: users add/edit bypass privilege-escalation checks (Critical, api)
- **Steps:**
  1. As an admin, give user M a role with only `admin.users:action.view`, `…:view.active` and `admin.users:action.add`
     (or `…edit`).
  2. As M, do any of:
     - `POST /users {name, email, isTenantAdmin: true}`;
     - `PUT /users/<M> {isTenantAdmin: true, version}`;
     - `PUT /users/<M> {roleIds: [<any role>], version}`;
     - `POST /users {…, roleIds: [<Administrator role id>]}`.
- **Expected:** 403. The contract says "A user may only grant keys they hold themselves … unless tenant admin", and
  `PUT /users/:id/roles` already enforces this, including "Only an administrator can assign the administrator role".
- **Actual:** 201 / 200. M becomes a tenant administrator, or creates one with a temp password M knows, and so holds
  every key. `UsersService.create/update` write `is_tenant_admin` and `user_role` without any caller check. The
  `users:edit` path also lets M change their own roles.
- **Fix hint:** only tenant admins may set `isTenantAdmin` or change it to true. Route `roleIds` on create/update through
  the same check as `PermissionsAdminService.putUserRoles` (keys, Administrator role, and scope; see BUG-003), or refuse
  `roleIds` from non-admins.

### QA2-BUG-002: user-override self-escalation (High, api)
- **Steps:**
  1. M holds `admin.users:action.manage_permissions` and `admin.users:action.add` through a role.
  2. The admin sets a user Deny on M for `admin.users:action.add`.
  3. M calls `PUT /users/<M>/permissions/tabs/admin.users {allow: [], deny: []}`.
  4. Separately: M's role makes `item.hsn_code` read-only, and M calls
     `PUT /users/<M>/permissions/tabs/master.item {fieldAccess: [{item, hsn_code, editable}]}`.
- **Expected:** 403 in both cases. Removing a deny or lifting a field lock gives the subject something the caller doesn't
  hold.
- **Actual:** 200. After step 3, M can add users again. `checkEscalation` only looks at keys newly placed in `allow`. It
  ignores deny removals and field-access loosening, and doesn't stop users from editing their own overrides.
- **Fix hint:** treat a removed deny as a grant, and require the caller to hold the key without that deny. Require the
  caller's own field mode to be at least as permissive. Simplest option: non-admins cannot edit their own permissions,
  scope or roles.

### QA2-BUG-003: scope escalation through role assignment (High, api)
- **Steps:**
  1. M holds `admin.users:action.manage_permissions`, with scope = one plant.
  2. The admin creates role W with only `admin.locations:action.view` (which M holds) and scope = all locations.
  3. M calls `PUT /users/<M>/roles {roleIds: [<M's role>, W]}`. (`PUT /users/<M>/scope {allNodes: true}` is correctly
     refused.)
- **Expected:** 403, because the role's scope is outside M's access.
- **Actual:** 200, and M now covers every location. `putUserRoles` checks keys but not the scope rows of the added
  roles. The same applies to `roleIds` in BUG-001.
- **Fix hint:** in `putUserRoles`, apply the `putScope` "outside your own access" check to the scope grants of each added
  role.

### QA2-BUG-005: concurrent location moves create cycles (High, api)
- **Steps:**
  1. Build X → X1 and Y → Y1.
  2. At the same time, send `POST /locations/X/move {parentId: Y1}` and `POST /locations/Y/move {parentId: X1}`.
- **Expected:** one 200 and one 409 ("cannot move under its own sub-location"). The tree stays a tree.
- **Actual:** both return 200, in round 0 of every run. X's parent is Y1 and Y's parent is X1, a cycle. `path` no longer
  equals `parent.path || label`: for example, X's path stops at 3 levels while its parent chain loops. Tree views,
  `scope=mine`, `path <@` filters and later moves will all misbehave. `move()` locks only the moving node. The target's
  path is read without a lock, and the trigger's "under own descendant" check uses each transaction's snapshot.
- **Fix hint:** take a per-tenant advisory lock (`pg_advisory_xact_lock(hashtext('loc-move:'||tenant))`) for moves,
  or lock the target and its ancestors `FOR UPDATE`. Then re-read the target path and check it under the lock.

### QA2-BUG-004: options filter is an oracle for hidden fields (Medium, api)
- **Steps:**
  1. A user can view `qa_price` but has `cost` hidden.
  2. Call `GET /masters/qa_price/options?filter=cost:42`, then the same with `cost:41`.
- **Expected:** a filter on a hidden field is refused (400) or ignored, as `GET …/records?f.cost=` (400) already does.
- **Actual:** `cost:42` returns the record and `cost:41` returns `[]`, so the hidden value can be found by guessing,
  including ranges via repeated calls. `RecordsService.options` checks `access[key] === 'hidden'` for `attrs` but not for
  `filter`.
- **Note:** options is open to any tenant user, so this also probes masters the user can't list at all.

### QA2-BUG-006: delete vs. new reference race (Medium, api)
- **Steps:** create a UoM U. At the same time, send `DELETE /masters/uom/records/U` and
  `POST /masters/item/records {data: {uom: U}}`. Over 20 rounds this reproduces in every run.
- **Expected:** either the delete returns 409 `RECORD_IN_USE`, or the save returns 400 "not found".
- **Actual:** 204 and 201. A live item references a soft-deleted UoM, and its `record_ref` row points at a deleted record.
  `remove()` locks the row and reads usage. The save validates the lookup target without a lock and inserts the
  `record_ref` after the delete has committed.
- **Fix hint:** lock referenced targets `FOR KEY SHARE` (or `FOR SHARE`) while validating lookups in the save
  pipeline, then re-check `is_deleted`.

### QA2-BUG-007: form builder canvas accessibility (Medium, web)
- **Steps:** open `/config/forms/item` and run axe.
- **Actual:**
  - `aria-allowed-attr` (critical): `li[aria-label="Unit of measure, Lookup"]` … every canvas card. The `<li>` gets
    `role="button"` from dnd-kit `attributes`, plus `aria-selected`, which isn't allowed on a button.
  - `nested-interactive` (serious): the same cards contain the drag handle and the duplicate and delete buttons.
  - `list` (serious): `ol.grid-cols-1` contains `li` elements that have role=button, so they aren't list items.
- **Fix hint:** keep `<li>` as a list item and put the sortable/selection role on an inner element that isn't nested
  (for example, a "select field" button beside the action buttons). Express selection with `aria-current` or
  `aria-pressed`. Alternatively, switch the canvas to a `listbox`/`option` pattern.

### QA2-BUG-008: single permitted view hides the view chips (Low, web)
- **Steps:** give a user only `master.item:view.inactive` (plus `action.view`) and open `/masters/item`.
- **Expected:** the list shows the "Inactive" chip, checked and alone. The brief says "Items list shows only the
  Inactive chip", and the contract says the UI shows only permitted view chips.
- **Actual:** no chip is rendered, because `master-records-page.tsx` renders chips only when `views.length > 1`. The user
  sees inactive records with no sign that the list is filtered.

### QA2-BUG-009: seq scans on `master_record` (Low, api, performance)
- The `options` query with `q` plus a cascade filter is a **Seq Scan** at 50k rows (17 ms). The
  `(search @@ … OR lower(name) LIKE …)` predicate defeats the GIN `search` and `lower(name)` indexes, and
  `data @>` is estimated at about 11 rows when the real count is about 16,000.
- Sorting by a data key (`sort=-std_rate`) is a Seq Scan plus top-N (40 ms).
- Rare-term or no-match list searches walk the whole `master_record_list` index (about 50 ms).
- All are well under 300 ms today but grow linearly with a tenant's master size.
- **Suggestions:**
  - Split the OR into a `UNION`, or use `search @@ … ` alone (the tsvector already covers the name prefix).
  - Consider `pg_trgm` for contains-search.
  - Expression indexes for commonly sorted or filtered data keys (ADR-0006 already anticipates this).

## Contract and implementation notes (not filed)

1. **Seed "Indent clerk"** has `admin.locations:action.view` but no `admin.locations:view.*`. The sidebar therefore shows
   Locations, but `GET /locations/tree?scope=all` returns 403, so the page's admin list is unusable for that role. The
   location switcher works because `scope=mine` needs no view key. Either the seed should add `view.active`, or the
   tab should be hidden without a view key.
2. **Decimal canonical form:** `std_rate` typed as `100` is stored as `"100"`, while formula results are fixed precision
   (`"105.00"`). The contract example only says "decimal string". Say whether stored decimals are canonical or padded.
3. **`master-records-page`** sends no `view` when the user has a single view, so the API's "first permitted view"
   default does the work. That is correct.
4. **Options are open to any tenant user** (contract: "simplest: any tenant user"). Combined with QA2-BUG-004, that's a
   wide surface. Consider limiting `options` to masters referenced by forms on tabs the user can view.
5. **`/files/:id/content`** with a valid signature but the wrong `t` returns **404** rather than 403. That's fine (no
   data), but the contract only mentions 403.
6. **Concurrent publish** returns 409 for the loser, as expected. The draft row version is the lock.

## Couldn't verify here

- **CI itself:** GitHub Actions can't run here. I ran the same commands locally.
- **S3 storage driver / presigned URLs and the ClamAV scanner** against real services. Only `local` + `noop` were
  exercised; the existing suite has a fake clamd.
- **Orphan cleanup on a schedule** (Phase 3 runs it).
- **Import above 1,000 rows and the 5 MB / 5,000-row caps through the UI.** The API suite covers the caps; E2E used 3 rows.
- **Perf under concurrency:** the measurements are sequential, single client, loopback. There's no multi-tenant mixed load
  and no cold-cache measurement. Plans were taken right after `ANALYZE`.
- **Accessibility beyond axe:** no screen-reader pass of the tree, combobox or CodeMirror editor. Light theme only.
- **Safari / Firefox:** Chromium only.

## Files added or changed by QA

- `apps/api/test/qa-phase2-security.test.ts`, `apps/api/test/qa-phase2-integrity.test.ts` (new);
  `apps/api/test/tenancy-isolation.test.ts` (extended: record and file routes).
- `e2e/`:
  - New specs: `j2-cascade-form`, `j3-restricted-user`, `locations`, `forms-masters`, `limits`, `a11y-phase2`, `mobile-phase2`.
  - `support/phase2.ts`, `support/start-web.mjs`.
  - `playwright.config.ts`: standalone web server, timeouts, mobile project match.
  - `global-setup.ts`: keeps the registry catalog.
- `packages/test-kit/src/index.ts`: Phase 2 builders.
- `load/phase-2/{seed-master-records,measure}.mjs`, `load/results/phase-2/` (plans + `summary.json`).
- This report.

## Re-test and sign-off (lead, 2026-10-22)

| Check | Result |
| --- | --- |
| build, typecheck, lint, lint:rls | pass |
| API tests | 297 / 297, no known-bug markers |
| Formula tests | 353 / 353, 99.8% lines |
| Playwright (desktop + Pixel 7) | 26 / 26 |

QA2-BUG-001…008 fixed and re-tested. QA2-BUG-009 partially fixed; remaining seq scans under RLS are a recorded
decision (ADR-0009). Follow-up fix during re-test: `admin.locations` honours data scope on every route.

Backlog for Phase 3/4 (from demo review):
- Sidebar "Modules" placeholders (Indents, POs, GRN, Store, Reports) are shown by plan feature alone; switch to
  permission keys when those modules ship (Phase 4/5), so restricted users don't see them.
- Locations page shows the tenant's location-limit bar to non-admins; show it only with `admin.usage:action.view`.
- Signed file URLs carry the tenant id outside the signature (404 on mismatch); include it in the HMAC.
