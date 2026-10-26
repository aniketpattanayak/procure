# Settings reference

Every tenant setting the platform knows, taken from the code. The single source of truth is
`SettingsRegistry` in [`packages/schema/src/settings.ts`](../../packages/schema/src/settings.ts). A tenant only stores
the values it changed (table `app.tenant_setting`); every other key uses the default shown here.

- **Where to change:** web app **Administration → Settings** (`/settings`), or `PUT /api/v1/config/settings`.
- **Who can change:** `admin.settings:action.edit` (tenant admins hold it). Reading needs `admin.settings:action.view`.
- **Reset to default:** send `null` for the key (`{"stock.allow_negative": null}`), or use the reset button on the row.
- **Validation:** unknown keys and out-of-range values are rejected with `400 VALIDATION_FAILED` and one
  `errors[]` entry per bad key. Some keys also have a *guard* that can veto a change (see `stock.valuation`).
- **Audit:** every change writes one audit row with the before and after values of the keys that changed.
- **Permissions:** changing any `flow.*` key bumps the tenant's permission version, so menus and permission keys
  that depend on it appear or disappear for everyone on their next request.

## Registry keys

The *UI group* column is the tab on the Settings page (keys are grouped by prefix; keys that match no group are shown
under **Other**). *In `/auth/me`* means the value is also sent to every signed-in user so the web app can react to it.

| Key | Type and range | Default | UI group | In `/auth/me` | What it does |
| --- | --- | --- | --- | --- | --- |
| `security.password_min_length` | integer 10–64 | `10` | Security | no | Minimum length for new passwords. The platform floor (10 characters, a lowercase letter, an uppercase letter and a digit) always applies. |
| `security.max_failed_logins` | integer 3–20 | `5` | Security | no | Failed sign-ins before the account is locked (`AUTH.ACCOUNT_LOCKED`). |
| `security.lockout_minutes` | integer 1–1440 | `15` | Security | no | How long a locked account stays locked. An admin can unlock earlier (Users → Unlock). |
| `security.session_days` | integer 1–90 | `30` | Security | no | Lifetime of the refresh session (the `rt` cookie). Users must sign in again after this. |
| `labels.location_levels` | list of names (1–40 chars each) | `["Location", "Sub-location", "Division"]` | Labels | yes | Names of location-tree levels. Top-level nodes use the first name, their children the second, and so on; deeper levels reuse the last name. Edited with the level editor. |
| `flow.indent.enabled` | boolean | `true` | Flow | yes | Use indents (purchase requisitions). Off hides the Indents tab, its permission keys, and the quote/compare keys. |
| `flow.vendor_selection.enabled` | boolean | `true` | Flow | yes | Use the vendor selection step. Off hides the Vendor Selections tab and the **Select vendors** screen; POs are then created directly from approved indent lines. |
| `flow.po.direct_allowed` | boolean | `false` | Flow | yes | Allow purchase orders without a source line (indent or selection). Makes the key `doc.po:action.create_direct` available. |
| `flow.issue.without_indent` | boolean | `true` | Flow | yes | Allow store issues that do not reference an approved issue request line. |
| `selection.max_over_approval_pct` | number 0–100 | `0` | Procurement rules | yes | How far (in % of the approved quantity) a vendor selection may exceed the approved indent quantity. Needs `doc.vendor_selection:action.over_approve` and a reason. `0` = never. |
| `grn.over_receipt_pct` | number 0–100 | `5` | Procurement rules | yes | Over-receipt tolerance. A GRN line may receive up to *pending receipt × (1 + pct/100)*; more is refused with `409 QTY_EXCEEDS_REMAINING`. |
| `grn.multi_po` | boolean | `false` | Procurement rules | no | Allow one GRN to cover open lines of several POs of the same vendor. Off = one GRN per PO. |
| `procurement.landed_cost_formula` | formula text, 1–500 chars | `rate * (1 + tax_pct / 100) + freight_per_unit` | Procurement rules | no | Landed cost per unit used by the quote comparison sheet to pick the best vendor. Formula language (see [formula-language](../contracts/formula-language.md)); variables available: `rate`, `qty`, `freight`, `freight_per_unit`, `tax_pct`, `lead_time_days`, `moq`. |
| `procurement.quote_validity_days` | integer 1–365 | `30` | Procurement rules | no | Default *valid until* for a vendor quote logged without one (counted from the date it was logged). |
| `rtv.reopens_po` | boolean | `true` | Procurement rules | no | A return to vendor re-opens the PO line's pending receipt for the returned quantity (so a replacement can be received). |
| `stock.valuation` | `wac` or `fifo` | `wac` | Stock | no | Valuation method for stock outs: weighted average cost per item × location, or FIFO layers. **Fixed per financial year:** once the current financial year has any stock movement, a change is refused with `409 STOCK_VALUATION_LOCKED`. Change it at the start of a new financial year before the first movement. |
| `stock.allow_negative` | boolean | `false` | Stock | no | Allow stock to go below zero. Off = a movement that would make a balance negative is refused with `409 STOCK_NEGATIVE` (meta lists item, location, available and requested). |
| `stock.cost_includes_tax` | boolean | `false` | Stock | no | Value goods receipts at the PO net rate **plus** the line's GST per unit. Off = net rate only. |
| `stock.allow_expired_issue` | boolean | `false` | Stock | no | Allow issuing an expired batch when it is picked by name (FEFO always skips expired batches). |
| `workflow.block_self_approval` | boolean | `true` | Other | no | Segregation of duties: a submitter can never approve their own document, also when a stage reaches them by escalation, forwarding or a no-actor fallback. |

## Other tenant configuration (not registry keys)

These live elsewhere but behave like settings.

| What | Stored in | Changed by | Notes |
| --- | --- | --- | --- |
| Wording overrides (labels) | `app.tenant_setting` key `labels.<lang>` (for example `labels.en`) | `PUT /api/v1/config/labels` (`admin.settings:action.edit`); Settings → Labels | Tenant wording replaces the default text of any UI string. `null` removes an override. Sent to users in `/auth/me` as `labels`. Readable by any tenant user via `GET /config/labels?lang=`. |
| Time zone | `platform.tenant.timezone` (default `Asia/Kolkata`) | Super Admin (tenant profile) | Used for "today", SLA due times, report schedules and monthly quota periods. Sent in `/auth/me` as `tenant.timezone`. |
| Currency | `platform.tenant.currency` (default `INR`) | Super Admin | Default document currency. Sent in `/auth/me` as `tenant.currency`. |
| Financial year start | `platform.tenant.fy_start_month` (1–12, default `4` = April) | Super Admin | Drives `{FY}` / `{FYS}` numbering tokens, numbering resets and the `stock.valuation` lock. Sent in `/auth/me` as `tenant.fy_start_month`. |
| Legal name, GSTIN, PAN, address, logo | `platform.tenant` | Super Admin | Available to templates as `tenant.*` (letterheads, PO PDFs). |

## Plan features that act like switches

Plan features are not tenant settings, but they hide whole areas. They are set by the Super Admin on the plan or as a
per-tenant override. See the [admin guide](admin-guide.md#plans-features-and-limits).

| Feature key | Turns on |
| --- | --- |
| `indent` | Indent document type |
| `vendor_quotes` | Quote log, comparison, vendor selection |
| `purchase` | Purchase orders, follow-ups, amendments |
| `grn` | Goods receipts and returns to vendor (installed only when the tenant also has `store`, because the default GRN workflow posts stock) |
| `store` | Stock ledger, transfers, adjustments, counts, issue requests, issues and returns; stock workflow effects |
| `reports` | Reports and dashboards |
| `report_builder` | Building and sharing custom reports |
| `form_builder` | Form builder, master designer, custom document types |
| `workflow_designer` | Editing and publishing workflows |
| `pdf_templates` | More than one PDF template per document type |
| `email` / `whatsapp` | Channels for rules, manual sends and `send_email` / `send_whatsapp` effects |
| `api_access` | Outgoing webhooks |
| `two_factor` | In the catalogue only; no two-factor login is implemented yet |
