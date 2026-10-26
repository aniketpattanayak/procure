# Permissions reference

Every permission key the platform can grant, taken from the code: the shipped registry rows in
`platform.permission_def` (seeded by migrations `0005`, `0008`, `0012`, `0013`, `0015`) and the keys each tenant
generates for its masters, document types and workflow stages (`app.permission_def`). ADR-0005 describes the model.

## How keys work

| Kind | Grammar | Example | Meaning |
| --- | --- | --- | --- |
| Tab | `<tab>` | `admin.users` | A screen or module. Shown on the permission screen as one row. |
| Action | `<tab>:action.<name>` | `admin.users:action.add` | A button or API operation. **`<tab>:action.view` makes the tab visible.** |
| View | `<tab>:view.<name>` | `doc.indent:view.approved` | A status filter (list chip). Lists only return statuses whose view key the user holds. |

- **Effective permissions** = keys visible to the tenant ∩ ((union of the user's role grants ∪ the user's own *allow*
  overrides) − the user's *deny* overrides).
- **Visible to the tenant** = the key's `requires_feature` is in the tenant's plan (after overrides) **and** its
  `requires_setting` (a `flow.*` switch) is on. Keys that fail either never appear on the permission screen and are
  never effective, even if granted.
- **Tenant admins** (`is_tenant_admin`) hold every visible key automatically.
- **No privilege escalation:** a non-admin can only grant keys they hold themselves.
- **Field access** (per form field: editable, read-only, hidden) and **data scope** (which locations) are set on the
  same screen; see the [admin guide](admin-guide.md#permission-levels).
- Effective permissions are cached in Redis per user and invalidated on any change (roles, grants, scopes, field access,
  plan, overrides, `flow.*` settings, workflow publish).
- The API answers `403 FORBIDDEN` for a missing key, `404 FEATURE_NOT_IN_PLAN` for a route whose plan feature is off,
  and `404 NOT_FOUND` for a record outside the caller's data scope.

## Shipped keys (all tenants)

83 rows. The *Feature* column is the plan feature the key needs (`–` = always available). *Checked by* lists the API
endpoints that require the key (from the `@Requires` decorators and the runtime checks).

### Work

**Approvals** — tab `approvals`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `approvals:action.view` | action | See my approvals inbox | – | `GET /approvals`; `GET /approvals/counts` |

### Insights

**Reports** — tab `reports` — requires feature `reports`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `reports:action.view` | action | View reports | `reports` | `GET /reports/sources`; `GET /reports`; `POST /reports/preview`; `GET /reports/:id`; `POST /reports`; `PUT /reports/:id`; `DELETE /reports/:id`; `POST /reports/:id/run`; `POST /reports/:id/schedules`; `GET /reports/:id/schedules`; `DELETE /reports/:id/schedules/:scheduleId` |
| `reports:action.export` | action | Export reports | `reports` | `POST /exports` (kind `report`); report schedules run with it |
| `reports:action.schedule` | action | Schedule reports by email | `reports` | `POST /reports/:id/schedules`; `GET /reports/:id/schedules`; `DELETE /reports/:id/schedules/:scheduleId` |
| `reports:action.build` | action | Build custom reports | `report_builder` | `POST /reports/preview`; `POST /reports`; `PUT /reports/:id`; `DELETE /reports/:id` |
| `reports:action.share` | action | Share reports with roles | `report_builder` | `POST/PUT /reports` with shared roles; `POST/PUT /dashboards` with shared or default roles |

**Dashboards** — tab `dashboards`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `dashboards:action.view` | action | View dashboards | – | `GET /dashboards`; `GET /dashboards/:id`; `POST /dashboards`; `PUT /dashboards/:id`; `DELETE /dashboards/:id` |
| `dashboards:action.edit` | action | Design dashboards | – | `POST /dashboards`; `PUT /dashboards/:id`; `DELETE /dashboards/:id` |

### Store

**Stock** — tab `stock` — requires feature `store`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `stock:action.view` | action | View stock and ledger | `store` | `GET /stock/balances`; `GET /stock/ledger`; `GET /stock/items/:itemId/summary`; `GET /stock/reorder`; `GET /stock/valuation` |
| `stock:action.view_value` | action | See stock values | `store` | `GET /stock/valuation` |
| `stock:action.opening` | action | Post opening balances | `store` | `POST /stock/opening` |
| `stock:action.reorder` | action | Manage re-order levels | `store` | `GET /stock/reorder-rules`; `GET /stock/reorder-rules/:id`; `POST /stock/reorder-rules`; `PUT /stock/reorder-rules/:id`; `DELETE /stock/reorder-rules/:id` |
| `stock:action.block` | action | Block / unblock stock | `store` | `POST /stock/block` |
| `stock:view.available` | view | Available | `store` | Rows of status *available* in `GET /stock/balances`, `/stock/ledger` and stock report sources |
| `stock:view.quarantine` | view | Quarantine / blocked | `store` | Rows of status *quarantine* (same endpoints) |
| `stock:view.rejected` | view | Rejected | `store` | Rows of status *rejected* (same endpoints) |

### Configuration

**Forms** — tab `config.forms` — requires feature `form_builder`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `config.forms:action.view` | action | View form designs | `form_builder` | `GET /config/forms`; `GET /config/forms/:formKey`; `GET /config/forms/:formKey/versions`; `GET /config/forms/:formKey/versions/:version` |
| `config.forms:action.edit` | action | Edit form drafts | `form_builder` | `POST /config/forms/validate`; `PUT /config/forms/:formKey/draft`; `DELETE /config/forms/:formKey/draft` |
| `config.forms:action.publish` | action | Publish forms | `form_builder` | `POST /config/forms/:formKey/publish` |

**Master designer** — tab `config.masters` — requires feature `form_builder`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `config.masters:action.view` | action | View master designs | `form_builder` | `GET /masters` lists every master (not only those the caller can view) |
| `config.masters:action.add` | action | Create master | `form_builder` | `POST /config/masters` |
| `config.masters:action.edit` | action | Edit master settings | `form_builder` | `PUT /config/masters/:key`; `POST /config/masters/:key/deactivate`; `POST /config/masters/:key/activate` |

**Document types** — tab `config.doc_types` — requires feature `form_builder`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `config.doc_types:action.view` | action | View document types | `form_builder` | `GET /doc-types` lists every type (not only those the caller can view) |
| `config.doc_types:action.add` | action | Create document type | `form_builder` | `POST /config/doc-types` |
| `config.doc_types:action.edit` | action | Edit document type | `form_builder` | `PUT /config/doc-types/:key`; `POST /config/doc-types/:key/deactivate`; `POST /config/doc-types/:key/activate` |

**Numbering series** — tab `config.numbering`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `config.numbering:action.view` | action | View numbering series | – | `GET /config/numbering`; `GET /config/numbering/:id/preview` |
| `config.numbering:action.edit` | action | Edit numbering series | – | `POST /config/numbering`; `PUT /config/numbering/:id` |

**Workflows** — tab `config.workflows` — requires feature `workflow_designer`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `config.workflows:action.view` | action | View workflows | `workflow_designer` | `GET /config/workflows`; `GET /config/workflows/:docType`; `GET /config/workflows/:docType/versions`; `GET /config/workflows/:docType/versions/:v`; `POST /config/workflows/:docType/simulate` |
| `config.workflows:action.edit` | action | Edit workflow drafts | `workflow_designer` | `PUT /config/workflows/:docType/draft`; `DELETE /config/workflows/:docType/draft` |
| `config.workflows:action.publish` | action | Publish workflows | `workflow_designer` | `POST /config/workflows/:docType/publish` |

**Templates** — tab `config.templates`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `config.templates:action.view` | action | View templates | – | `GET /config/whatsapp-templates`; `GET /config/templates`; `GET /config/templates/context-fields`; `POST /config/templates/preview`; `POST /config/templates/:id/test-pdf` |
| `config.templates:action.edit` | action | Edit templates | – | `POST /config/templates`; `PUT /config/templates/:id`; `DELETE /config/templates/:id` |

**Notification rules** — tab `config.triggers`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `config.triggers:action.view` | action | View rules | – | `GET /config/triggers`; `GET /config/triggers/events`; `GET /config/triggers/:id` |
| `config.triggers:action.edit` | action | Edit rules | – | `POST /config/triggers`; `PUT /config/triggers/:id`; `DELETE /config/triggers/:id` |

**Webhooks & API** — tab `config.webhooks` — requires feature `api_access`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `config.webhooks:action.view` | action | View webhooks | `api_access` | `GET /config/webhooks`; `GET /config/webhooks/:id`; `GET /config/webhooks/:id/deliveries` |
| `config.webhooks:action.edit` | action | Manage webhooks | `api_access` | `POST /config/webhooks`; `PUT /config/webhooks/:id`; `DELETE /config/webhooks/:id`; `POST /config/webhooks/:id/test` |

### Administration

**Users** — tab `admin.users`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `admin.users:action.view` | action | View users | – | `GET /users`; `GET /users/:id`; `GET /users/:id/effective-permissions` |
| `admin.users:action.add` | action | Add user | – | `POST /users` |
| `admin.users:action.edit` | action | Edit user | – | `PUT /users/:id` |
| `admin.users:action.deactivate` | action | Deactivate / activate | – | `POST /users/:id/deactivate`; `POST /users/:id/activate` |
| `admin.users:action.reset_password` | action | Reset password / unlock | – | `POST /users/:id/reset-password`; `POST /users/:id/unlock` |
| `admin.users:action.force_logout` | action | View sessions / force logout | – | `GET /users/:id/sessions`; `POST /users/:id/force-logout` |
| `admin.users:action.manage_permissions` | action | Set user permissions | – | `GET /permissions/registry` (this or the roles key); `GET /users/:id/permissions`; `PUT /users/:id/permissions/tabs/:tabKey`; `PUT /users/:id/scope`; `PUT /users/:id/roles` |
| `admin.users:view.active` | view | Active | – | `GET /users?view=active`; users report source |
| `admin.users:view.inactive` | view | Inactive | – | `GET /users?view=inactive`; users report source |

**Roles** — tab `admin.roles`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `admin.roles:action.view` | action | View roles | – | `GET /roles` |
| `admin.roles:action.add` | action | Add role | – | `POST /roles` |
| `admin.roles:action.edit` | action | Edit role | – | `PUT /roles/:id`; `POST /saved-views (sharing to roles)` |
| `admin.roles:action.delete` | action | Delete role | – | `DELETE /roles/:id` |
| `admin.roles:action.manage_permissions` | action | Set role permissions | – | `GET /permissions/registry` (this or the users key); `GET /roles/:id/permissions`; `PUT /roles/:id/permissions/tabs/:tabKey`; `PUT /roles/:id/scope` |

**Locations** — tab `admin.locations`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `admin.locations:action.view` | action | View locations | – | `GET /locations` and `GET /locations/tree` with `scope=all` (the default) |
| `admin.locations:action.add` | action | Add location | – | `POST /locations` |
| `admin.locations:action.edit` | action | Rename / edit | – | `PUT /locations/:id` |
| `admin.locations:action.move` | action | Move | – | `POST /locations/:id/move` |
| `admin.locations:action.deactivate` | action | Deactivate / delete | – | `POST /locations/:id/deactivate`; `POST /locations/:id/activate`; `DELETE /locations/:id` |
| `admin.locations:view.active` | view | Active | – | `GET /locations*?view=active` (always allowed with `scope=mine`) |
| `admin.locations:view.inactive` | view | Inactive | – | `GET /locations*?view=inactive` |

**Settings** — tab `admin.settings`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `admin.settings:action.view` | action | View settings | – | `GET /config/settings` |
| `admin.settings:action.edit` | action | Change settings and labels | – | `PUT /config/settings`; `PUT /config/labels` |

**Usage** — tab `admin.usage`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `admin.usage:action.view` | action | View plan usage | – | `GET /tenant/usage` |

**Audit log** — tab `admin.audit`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `admin.audit:action.view` | action | View audit log | – | `GET /audit`; `GET /audit/checks` |
| `admin.audit:action.verify` | action | Run tamper check | – | `POST /audit/checks` |

**Message log** — tab `messages`

| Key | Kind | Label | Feature | Checked by (API) |
| --- | --- | --- | --- | --- |
| `messages:action.view` | action | View sent messages | – | `GET /messages` |
| `messages:action.retry` | action | Retry failed messages | – | `POST /messages/:id/retry` |

## Generated keys: masters

Created when a master is created (system masters when the tenant is provisioned). Group label **Masters**.
`<key>` is the master key, for example `item`, `vendor`, `uom`, `terms`, `payment_terms`, `department`, `tax_code` or
any tenant master such as `item_category`.

| Key | Kind | Label | Checked by (API) |
| --- | --- | --- | --- |
| `master.<key>` | tab | *Plural name* (e.g. "Items") | – |
| `master.<key>:action.view` | action | View *plural* | `GET /masters/:key/records`, `GET …/records/:id`, `GET …/records/:id/usage` |
| `master.<key>:action.add` | action | Add *name* | `POST /masters/:key/records` |
| `master.<key>:action.edit` | action | Edit *name* | `PUT /masters/:key/records/:id` |
| `master.<key>:action.deactivate` | action | Deactivate / activate | `POST …/records/:id/deactivate`, `…/activate` |
| `master.<key>:action.delete` | action | Delete *name* | `DELETE /masters/:key/records/:id` (soft delete; blocked with `409 RECORD_IN_USE` when referenced) |
| `master.<key>:action.import` | action | Import | `GET /masters/:key/template.xlsx`, `POST /masters/:key/import` |
| `master.<key>:action.export` | action | Export | `GET /masters/:key/export`, `POST /exports` (kind `master`) |
| `master.<key>:view.active` | view | Active | record list `view=active` |
| `master.<key>:view.inactive` | view | Inactive | record list `view=inactive` |

## Generated keys: document types

Created for every document type: tenant types made in **Configuration → Document types** and the system types
installed for plan modules. Group label **Modules**; the tab is location-scoped (data scope applies to every list,
detail and action). For system types the tab and keys require the module's plan feature.

### Static keys (every type)

| Key | Kind | Label | Checked by (API) |
| --- | --- | --- | --- |
| `doc.<type>` | tab | *Plural name* | – |
| `doc.<type>:action.view` | action | View *plural* | `GET /docs/:type`, `/counts`, `/:id`, `/:id/timeline`, `/:id/comments`, `/:id/attachments`, `/:id/messages`; `POST /exports` (kind `list`) |
| `doc.<type>:action.add` | action | Create *name* | `POST /docs/:type`; `POST /docs/:type/:id/copy` (with `copy`) |
| `doc.<type>:action.edit` | action | Edit *name* | `PUT /docs/:type/:id` (only while the status is editable and the document is not locked) |
| `doc.<type>:action.delete` | action | Delete drafts | `DELETE /docs/:type/:id` (drafts only) |
| `doc.<type>:action.submit` | action | Submit | `POST /docs/:type/:id/submit` |
| `doc.<type>:action.cancel` | action | Cancel | `POST /docs/:type/:id/cancel` (whole document or chosen lines) |
| `doc.<type>:action.close` | action | Close | `POST /docs/:type/:id/close` |
| `doc.<type>:action.copy` | action | Copy | `POST /docs/:type/:id/copy` (with `add`) |
| `doc.<type>:action.comment` | action | Comment | `POST /docs/:type/:id/comments` |
| `doc.<type>:action.attach` | action | Attach files | `POST` / `DELETE /docs/:type/:id/attachments` |
| `doc.<type>:action.print` | action | Print / PDF | `POST /docs/:type/:id/print` (with `view`) |
| `doc.<type>:action.send_email` | action | Send by email | `POST /docs/:type/:id/send/preview`, `/send` (channel email; also needs plan feature `email`) |
| `doc.<type>:action.send_whatsapp` | action | Send by WhatsApp | same, channel WhatsApp (plan feature `whatsapp`) |
| `doc.<type>:view.draft` | view | Draft | list filter |
| `doc.<type>:view.on_hold` | view | On hold | list filter |
| `doc.<type>:view.partially_approved` | view | Partially approved | list filter |
| `doc.<type>:view.approved` | view | Approved | list filter |
| `doc.<type>:view.rejected` | view | Rejected | list filter |
| `doc.<type>:view.cancelled` | view | Cancelled | list filter |
| `doc.<type>:view.closed` | view | Closed | list filter |

### Workflow stage keys (one pair per stage)

Written when a workflow is published (`source = workflow`). A stage removed in a new version keeps its keys, labelled
"(retired)", while documents on an older version still have quantity at that stage; the nightly
`workflow-retired-cleanup` job removes them afterwards.

| Key | Kind | Label | Checked by (API) |
| --- | --- | --- | --- |
| `doc.<type>:action.stage_<stage>` | action | Act on *stage name* | `POST /docs/:type/:id/actions` for that stage (plus actor rules and data scope) |
| `doc.<type>:view.waiting_<stage>` | view | *Stage status label* (default "Waiting for *stage name*") | list filter |

### Extra keys of system document types

| Type (feature) | Extra key | Label | Feature | Setting | Checked by (API) |
| --- | --- | --- | --- | --- | --- |
| `indent` (`indent`) | tab `doc.indent` | Indents | `indent` | `flow.indent.enabled` | – |
| | `doc.indent:action.log_quote` | Log vendor quotes | `vendor_quotes` | | `POST /procurement/indent-lines/:lineId/quotes`, `PUT /procurement/quotes/:quoteId` |
| | `doc.indent:action.compare` | Compare quotes | `vendor_quotes` | | `GET /procurement/indent-lines/:lineId/comparison`, `GET /procurement/items/:itemId/comparison` |
| | `doc.indent:action.short_close` | Short-close remaining quantity | `indent` | | `POST /docs/indent/:id/short-close` |
| `vendor_selection` (`vendor_quotes`) | tab `doc.vendor_selection` | Vendor Selections | `vendor_quotes` | `flow.vendor_selection.enabled` | – |
| | `doc.vendor_selection:action.over_approve` | Select more than the approved quantity | `vendor_quotes` | | `POST /procurement/selections` with over-allocated lines |
| `po` (`purchase`) | `doc.po:action.followup` | Log vendor follow-ups | `purchase` | | `POST /docs/po/:id/followups` |
| | `doc.po:action.amend` | Amend approved orders | `purchase` | | `POST` / `DELETE /docs/po/:id/amend` |
| | `doc.po:action.short_close` | Short-close remaining quantity | `purchase` | | `POST /docs/po/:id/short-close` |
| | `doc.po:action.create_direct` | Create orders without an indent | `purchase` | `flow.po.direct_allowed` | `POST /docs/po` without source lines |
| | `doc.po:view.amending` | Being amended | `purchase` | | list filter |
| | `doc.po:view.partially_received` | Partially received | `purchase` | | list filter (added when the tenant has `grn`) |
| | `doc.po:view.received` | Received | `purchase` | | list filter (added when the tenant has `grn`) |

Other keys of system types that the module endpoints check:

| Key | Checked by (API) |
| --- | --- |
| `doc.vendor_selection:action.add` | `GET /procurement/selectable-lines`, `POST /procurement/selections` (+ `…:action.submit` when `submit: true`) |
| `doc.po:action.add` | `GET /procurement/orderable-lines`, `POST /procurement/po/from-lines` |
| `doc.po:action.view` | `GET /docs/po/:id/taxes`, `GET /docs/po/:id/followups`, `GET /docs/po/:id/revisions` |
| `doc.indent:action.view` | `GET /procurement/indent-lines/:lineId/quotes` |
| `doc.grn:action.add` | `GET /inventory/receivable-po-lines`, `POST /inventory/grn/from-po` |
| `doc.rtv:action.add` | `GET /inventory/returnable-grn-lines`, `POST /inventory/rtv/from-grn` |
| `doc.store_issue:action.add` | `GET /inventory/issuable-lines`, `POST /inventory/issues/from-requests` |
| `doc.store_return:action.add` | `GET /inventory/returnable-lines`, `POST /inventory/returns/from-issues` |
| `doc.stock_count:action.add` | `POST /stock/counts/snapshot` |

### System document types and their default stages

All are installed per tenant by the module installers (on tenant creation, by the seed, and by the `provisioning`
job on every API start for existing tenants). Each type gets the static keys above plus these stage keys.

| Type key | Name | Feature | Default number pattern | Default stages (stage keys) |
| --- | --- | --- | --- | --- |
| `indent` | Indent | `indent` | `IND/{FYS}/{SEQ:5}` | `verify` Verification |
| `vendor_selection` | Vendor Selection | `vendor_quotes` | `VS/{FYS}/{SEQ:5}` | `approve` Selection approval |
| `po` | Purchase Order | `purchase` | `PO/{FYS}/{SEQ:5}` | `approve` PO approval |
| `grn` | Goods Receipt | `grn` (needs `store` too) | `GRN/{FYS}/{SEQ:5}` | `gate` Gate entry check → `store` Store verification → `quality` Quality check → `disposition` Store disposition |
| `rtv` | Return to Vendor | `grn` (needs `store` too) | `RTV/{FYS}/{SEQ:5}` | `approve` Return approval |
| `issue_request` | Issue Request | `store` | `IR/{FYS}/{SEQ:5}` | `approve` Request approval |
| `store_issue` | Store Issue | `store` | `ISS/{FYS}/{SEQ:5}` | `approve` Issue approval |
| `store_return` | Store Return | `store` | `SRT/{FYS}/{SEQ:5}` | `approve` Return approval |
| `stock_transfer` | Stock Transfer | `store` | `STR/{FYS}/{SEQ:5}` | `approve` Transfer approval |
| `stock_adjustment` | Stock Adjustment | `store` | `SADJ/{FYS}/{SEQ:5}` | `approve` Adjustment approval |
| `stock_count` | Stock Count | `store` | `SCNT/{FYS}/{SEQ:5}` | `approve` Count approval |

So, for example, the GRN stage keys are `doc.grn:action.stage_gate`, `…stage_store`, `…stage_quality` and
`…stage_disposition`, with views `doc.grn:view.waiting_gate` and so on.

## Endpoints with no permission key

These need only a signed-in tenant user (data scope and record ownership still apply):

`GET /auth/me`, `/auth/sessions`, `GET /doc-types`, `GET /masters`, `GET /forms/:formKey/render`,
`GET /users/options`, `GET /masters/:key/options` (dropdown feed; field access still applies), `GET /config/labels`, `GET /notifications`, `POST /notifications/:id/read`,
`/saved-views` (personal views), `POST /files`, `GET /files/:id`, `GET /pdf-jobs/:id` (requester only),
`GET /exports`, `GET /exports/:id` (requester only), `GET /dashboards/mine`, `POST /dashboards/widgets/:widgetId/data`
(needs access to the widget's report or document type), `GET /locations?scope=mine`.

Super Admin endpoints (`/platform/*`) use platform roles (`owner`, `support`, `billing`), not permission keys; see the
[API guide](api.md#platform-super-admin).
