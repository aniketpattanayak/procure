# Phase 2 API contract (FROZEN)

Base `/api/v1`, problem-JSON errors, types in `@procure/schema` (`access.ts`, `forms.ts`, `masters.ts`, `formula.ts`).
Migrations `0005_permissions_locations.sql`, `0006_forms_masters_files.sql`. Formula language:
`docs/contracts/formula-language.md`. ADRs 0005–0008. All tenant routes are `@TenantOnly`.

## Enforcement (applies to every route, existing and new)
- Every tenant route declares `@Requires(...)` / `@RequiresAny(...)` with registry keys, or checks a runtime key
  with `hasPermission(perms, key)` (masters: key built from the URL's master key). `@TenantAdminOnly` is retired:
  Phase 1 routes switch to the keys below. Tenant admins hold every registry key whose feature is in the plan.
- Phase 1 route → key mapping: `GET /users*` → `admin.users:action.view`; `POST /users` → `…add`;
  `PUT /users/:id` → `…edit`; activate/deactivate → `…deactivate`; reset-password, unlock → `…reset_password`;
  sessions, force-logout → `…force_logout`; `GET /roles` → `admin.roles:action.view`; `POST /roles` → `…add`;
  `GET /tenant/usage` → `admin.usage:action.view`. Users list honours views: `view=active` needs
  `admin.users:view.active`, `view=inactive` needs `…view.inactive` (403 otherwise).
- **Views (status filters)**: a list endpoint with a `view` param returns 403 for a view the user lacks; the default
  view is the first permitted one. The UI shows only permitted view chips.
- **Field access**: responses omit fields that are `hidden` for the caller; writes that change a `hidden` or
  `readonly` field are rejected `403 FIELD_READ_ONLY` with `meta.field` (unchanged values are fine).
- **Data scope**: `ScopeService.nodeFilter(perms, tabKey)` returns `{ all: true } | { paths: ltree[] }` for
  location-scoped queries (`path <@ ANY(...)`). Phase 2 uses it for `GET /locations?scope=mine` and lookups of
  `source.kind = 'location'` with `withinScope`; Phase 4 documents use the same call.
- Effective permissions are cached in Redis under `perm:<tenant>:<user>:<permver>`; any change to roles, grants,
  scopes, field access, user admin flag/activation, registry, plan/overrides or flow settings bumps the tenant's
  `permver` (Redis `INCR permver:<tenant>`). `EntitlementsService.invalidate` must also bump it.

## `/auth/me` (extended)
Adds `permissions: MyPermissions`, `labels: Record<string,string>` (tenant overrides for the user's language) and
`settings: { 'labels.location_levels': string[], 'flow.*': boolean }` (only non-sensitive keys). `features` stays.

## Permissions
| Method | Path | Body / Query | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/permissions/registry` | – | `RegistryTab[]` (plan- and flow-filtered; includes master tabs and per-tab form fields) | `admin.roles:action.manage_permissions` or `admin.users:action.manage_permissions` |
| GET | `/roles/:id/permissions` | – | `PermissionSetView` | `admin.roles:action.manage_permissions` |
| PUT | `/roles/:id/permissions/tabs/:tabKey` | `RoleTabPermissions` | `PermissionSetView` | same. Keys must belong to `tabKey` and be in the registry **and** the plan, else 400 `VALIDATION_FAILED` / 403 `FEATURE_NOT_IN_PLAN`. A user may only grant keys they hold themselves (no privilege escalation) unless tenant admin. |
| PUT | `/roles/:id/scope` | `ScopeReplace` | `PermissionSetView` | same |
| PUT | `/roles/:id` / DELETE `/roles/:id` | `RoleInput & {version}` / – | role / 204 | `admin.roles:action.edit` / `…delete` (delete blocked 409 if users assigned; system role never) |
| GET | `/users/:id/permissions` | – | `PermissionSetView` (user overrides only) | `admin.users:action.manage_permissions` |
| PUT | `/users/:id/permissions/tabs/:tabKey` | `UserTabPermissions` | `PermissionSetView` | same |
| PUT | `/users/:id/scope` | `ScopeReplace` | `PermissionSetView` | same |
| PUT | `/users/:id/roles` | `{ roleIds: uuid[] }` | `UserRow` | same |
| GET | `/users/:id/effective-permissions` | – | `EffectivePermissions` | `admin.users:action.view` |

## Locations
| Method | Path | Body / Query | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/locations` | `?parentId=&q=&view=active\|inactive\|all&scope=all\|mine` (no parentId + no q = top level) | `LocationNode[]` | `admin.locations:action.view` (`scope=mine`: any tenant user) |
| GET | `/locations/tree` | `?view=&scope=` | `LocationNode[]` flat, ordered by path (≤ 5,000 nodes; UI builds tree) | same |
| GET | `/locations/:id` | – | `LocationNode` | same |
| POST | `/locations` | `LocationCreate` | `LocationNode` | `…add`. **Enforces `max_locations`** (counts active nodes) via `app.lock_tenant_for_limit`. |
| PUT | `/locations/:id` | `LocationUpdate` | `LocationNode` | `…edit` |
| POST | `/locations/:id/move` | `LocationMove` | `LocationNode` | `…move`. Moving under own descendant → 409 `CONFLICT` |
| POST | `/locations/:id/deactivate` \| `/activate` | – | `LocationNode` | `…deactivate`. Deactivate cascades to descendants; activate requires active parent. Activate counts against the limit. |
| DELETE | `/locations/:id` | – | 204 | `…deactivate`. Only a leaf with no references (`record_ref` to_kind `location_node`, scope grants; Phase 4 adds documents/stock) → else 409 with `meta.usedBy`. |

Level names: setting `labels.location_levels` (`string[]`); depth *n* uses item *n−1*, deeper levels reuse the last.

## Settings & labels
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/config/settings` | – | `SettingRow[]` | `admin.settings:action.view` |
| PUT | `/config/settings` | `SettingsPatch` (validate each key against `SettingsRegistry`; unknown key → 400) | `SettingRow[]` | `admin.settings:action.edit` (bumps permver if a `flow.*` key changes) |
| GET | `/config/labels?lang=en` | – | `Record<string,string>` | any tenant user |
| PUT | `/config/labels` | `LabelsPatch` (`null` removes an override) | `Record<string,string>` | `admin.settings:action.edit` |

Labels storage: `app.tenant_setting` key `labels.<lang>` (JSON object). No new table.

## Forms (requires feature `form_builder` for writes)
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/config/forms` | – | `FormSummary[]` | `config.forms:action.view` |
| GET | `/config/forms/:formKey` | – | `FormDetail` | `config.forms:action.view` |
| PUT | `/config/forms/:formKey/draft` | `FormDraftSave` | `FormDetail` | `config.forms:action.edit`. Saves even with issues (they're returned in `draftIssues`). |
| DELETE | `/config/forms/:formKey/draft` | – | `FormDetail` | `…edit` |
| POST | `/config/forms/:formKey/publish` | `FormPublish` | `FormDetail` | `config.forms:action.publish`. Rejects with 400 + `errors[]` if `draftIssues` non-empty. Creates `form_version` N+1, sets `current_version_id`, registers field-access entries, bumps permver, audit. |
| GET | `/config/forms/:formKey/versions` | – | `FormVersionRow[]` | `…view` |
| GET | `/config/forms/:formKey/versions/:version` | – | `FormDefinition` | `…view` |
| POST | `/config/forms/validate` | `{ definition, formKey? }` | `{ issues: FormDefinitionIssue[] }` | `…edit` (builder live check; same code as publish) |
| GET | `/forms/:formKey/render` | `?versionId=` (default current) | `RenderableForm` (hidden fields removed, readOnly list) | any user who can view a tab using this form |

Publish rules (server-enforced): system fields can't be removed/retyped; a field's `type` can't change once
published (`FIELD_RETYPED`, add a new field instead); removing a field marks it `removed: true` in the new version
(data kept); keys are unique across the form including grid columns; formula/condition checks pass; lookups point to
existing active masters; filterBy/autofill reference real fields.

## Masters & records
Master record permission keys are generated on master creation (source `master`):
`master.<key>` tab; actions `view, add, edit, deactivate, delete, import, export`; views `active, inactive`.
Group label `Masters`. System masters' keys are generated when the tenant is provisioned.

| Method | Path | Body / Query | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/masters` | – | `MasterSummary[]` (only masters whose `…:action.view` the caller holds; all for `config.masters:action.view`) | any |
| POST | `/config/masters` | `MasterCreate` | `MasterSummary` | `config.masters:action.add`. **Enforces `custom_forms`** limit (count of non-system masters). |
| PUT | `/config/masters/:key` | `MasterUpdate` | `MasterSummary` | `config.masters:action.edit` |
| POST | `/config/masters/:key/deactivate` \| `/activate` | – | `MasterSummary` | `config.masters:action.edit` (system masters: 409) |
| GET | `/masters/:key/records` | `RecordListQuery` + `f.<field>=v` | `Page<RecordRow>` | `master.<key>:action.view` + view key |
| POST | `/masters/:key/records` | `RecordWrite` | `RecordRow` | `…add` |
| GET | `/masters/:key/records/:id` | – | `RecordRow` (rendered with its own `formVersionId`) | `…view` |
| PUT | `/masters/:key/records/:id` | `RecordUpdate` | `RecordRow` (re-saved under the **current** version; removed fields' data kept) | `…edit` |
| POST | `/masters/:key/records/:id/deactivate` \| `/activate` | – | `RecordRow` | `…deactivate` |
| DELETE | `/masters/:key/records/:id` | `{ reason }` | 204, or 409 `RECORD_IN_USE` with `RecordDeleteBlocked` meta | `…delete` (soft delete) |
| GET | `/masters/:key/records/:id/usage` | – | `RecordDeleteBlocked['usedBy']` | `…view` |
| GET | `/masters/:key/options` | `OptionsQuery` | `OptionRow[]` | user holds `…view` on the master **or** can view/add/edit any form whose lookup targets it (resolved via registry; simplest: any tenant user, but hidden fields/inactive rules still apply). Inactive excluded unless in `include`. `filter=category:` (empty value) → `[]`. |
| GET | `/users/options` | `?q=&limit≤100` (default 30) | `{ id, name, email }[]` (active users, name order; `q` matches name or email) | any tenant user — lookup feed for `source.kind = 'user'` fields (registered ahead of `/users/:id`) |
| GET | `/masters/:key/template.xlsx` | – | XLSX with headers = code, name, data fields (lookup columns take the target **code**) | `…import` |
| POST | `/masters/:key/import` | multipart `file` (.csv/.xlsx ≤ 5,000 rows, ≤ 5 MB), `?dryRun=true&mode=create\|upsert` | `ImportReport` | `…import`. All-or-nothing in one transaction; lookups resolved by code; formulas computed; same validation as single save. |
| GET | `/masters/:key/export` | `?format=csv\|xlsx&view=` | file stream (lookups as codes) | `…export` |

Record save pipeline (single save and import): load current form version → strip unknown keys → apply field access
→ validate each value against its field type (type rules, min/max, regex, GSTIN/PAN check digit, options exist,
lookup target exists + active + matches `filterBy` parent value, files exist + clean + tenant-owned + type/size per
field) → evaluate formulas server-side (`@procure/formula`, client formula values ignored) and `requiredWhen` /
validations → unique checks (advisory lock per master+field) → write record + rewrite `record_ref` rows + attach
files → audit (`before`/`after`). Errors are 400 with `errors[].path` = field key (`lines.3.qty` for grids).

## Files
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| POST | `/files` | multipart `file` (+ optional `formKey`, `fieldKey` to apply that field's `accept`/`maxSizeMb`) | `FileMeta` | any tenant user. Size cap 25 MB absolute; MIME sniffed from bytes (reject mismatch/unknown); global allow-list: images (png, jpeg, webp, gif), pdf, csv, xlsx, docx, txt. **Storage limit** via `app.consume_storage(bytes)` → `LIMIT_EXCEEDED.storage_gb`. Scan status starts `pending`; scanner driver `noop` (dev/test: marks clean immediately) or `clamav` (`CLAMAV_HOST`). |
| GET | `/files/:id` | – | `FileMeta` (fresh signed URL) | uploader, or anyone who can view a record it's attached to (Phase 2: any tenant user of the same tenant) |
| GET | `/files/:id/content?exp=&sig=` | – | bytes (`Content-Disposition` attachment for non-images; `?w=` thumbnails for images) | **Public** route, authorised by HMAC signature over `id|exp|w` with `FILE_URL_SECRET`; 403 when expired/invalid. S3 driver returns presigned S3 URLs instead and this route is unused. |

Storage driver interface `put/get/delete/presign` with `local` (dir `STORAGE_DIR`, default `./.data/files`) and `s3`
(`S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT?`) implementations; selected by `STORAGE_DRIVER`. Orphan files
(`attached_to IS NULL`, > 24 h) are deleted by `FilesService.cleanupOrphans()`, run nightly for every tenant with
candidates by the repeatable job `files-orphan-cleanup` (queue `files`, 02:10 UTC; tenants from
`app.file_orphan_tenants()`, migration 0019). Files referenced without `attached_to` — vendor quote `file_ids`,
outbound message `attachment_file_ids`, the tenant logo URL — are never deleted (`app.file_ids_referenced`).

## Tenant provisioning (global templates)
`platform.global_template` gains a bundle `standard` (kind `bundle`, key `standard`) whose `content` lists forms,
masters, roles and settings to copy. `TemplateInstaller.apply(tx, bundleKey)` (exported by the forms module) runs
inside tenant creation (platform `TenantsService.create`, inside the same transaction with tenant context set).
**Every new tenant always gets the system forms/masters** (user form, Item, Vendor, Unit of Measure, Terms &
Conditions, Payment Terms) even if no bundle is chosen; `standard` additionally adds starter roles
(Requester, Buyer, Approver, Store keeper — with sensible grants) and sample UoM records (Nos, Kg, Litre, Metre, Box).
The demo seed provisions `acme` and `globex` through the same installer. Copies are independent of the template.

System master fields (engine-required, `system: true`):
- **item**: `code`, `name` (row columns) + `uom` (lookup → uom, required), `track_batch` (toggle), `track_expiry`
  (toggle), `hsn_code` (text), `image` (image, optional).
- **vendor**: `code`, `name` + `gstin` (gstin), `pan` (pan), `email` (email), `phone` (phone), `address` (textarea),
  `state_code` (text, 2 digits — drives CGST/SGST vs IGST later), `payment_terms` (lookup → payment_terms).
- **uom**: `code`, `name` + `decimals` (number 0–6, default 0).
- **terms**: `code`, `name` + `body` (textarea, required), `applies_to` (multiselect: po, indent, grn).
- **payment_terms**: `code`, `name` + `credit_days` (number, required).
- **user** form (kind `system`): system fields `name`, `email`, `phone`, `reporting_manager` (lookup → user);
  custom fields saved to `tenant_user.custom`. `POST/PUT /users` accept `custom` and validate it against this form.

## Live-count limits
`max_locations` = active location nodes; `custom_forms` = non-system masters (active or not). Counters registered in
`LIVE_COUNTERS` (identity) — the Architect adds them.

## Entitlements change
`Entitlements.limits[]` gains `featureKey: string | null`. The tenant Usage page hides limits whose feature is off.
