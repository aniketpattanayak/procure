# Administrator guide

For the two kinds of administrator:

- **Super Admin** (the platform team) works in the platform console at `/platform` and manages tenants, plans,
  entitlements, message providers and support access.
- **Tenant Admin** (a company's administrator) works in the tenant workspace and configures everything about their
  company: users, roles and permissions, locations, forms and masters, document types, numbering, workflows,
  notifications, reports and stock rules.

Nothing in the product is tenant-specific code: every difference between companies is a setting, a form field, a
workflow or a permission. Reference tables: [settings](settings-reference.md), [permissions](permissions-reference.md),
[API](api.md).

---

## Part 1 — Super Admin

Sign in at `/platform/login`. Platform users have one of three roles:

| Role | Can |
| --- | --- |
| `owner` | Everything, including message providers, the WhatsApp catalogue and archiving tenants |
| `support` | Create and edit tenants, reset a tenant admin's password, impersonate, suspend / reactivate |
| `billing` | Plans, overrides, subscriptions, suspend / reactivate |

Everyone on the platform team can read tenants, plans, usage and the platform audit log.

### Plans, features and limits

**Plans** (`/platform/plans`) bundle **features** (switch on modules and capabilities) and **limits** (numbers).
Creating or editing a plan needs `owner` or `billing`; saving a plan refreshes entitlements for every tenant on it.

Features (from `platform.feature_catalog`):

| Key | Name | Kind | What it unlocks |
| --- | --- | --- | --- |
| `indent` | Indent | module | Purchase requisitions |
| `vendor_quotes` | Vendor quotes & selection | module | Quote log, comparison, vendor selection |
| `purchase` | Purchase orders | module | POs, follow-ups, amendments |
| `grn` | Goods receipt | module | GRN and verification chain, returns to vendor. With `store` the default chain posts stock; without `store` GRN / RTV use a stock-less default chain that still tracks receipts on the PO |
| `store` | Store & inventory | module | Stock ledger, transfers, adjustments, counts, issue / return |
| `reports` | Reports | module | Ready-made reports and dashboards |
| `report_builder` | Report builder | capability | Design and share custom reports |
| `form_builder` | Form builder | capability | Edit forms, create masters and document types |
| `workflow_designer` | Workflow designer | capability | Edit and publish approval workflows |
| `pdf_templates` | PDF templates | capability | More than one PDF layout per document type |
| `email` | Email | channel | Email sending |
| `whatsapp` | WhatsApp | channel | WhatsApp Business sending |
| `api_access` | API & webhooks | capability | Outgoing webhooks. *REST API keys: coming soon* (no API-key authentication exists yet) |
| `two_factor` | Two-factor login (coming soon) | capability | **Coming soon** — not implemented; enabling it on a plan has no effect |

Limits (from `platform.limit_catalog`; empty value = unlimited):

| Key | Name | Meter | Enforced when |
| --- | --- | --- | --- |
| `max_users` | Active users | live count | Creating or activating a user |
| `max_locations` | Locations | live count | Adding or activating a location |
| `custom_forms` | Custom forms / masters | live count | Creating a master or document type |
| `whatsapp_per_month` | WhatsApp messages / month | monthly | Each send (message stored as `blocked_limit` when over) |
| `whatsapp_templates` | WhatsApp templates | live count | Allowing templates for the tenant |
| `email_per_month` | Emails / month | monthly | Each send |
| `storage_gb` | Storage | lifetime | Each upload |
| `api_calls_per_month` | API calls / month (coming soon) | monthly | **Coming soon** — not metered or enforced |
| `webhook_endpoints` | Webhook endpoints | live count | Creating a webhook endpoint |

> **Coming soon (catalogue honesty).** `two_factor`, `api_calls_per_month` and the "REST API keys" part of
> `api_access` are listed in the catalogue (labelled *coming soon* by migration `0020`) but have no implementation:
> there is no second sign-in factor, no API-key authentication and no API-call metering. Don't sell them in plans yet.

Monthly meters reset by calendar month in the tenant's time zone. Tenant admins receive in-app warnings at 80 % and
100 %.

### Tenants

`/platform/tenants` lists tenants with plan, subscription status, renewal and active users / limit.

**Create a tenant** (`owner` or `support`): the wizard asks for code (2–31 lowercase letters, digits, hyphens; used
at sign-in), name, plan, subscription status and dates, and the first admin's name and email. In one transaction the
platform creates the tenant, the subscription, the system role *Company administrator* (`tenant_admin`) and the admin
user with a **temporary password shown once** (the admin must change it at first sign-in). Every tenant also gets the
system masters (Items, Vendors, Units of Measure, Terms & Conditions, Payment Terms, the user form); the `standard`
bundle adds starter roles (Requester, Buyer, Approver, Store keeper) and sample units. Module installers then add the
system document types for the plan's modules.

On the tenant detail page:

| Action | Who | Effect |
| --- | --- | --- |
| Edit profile | owner, support | Name, legal name, GSTIN, PAN, address, logo, **time zone, currency, financial-year start month** |
| Suspend | owner, support, billing | Blocks every user immediately and revokes all sessions. Reason required. |
| Reactivate | owner, support, billing | Lifts a suspension. |
| Archive | owner | Permanently closes the tenant; revokes sessions. |
| Change subscription | owner, billing | Closes the current subscription row and opens a new one (plan, status `trial` / `active` / `grace` / `expired` / `suspended`, renewal). `expired` or `suspended` subscriptions block sign-in. |
| Reset admin password | owner, support | New temporary password for the tenant admin. |
| WhatsApp tab | owner | Which catalogue templates the tenant may use. |

### Overrides

On the tenant's **Entitlements** panel, change any feature (on/off) or limit (number or unlimited) for this tenant
only (`owner`, `billing`). A reason is required; the full history (old value, new value, who, when, why) is kept and
shown. Remove an override to fall back to the plan. Overrides take effect on the tenant's next request.

### Impersonation (support access)

**Login as tenant** (`owner`, `support`) opens the tenant workspace as its admin. You must give a reason. The session:

- lasts at most 60 minutes and is never refreshed;
- shows a banner in the tenant UI, with **Exit** back to the tenant page;
- is recorded on the platform audit log *and* the tenant's audit log (entries show "by &lt;your name&gt;");
- cannot change the admin's password.

Review impersonation sessions against support tickets weekly (platform **Audit**).

### Usage

`/platform/usage` shows every tenant's limits with used vs effective values. The tenant's own **Usage** page shows the
same data for that tenant.

### Message providers and WhatsApp catalogue (owner)

- **Message providers** (`/platform/providers`): one platform default per channel plus optional per-tenant overrides.
  Email: `ses` (region, from address / name, reply-to, configuration set; secret `accessKeyId`, `secretAccessKey`),
  `smtp` (host, port, secure, username, from; secret password) or `log`. WhatsApp: `meta` (phone number id, API
  version; secret `accessToken`, `appSecret`, `verifyToken`), `bsp` (generic HTTP: URL, headers, auth header and
  scheme; secret token) or `log`. Secrets are write-only and stored encrypted. `log` providers never send; they write
  to the message log (and a folder on disk for development).
- **WhatsApp templates** (`/platform/whatsapp-templates`): the catalogue of approved Meta templates (name, language,
  category, header kind, body with `{{n}}` variables, status). Allow templates per tenant on the tenant's WhatsApp tab.

### Platform audit

`/platform/audit` lists every platform action (tenants, plans, overrides, impersonation …), hash-chained like the
tenant logs.

---

## Part 2 — Tenant Admin

Sign in at `/login` with your company code, email and password. Tenant admins hold every permission the plan allows;
other users see only what their roles grant.

The sidebar groups: **Dashboard, Reports, Exports** · **Modules** (approvals inbox, your own document types) ·
**Procurement** · **Stores** · **Masters** · **Configuration** · **Administration**. Entries you cannot use are
hidden, not disabled.

### Users

**Administration → Users** (`/users`).

| Task | How | Permission |
| --- | --- | --- |
| Add a user | **New user**: name, email, phone, admin flag and any custom user fields. A temporary password is shown once; the user changes it at first sign-in. Counts against `max_users`. | `admin.users:action.add` |
| Edit | Open the user, **Edit** | `admin.users:action.edit` |
| Deactivate / activate | Deactivate revokes all sessions; activate counts against the limit | `admin.users:action.deactivate` |
| Reset password / unlock | New temporary password; unlock after failed sign-ins | `admin.users:action.reset_password` |
| Sessions / force logout | See and end a user's sessions | `admin.users:action.force_logout` |
| Roles and access | **Access** link on the user: roles, user-level overrides, data scope, "why" panel | `admin.users:action.manage_permissions` |

Active and inactive lists are separate status views (`admin.users:view.active` / `view.inactive`).
Add custom fields to users (for example employee code, department) by editing the `user` form in the form builder;
the *reporting manager* field is used by workflow actor rules.

### Roles

**Administration → Roles** (`/roles`). A role is a named set of permission keys plus a data scope. Users can hold
several roles; their permissions add up. The system role *Company administrator* cannot be deleted; a role that still
has users cannot be deleted either.

### Permission levels

Open a role (or a user's **Access** page) to get the permission workbench. Permissions are set per **tab**, in five
levels:

| Level | What it controls | Example |
| --- | --- | --- |
| 1. Tab | Whether the screen/module appears. Granting `<tab>:action.view` shows it. | `doc.indent` — Indents |
| 2. Buttons (actions) | Each operation inside the tab | `doc.indent:action.submit`, `doc.po:action.amend`, `doc.grn:action.stage_quality` (act on the Quality check stage) |
| 3. Filters (status views) | Which statuses the user can list and open | `doc.po:view.approved`, `doc.indent:view.waiting_verify` |
| 4. Data scope | Which locations' records the user sees and acts on | "Pune Plant and everything below it" |
| 5. Field access | Per form field: editable, read-only or hidden | Hide `rate` on the indent line for requesters |

How it fits together:

- The tab list on the left is grouped (Work, Insights, Store, Modules, Masters, Configuration, Administration) with a
  count of granted keys. Pick a tab; the right pane shows **Buttons**, **Filters / status views** and **Field
  access** for each form used by the tab. Save per tab. Leaving with unsaved changes asks to save, discard or stay.
- **Users:** role grants show as read-only ticks with the role name. Each key can be set to *Inherit*, *Allow* or
  *Deny* for this user only; deny wins over every role. The **Why** tab explains the source of every effective key.
- **Data scope** (Scope tab): *All locations*, or ticks on the location tree with "include sub-locations" per node,
  optionally narrowed for one tab. Records outside the scope do not exist for the user (lists skip them, links answer
  "not found"). Documents are scoped by their location; stock by the stock location.
- **Field access:** when several roles disagree, the most restrictive wins; a user-level setting overrides roles.
  Hidden fields are removed from screens, API responses, reports, exports, PDFs and messages rendered for that user;
  writes that change a read-only or hidden field are refused.
- Keys are only offered when the tenant's plan has the feature and the related `flow.*` setting is on.
- You can only grant keys you hold yourself (tenant admins hold all).
- Changes apply on the user's next request; no sign-out needed.

Full key list: [permissions reference](permissions-reference.md).

### Location tree

**Administration → Locations** (`/locations`). An unlimited tree (plant → store → bin, region → site …). Name the
levels in **Settings → Labels** (`labels.location_levels`).

- Add root or child nodes with a code and name; edit, **move** (pick the new parent; a node cannot move under its own
  branch), deactivate (cascades to the whole branch; activation requires an active parent) or delete (only a leaf that
  nothing references; otherwise the dialog lists where it is used).
- Active nodes count against `max_locations`.
- Locations drive data scope, numbering series, the location on every document, receiving and stock locations, and
  report filters. Users pick their working location in the top bar; lists default to it.

### Settings and labels

**Administration → Settings** (`/settings`): grouped as Security, Flow, Procurement rules, Stock, Labels and Other.
Each row shows its default and can be reset. Every key is listed in the [settings reference](settings-reference.md).
The **Labels** tab renames level names and any UI wording (search the text, type your wording, preview it).

The **Flow** switches shape the purchase process:

| You want | Set |
| --- | --- |
| Indent → quotes → vendor selection → PO (default) | `flow.indent.enabled` on, `flow.vendor_selection.enabled` on |
| Indent → PO (buyer picks vendor and rate on the PO) | `flow.vendor_selection.enabled` off |
| POs without any indent | `flow.po.direct_allowed` on, then grant `doc.po:action.create_direct` |
| Store issues only against approved issue requests | `flow.issue.without_indent` off |

### Form builder

**Configuration → Forms** (`/config/forms`; feature `form_builder`). Every master, the user profile and every
document type's header and line form are forms.

- Drag fields from the palette onto the canvas, set properties on the right, preview, then **Publish**. Drafts save
  even with issues; publishing is blocked until the issues list is empty. Each publish creates a new version; records
  keep the version they were saved with.
- Field types: text, textarea, number, decimal, currency, percentage, date, time, datetime, date range, select,
  multi-select, radio, checkbox, toggle, lookup, multi-lookup, formula, file, image, files, signature, email, phone,
  URL, GSTIN, PAN, regex, grid (repeating rows), plus layout elements tab, section, divider and help text.
- Rules per field: required, read-only, hidden, unique, min/max, length, pattern, precision, default, and conditional
  `visibleWhen`, `requiredWhen`, `readOnlyWhen`, `minDate`, `maxDate` written as formulas.
- **System fields** (marked) cannot be removed or retyped. A field's type cannot change once published; add a new field
  instead. Removing a field hides it in new versions but keeps its data.
- Validation runs on the server too: types, ranges, GSTIN/PAN check digits, lookups (exists, active, matches the
  cascade), files (clean, type, size), formulas recomputed server-side.

### Masters and cascades

**Configuration → Master designer** (`/config/masters`) creates tenant masters (for example Item Category, Item
Sub-category, Brand, Cost Centre). Each master gets a form, records under **Masters → &lt;name&gt;**
(`/masters/<key>`), and its own permission keys (`master.<key>:*`). Settings: auto-code pattern, labels for code and
name, default sort, list columns, show in menu. Creating a master counts against `custom_forms`. System masters
(item, vendor, uom, terms, payment terms, department, tax code) cannot be deactivated but can receive extra fields.

**Lookups and cascades.** A lookup field takes its options from a master, the location tree or users. To make a
cascade (Category → Sub-category → Item), give the child lookup a **filter by**: "show records whose
`<target field>` equals this form's `<field>`". Chains can be any depth and work inside grid rows. **Autofill** copies
values from the chosen record (for example item → unit of measure, item → tax code) always or only when empty.

**Records:** add, edit, deactivate / activate, delete (blocked when the record is used; deactivate instead), view
usage, import (download the template, upload CSV/XLSX up to 5,000 rows and 5 MB, check first with a dry run, then
commit; all-or-nothing; lookups by code) and export (CSV/XLSX).

### Formulas

Formula fields, conditions and workflow `when` rules use one safe expression language
([formula language](../contracts/formula-language.md)), evaluated identically in the browser and on the server:

```
amount   = qty * rate                               (line column)
total    = SUM(lines.amount) + freight - discount
discount = IF(SUM(lines.qty) >= 1000, SUM(lines.amount) * 0.10, 0)
due_on   = ADD_DAYS(TODAY(), vendor.credit_days)
visibleWhen on justification:  priority = 'Urgent'
```

Use `lookup.attribute` to read a field of the chosen record (`vendor.gstin`, `item.uom`), aggregates over grid
columns (`SUM`, `AVG`, `MIN`, `MAX`, `COUNT`, `SUMIF`, `COUNTIF`), and functions such as `IF`, `IFS`, `ROUND`,
`COALESCE`, `ISBLANK`, `TODAY`, `DAYS_BETWEEN`, `ADD_DAYS`, `CONCAT`, `CONTAINS`, `TEXT`. The editor autocompletes,
checks types and cycles, and has a test panel.

### Document types

**Configuration → Document types** (`/config/doc-types`; feature `form_builder`) creates your own transaction types,
for example *Capex Request* or *Service Request*: name, plural, key, header-only or header + item lines, number
pattern. The type gets a header form (`<key>_header`) and optionally a line form (`<key>_line`) with system fields
(location, dates, total; item, unit, qty, rate, amount), a default numbering series, permission keys and a sidebar
entry under Modules. Counts against `custom_forms`. Settings: name, number label, menu visibility and icon, default
document-wise and item-wise list columns, which statuses are editable, and whether lines can be cancelled
individually.

System types (indent, vendor selection, PO, GRN, RTV, issue request, store issue, store return, stock transfer, stock
adjustment, stock count) are installed by their modules; you can add fields to their forms and edit their workflows,
but not remove their system fields.

### Numbering series

**Configuration → Numbering** (`/config/numbering`). One or more series per document type:

- Pattern tokens: `{PREFIX}` (type key in capitals), `{LOC}` (location code), `{FY}` (2026-27), `{FYS}` (26-27),
  `{YYYY}`, `{YY}`, `{MM}`, `{SEQ:n}` (sequence padded to *n* digits, required). Other text is kept as typed.
  Example: `PO/{LOC}/{FYS}/{SEQ:5}` → `PO/PUNE/26-27/00042`.
- Reset: never, every financial year (uses the tenant's FY start month) or every month.
- Location: a series can apply to one location (and below). The document uses the most specific active series at its
  location or nearest ancestor, else the all-locations series. "Which series applies?" checks a location for you.
- Numbers are assigned at submit, never skip or collide, and editing a pattern never renumbers issued documents.

### Workflow designer

**Configuration → Workflows** (`/config/workflows`; feature `workflow_designer` to edit). One workflow per document
type, drawn as a lane from *Document submitted* to *Approved*. Edit the draft, **Simulate**, then **Publish**.
Documents already running stay on the version they started with.

**Granularity** (workflow panel): *line* = approvers decide quantities per line; *document* = one decision for the
whole document.

**Stage settings:**

| Setting | Meaning |
| --- | --- |
| Name, key, status label | Key is locked after publish; the status label is what lists show while documents wait here (default "Waiting for &lt;name&gt;") |
| Enabled | Disabled stages are skipped |
| Condition (`when`) | Formula over header fields and line aggregates, e.g. `total_amount > 100000`, `COUNTIF(lines.requires_qc = TRUE) > 0`. False → stage skipped |
| Actors | Any of: a role, named users, the submitter's reporting manager, a user chosen in a header field. Empty = anyone holding the stage permission. Every actor must also hold `doc.<type>:action.stage_<key>` and have the document's location in scope |
| Quorum | *Any* = the first eligible decision completes the stage; *All* (needs role or user actors) = every actor decides; the approved quantity is the minimum, any reject rejects |
| Allow self-approval | Off by default: the submitter cannot approve their own document |
| If no actor | *Assign admins* (default) or *Skip* (logged) |
| Actions | approve, partial (split decisions), reject, hold, send back, forward |
| Require reason on | Default: reject, hold, send back and reductions (partial) |
| Editable line fields | Line fields approvers may change while deciding (for example rate) |
| SLA | Hours (wall-clock in tenant time), remind every *n* hours, escalate to a role / users / manager / field user once overdue |
| Effects | Automatic actions on enter, on approve, on reject (below) |

**Parallel stages:** drop a stage beside another (same row) to run them at the same time; the next row starts when
all parallel stages are done.

**Line-level decisions:** at a stage each line's pending quantity is split into *approve* (moves to the next stage,
or out as approved after the last), *hold* (stays at this stage until un-held) and *reject* (leaves). The three must
add up to the pending quantity exactly. Approving less than pending with the rest rejected is a *reduction* and
needs a reason. One line can be partly at stage 2, partly held at stage 1 and partly rejected.

**Send back and forward:** send back moves everything still in the workflow at later stages back to an earlier stage,
or returns the document to its creator as a draft. Forward assigns the stage to another user (who must be able to see
the document type and location).

**Effects** (a fixed list; ones your plan lacks are shown as "Available after …"):

| Effect | Does |
| --- | --- |
| `lock_editing` / `unlock_editing` | Lock or unlock the document for edits (submit locks by default) |
| `close_document` | Close the document |
| `notify` | In-app notification to actors, the submitter or another stage's actors, with a message |
| `emit` | Write a named event to the outbox, for notification rules and webhooks |
| `route_to` | On reject only: send the rejected quantity to another stage (e.g. quality reject → disposition) |
| `post_stock` | Post the approved quantities to stock (status available or quarantine) — GRN, issue, return, transfer, adjustment, count |
| `block_stock` / `unblock_stock` | Move quantity between available and quarantine |
| `return_to_vendor` | Create a draft return to vendor for rejected / quarantined GRN quantity |
| `generate_pdf` | Render a PDF of the document (optional template) |
| `send_email` / `send_whatsapp` | Send a template by email / WhatsApp (feature `email` / `whatsapp`) |

**Simulate** renders the header and line forms; type sample values and see which stages run, are skipped (and why)
and who would act. **Issues** (unknown roles or fields, bad conditions, unavailable effects, parallel or route
errors) block publishing. Publishing regenerates the stage permission keys and status views; grant
`doc.<type>:action.stage_<key>` to the roles that should act.

**The GRN verification chain** is a workflow like any other. The default (editable) is:

1. **Gate entry check** — approve / partial / reject / hold / send back; no stock effect. Quantity rejected here
   never enters stock and re-opens the PO line.
2. **Store verification** — on approve: `post_stock` (available).
3. **Quality check** — only when a line's item needs QC (`COUNTIF(lines.requires_qc = TRUE) > 0`); on reject:
   `block_stock` + `route_to` disposition.
4. **Store disposition** — only reached by routing; approve keeps the stock blocked for rework, reject runs
   `return_to_vendor`.

To post stock at the gate instead, move `post_stock` to the gate stage; to skip QC, disable the stage; to add a
second QC for high-value receipts, add a stage with a condition. No code changes.

### Notifications

**Templates** (`/config/templates`): Handlebars templates per channel — PDF (body, header, footer, page setup),
email (subject + body), WhatsApp (an approved catalogue template plus one expression per `{{n}}` variable) and
in-app (title + message). The placeholder pane lists every field of the chosen document type (custom fields included);
helpers: `formatDate`, `formatMoney`, `formatNumber`, `upper`, `lower`, `eq`, `ifEq`, `qrCode`, `amountInWords`.
Preview against a real document. One default template per channel and document type; more than one PDF layout per
type needs feature `pdf_templates`. Every tenant starts with starter templates: PO, indent, any-document and
return-to-vendor debit note PDFs, a **Comparison sheet** PDF for indents (not default: choose it when printing; one
table per item with every vendor's quoted / effective rate, freight, tax, landed cost, lead time and the best quote
marked), the "PO approved → email vendor" email and the "Approval pending" in-app message. Existing tenants receive
the comparison sheet automatically (idempotent install; tenant edits are never overwritten). A default rule "PO
approved → email vendor" is installed in *manual* mode.

**Notification rules** (`/config/triggers`): *When* event *on* document type *if* condition → *channel* template →
recipients. Events: document created / submitted / edited / cancelled / closed / status changed, stage entered,
decision taken, workflow completed, sent back, forwarded, SLA reminder, SLA escalation, comment, mention, plan limit
warning, quote logged, selection submitted, PO created, PO amended, PO follow-up, plus `emit` events from your
workflows. Recipients: the document's vendor (email / phone from the vendor master), the submitter, a role (optionally
only users whose scope covers the document's location), named users, a stage's actors, an email/phone/user field on
the document, or a fixed address. Optionally attach a PDF. *Automatic* rules send on the event; *manual* rules appear
as suggestions in the document's **Send** dialog.

**Email and WhatsApp** need the plan feature and a provider (set up by the Super Admin). Each send is checked against
the monthly quota; over-quota messages are logged as `blocked_limit`. WhatsApp sends only catalogue templates the
Super Admin allowed for your company. **Administration → Message log** (`/messages`) shows every message with its
delivery rail (queued → sent → delivered → read) and lets you retry failed ones (`messages:action.retry`).

**Webhooks** (`/config/webhooks`; feature `api_access`, limit `webhook_endpoints`): URL (must be public), events,
active flag. The signing secret is shown once. Send a test delivery and inspect every attempt. See the
[API guide](api.md#outgoing-webhooks) for payloads and signature verification.

### Report builder and dashboards

**Reports** (`/reports`): built-in reports (read-only; copy to customise), your own, and those shared with your roles.

Built-ins include: Pending approvals by user and stage; Documents by status and location; Audit trail; Users and
roles; Indent status & ageing; Pending procurement approvals by stage & approver; Vendor quote comparison history;
Rate history by item & vendor; PO pending delivery; PO vs GRN; Vendor performance; Purchase value by vendor, item,
location & month; Stock summary by location; Stock ledger; Item movement summary; Consumption by department &
location; Re-order / below-minimum; Expiring batches; Quarantine & rejected stock. Each appears only when the plan has
its module and the viewer can see its source.

**Builder** (`/reports/new`; `reports:action.build`, feature `report_builder`):

1. Pick a source: documents or document lines of any type, a master, or an engine source (pending approvals, audit,
   users, purchase lines, receipts, vendor quotes, PO follow-ups, stock balance, stock ledger, stock movement summary,
   consumption, re-order).
2. Drag fields onto **Columns**, **Group by**, **Filters** and **Sort**. Grouping turns numeric columns into sums;
   date fields offer month / year buckets. A filter can be exposed to viewers as a parameter ("let viewers change
   this").
3. Optional chart (bar, stacked bar, line, area, pie), totals row, default period, row limit (max 100,000).
4. Preview updates as you build; save with a name and optionally share with roles (`reports:action.share`).

Reports always respect the viewer's permissions: data scope, status views and field access are applied at run time,
so a shared report never reveals more than the viewer could see in the lists.

**Schedules** (`reports:action.schedule`): daily, weekly, monthly or a custom cron, format xlsx, csv or PDF,
recipients (users and/or email addresses). The run happens as the schedule's creator. When the file is ready, user
recipients get an in-app notification with the link, and every recipient gets an email (users at their account
address) with a signed download link valid for 7 days, sent through the tenant's email provider. Each email counts
against the plan's `email_per_month` quota; over the quota (or without the `email` feature / a provider) the message
shows as blocked in the message log and the in-app notification still arrives. PDF exports are a printable table of
the first 5,000 rows; use Excel or CSV for more.

**Dashboards** (`/dashboard`): each user opens their role's default dashboard, else their own, else the built-in
*My work* (approvals counts and document counts per type). Built-in *Procurement overview* and *Store overview* appear
for users with the right keys. Design with **Customise** (`dashboards:action.edit`): 12-column grid, widgets *KPI*
(value and change vs previous period), *chart*, *table*, *approvals counts*, *document counts* (each count links to the
filtered list). Share with roles and set role home pages (needs `reports:action.share`).

### Stock settings

| Topic | Where | Notes |
| --- | --- | --- |
| Valuation method | Settings → Stock → `stock.valuation` | WAC (weighted average per item × location) or FIFO. Fixed for a financial year once stock has moved; change it before the first movement of a new FY. |
| Negative stock | `stock.allow_negative` | Off (default): any issue, transfer or adjustment that would go below zero is refused. |
| Receipt cost | `stock.cost_includes_tax` | Value receipts at PO net rate, or net rate plus GST per unit. |
| Over-receipt | `grn.over_receipt_pct` | Tolerance above the pending PO quantity (default 5 %). |
| GRN across POs | `grn.multi_po` | One GRN for several POs of the same vendor. |
| Returns re-open POs | `rtv.reopens_po` | Returned quantity can be received again on the same PO line. |
| Issue without request | `flow.issue.without_indent` | Allow direct store issues. |
| Re-order levels | **Stores → Re-order** (`/stock/reorder`; `stock:action.reorder`) | Per item × location: minimum, re-order quantity, maximum, *auto-indent*. When a stock out takes an item below minimum, holders of `stock:action.reorder` get an in-app alert (at most once per rule per day) and the `stock.below_min` event fires; with auto-indent a draft indent line is created. |
| Opening balances | **Stores → Stock → Opening** (`/stock/opening`; `stock:action.opening`) | Paste item × location × qty × unit cost (and batch / expiry) as of a date. Allowed only for item × location pairs with no movements yet. |
| Stock values | `stock:action.view_value` | Without it users see quantities only; values and average costs are hidden everywhere, including reports. |
| Stock statuses | `stock:view.available`, `…quarantine`, `…rejected` | Which stock buckets a user may see. |
| Block / unblock | `stock:action.block` | Move quantity between available and quarantine with a reason. |
| GRN chain | Configuration → Workflows → Goods Receipt | See *The GRN verification chain* above. |

### Audit log

**Administration → Audit log** (`/audit`; `admin.audit:action.view`): every change with before/after diff, user,
time, IP and impersonation marker; filter by record type, record, user, action and dates. The **tamper check**
(`admin.audit:action.verify`) re-verifies the hash chain now; a nightly check runs automatically and alerts admins on
failure.
