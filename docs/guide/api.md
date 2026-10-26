# API guide

The REST API served by `apps/api` (NestJS). Every path below is relative to the base URL
**`/api/v1`** (for example `http://localhost:4000/api/v1`), except `GET /health`, which has no prefix.

Request and response types are Zod schemas and TypeScript interfaces in
[`packages/schema/src`](../../packages/schema/src) (`@procure/schema`). The per-phase contracts in
[`docs/contracts`](../contracts) describe the behaviour of each area in detail.

> **OpenAPI / Swagger:** the API does not serve an OpenAPI document or a Swagger UI (no `@nestjs/swagger`
> dependency). Use this guide, the contracts and the `@procure/schema` types.

## Authentication

Two audiences share the same token format: **tenant users** and the **Super Admin team** (platform users).

| Step | Call | Notes |
| --- | --- | --- |
| Tenant sign-in | `POST /auth/login` `{ tenantCode, email, password }` | Returns `AuthResult` `{ accessToken, expiresIn, mustChangePassword, principal }` and sets the refresh cookie. |
| Platform sign-in | `POST /auth/platform/login` `{ email, password }` | Same result for the Super Admin team. |
| Call the API | `Authorization: Bearer <accessToken>` | Access tokens are HS256 JWTs, valid 15 minutes (`ACCESS_TOKEN_TTL_SEC`, default 900). Keep them in memory only. |
| Refresh | `POST /auth/refresh` (cookie `rt`) | Rotates the refresh token. Presenting an already-rotated token revokes the whole session family (`401 AUTH.REFRESH_REUSED`). |
| Who am I | `GET /auth/me` | Principal, plan `features`, `limits`, effective `permissions`, tenant `labels` and non-sensitive `settings`. |
| Sign out | `POST /auth/logout` | Revokes the session immediately (also for the current access token). |

Refresh cookie `rt`: httpOnly, `SameSite=Strict`, `Secure` in production (`COOKIE_SECURE`), path `/api/v1/auth`,
lifetime = tenant setting `security.session_days` (default 30). Passwords are hashed with Argon2id.

- **Forced password change.** While `mustChangePassword` is true, every route except `/auth/me`,
  `/auth/password/change` and `/auth/logout` answers `403 AUTH.PASSWORD_CHANGE_REQUIRED`.
- **Lockout.** After `security.max_failed_logins` failures (default 5) the account locks for
  `security.lockout_minutes` (default 15): `423 AUTH.ACCOUNT_LOCKED` with `meta.lockedUntil`. Platform users: 5 / 15 min.
  Wrong tenant, email or password all give the same `401 AUTH.INVALID_CREDENTIALS`.
- **Impersonation.** `POST /platform/tenants/:id/impersonate` `{ reason }` returns an `AuthResult` for the tenant admin
  with `principal.impersonatedBy` set. It lasts at most 60 minutes, cannot be refreshed, and is audited on both the
  platform and the tenant audit log.
- **Every request re-checks** (in this order): token valid and session not revoked → audience (tenant vs platform) →
  tenant active and subscription usable (`403 TENANT.SUSPENDED`, `403 TENANT.SUBSCRIPTION_INACTIVE`) → pending
  password change → plan feature (`404 FEATURE_NOT_IN_PLAN`) → platform role → permission keys (`403 FORBIDDEN`).

### Rate limits

Per client IP, per minute (Redis counters; the limiter fails open if Redis is down). Responses carry
`RateLimit-Limit` and `RateLimit-Remaining`; over the limit you get `429 RATE_LIMITED` with `Retry-After: 60`.

| Bucket | Limit |
| --- | --- |
| `POST /auth/login`, `/auth/platform/login`, `/auth/password/change` | 30 per IP |
| Login attempts per account (tenant code + email, or platform email) | 10 |
| Everything else | 1,200 per IP |

## Tenancy

- The tenant comes from the access token (`tid` claim), never from the URL or body. There is no way to address another
  tenant's data through the tenant API.
- In the database every tenant query runs as role `app_user` inside a transaction that sets `app.tenant_id`;
  row-level security returns zero rows without it (see [data model](data-model.md#row-level-security)).
- **Plan features** gate whole routes (`404 FEATURE_NOT_IN_PLAN`) and permission keys.
- **Limits** are checked when you create things: `403 LIMIT_EXCEEDED.<limitKey>` with
  `meta { limitKey, limit, used }` (for example `LIMIT_EXCEEDED.max_users`, `.max_locations`, `.custom_forms`,
  `.storage_gb`, `.webhook_endpoints`). Monthly email / WhatsApp quotas do not fail the request; the message is stored
  with status `blocked_limit`.
- **Data scope**: document, stock and location endpoints only see locations in the caller's scope. A record outside
  scope answers `404 NOT_FOUND`, not `403`.

## Errors (RFC 7807)

Errors are `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Some fields are invalid",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "errors": [{ "path": "lines.3.qty", "message": "Must be greater than 0" }],
  "meta": {}
}
```

`code` is stable (add, never rename); `title` is for humans. `errors[].path` uses form field keys
(`lines.<index>.<column>` for line fields).

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Body, query or field validation failed; malformed JSON |
| `UNAUTHENTICATED` | 401 | Missing, expired or revoked token |
| `AUTH.INVALID_CREDENTIALS` | 401 | Wrong tenant code, email or password |
| `AUTH.REFRESH_REUSED` | 401 | A rotated refresh token was presented again (session family revoked) |
| `BAD_SIGNATURE` | 401 | Provider webhook (`/hooks/*`) signature invalid |
| `AUTH.ACCOUNT_LOCKED` | 423 | Too many failed sign-ins (`meta.lockedUntil`) |
| `AUTH.PASSWORD_CHANGE_REQUIRED` | 403 | Password must be changed first |
| `TENANT.SUSPENDED` | 403 | Tenant suspended or archived |
| `TENANT.SUBSCRIPTION_INACTIVE` | 403 | Subscription expired, suspended or missing |
| `FORBIDDEN` | 403 | Permission key missing; Postgres permission denied |
| `FIELD_READ_ONLY` | 403 | A write changed a field that is read-only or hidden for the caller (`meta.field`) |
| `ACTION_NOT_ALLOWED` | 403 | Workflow action not allowed for this user or stage |
| `LIMIT_EXCEEDED.<limitKey>` | 403 | Plan limit reached |
| `FEATURE_NOT_IN_PLAN` | 404 | Route needs a plan feature the tenant does not have |
| `NOT_FOUND` | 404 | Record missing or outside the caller's data scope |
| `PAYLOAD_TOO_LARGE` | 413 | JSON body over 1 MB (uploads: 25 MB) |
| `RATE_LIMITED` | 429 | See rate limits |
| `CONFLICT` | 409 | Unique value already exists (`meta.constraint`), or other conflicts |
| `VERSION_CONFLICT` | 409 | Optimistic lock: the record changed since you read it |
| `RECORD_IN_USE` | 409 | Master record referenced elsewhere (`meta.usedBy`); deactivate instead |
| `QTY_CHANGED` | 409 | The pending quantity changed under you (another approver acted) |
| `QTY_EXCEEDS_REMAINING` | 409 | Quantity is more than what is still selectable / orderable / receivable / issuable |
| `QTY_INVARIANT` | 409 | A ledger rule would be broken |
| `STAGE_NOT_ACTIVE` / `WORKFLOW_NOT_RUNNING` | 409 | Action on a stage or workflow that is not running |
| `EFFECT_UNAVAILABLE` | 409 | Workflow uses an effect the plan does not include |
| `FLOW_DISABLED` | 409 | The step is switched off by a `flow.*` setting |
| `LINE_NOT_QUOTABLE` | 409 | Quote logged against a line that is not approved or is closed |
| `STOCK_INSUFFICIENT` / `STOCK_NEGATIVE` | 409 | Not enough stock (`meta` has item, location, available, requested) |
| `STOCK_VALUATION_LOCKED` | 409 | `stock.valuation` change inside a financial year with movements |
| `STOCK_OPENING_EXISTS` | 409 | Opening balance for an item × location that already has movements |
| `STOCK_EFFECT_UNSUPPORTED` | 409 | Stock effect used on a document type that has no stock handler |
| `VALIDATION_FAILED` with `meta.code = STOCK_INVALID_POST` | 400 | Invalid stock movement |
| `REASON_REQUIRED` | 400 | The stage requires a reason for this decision |
| `BAD_SEND_BACK` / `BAD_FORWARD` | 400 | Invalid send-back target or forward user |
| `DOCUMENTS_UNAVAILABLE` | 503 | Documents module not ready |
| `INTERNAL` | 500 | Unexpected error (logged with the stack) |

## Pagination, sorting and filtering

List endpoints use **cursor pagination**:

```
GET /api/v1/docs/indent?limit=50&status=approved&q=IND/26
→ { "data": [ … ], "nextCursor": "eyJ…" }       # null on the last page
GET /api/v1/docs/indent?limit=50&status=approved&q=IND/26&cursor=eyJ…
```

- `limit` 1–200, default 50 (`/stock/ledger` up to 500, default 100).
- `q` free-text search; `sort=field` or `sort=-field` (descending) where supported.
- Document lists: `view=document|item`, `status` (one or more status view keys), `location` (includes
  sub-locations), `from`, `to`, `item`, `party`, `savedView`, and `f.<field>=<value>` for exact matches on custom
  fields. Master records accept `f.<field>=<value>` too.
- Keep the other parameters unchanged when following a cursor.

## Concurrency: versions and `If-Match`

- Records that can be edited carry a `version` integer. Updates send it back in the body (`{ …, "version": 7 }`); if
  the row changed meanwhile you get `409 VERSION_CONFLICT`. Reload and retry.
- Workflow actions (`POST /docs/:type/:id/actions`) accept **`If-Match: <document version>`** (the number, not an
  ETag string). Every action bumps the document version, so a stale screen gets `409 VERSION_CONFLICT`. Without
  `If-Match`, a stale decision is still caught by `409 QTY_CHANGED` when the pending quantity no longer matches.

## Idempotency

| Where | How |
| --- | --- |
| Workflow actions | Header `Idempotency-Key: <uuid>` on `POST /docs/:type/:id/actions`. Repeating the key returns the original result without a second action. A key reused for another document → `409`, by another user → `403`. |
| Manual send | `idempotencyKey` in the `POST /docs/:type/:id/send` body: one per send dialog; repeats never send twice. |
| Notifications and webhooks | Internal: each send has a unique key derived from tenant, rule, outbox event, recipient and channel; webhook deliveries carry `X-Procure-Delivery`. |
| Stock movements | Internal: every movement posted by a workflow effect has an idempotency key, so retried effects never double-post. |

## Files

Upload with `POST /files` (multipart field `file`, optional `formKey` + `fieldKey` to apply that field's rules). Max
25 MB; type sniffed from content (images, PDF, CSV, XLSX, DOCX, TXT). Files start `pending` and are served only when
the scanner marks them `clean`. `GET /files/:id` returns metadata with a **signed URL valid 5 minutes**: with the local
driver it points to `GET /files/:id/content?exp=&sig=` (HMAC with `FILE_URL_SECRET`); with S3 it is a presigned S3 URL.

## Outgoing webhooks

Requires plan feature `api_access`. Configure endpoints in **Configuration → Webhooks** or `/config/webhooks`. The
signing secret is returned **once**, when the endpoint is created.

Each delivery is `POST <your URL>` with a JSON body:

```json
{
  "id": "evt_12345",
  "type": "document.submitted",
  "occurredAt": "2026-10-23T05:30:00.000Z",
  "tenant": { "id": "…", "code": "acme" },
  "data": { "…": "event payload" }
}
```

Headers: `Content-Type: application/json`, `User-Agent: Procure-Webhooks/1.0`,
`X-Procure-Event: <type>`, `X-Procure-Delivery: <delivery id>` and
**`X-Procure-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`**.

Delivery rules: 10 s timeout; a 2xx answer counts as delivered; otherwise up to 8 retries with backoff
(30 s, 2 min, 8 min, 32 min, ~2 h, then 6 h); the endpoint is switched off after 50 consecutive failures and the tenant
admins are notified. URLs must resolve to public addresses (private, loopback and link-local ranges are blocked, also
at send time). Delivery is at-least-once: de-duplicate on `id`.

Event types: `document.created`, `document.submitted`, `document.updated`, `document.cancelled`, `document.closed`,
`document.status_changed`, `workflow.stage_entered`, `workflow.decided`, `workflow.completed`, `workflow.sent_back`,
`workflow.forwarded`, `workflow.sla_reminder`, `workflow.sla_escalated`, `comment.created`, `comment.mentioned`,
`limit.warning`, `indent.quote_logged`, `selection.submitted`, `po.created_from_lines`, `po.amended`,
`po.followup_logged`, plus any event a published workflow emits with the `emit` effect
(`GET /config/triggers/events` lists them).

### Verifying the signature

Verify against the **raw** request body, before any JSON parsing, and reject old timestamps.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyProcureSignature(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Express: app.post('/procure', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyProcureSignature(SECRET, req.body.toString('utf8'), req.get('X-Procure-Signature'))) return res.sendStatus(401);
//   const event = JSON.parse(req.body); … res.sendStatus(200);
// });
```

Python:

```python
import hmac, hashlib, time

def verify_procure_signature(secret: str, raw_body: bytes, header: str, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    try:
        ts = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - ts) > tolerance or "v1" not in parts:
        return False
    mac = hmac.new(secret.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, parts["v1"])
```

The same check is implemented in the code as `verifyWebhookSignature` in
`apps/api/src/modules/notify/util/signature.ts`.

## Inbound provider webhooks

| Path | Use | Verification |
| --- | --- | --- |
| `GET /hooks/whatsapp` | Meta webhook subscription check | `hub.verify_token` must match a WhatsApp provider's `verifyToken` |
| `POST /hooks/whatsapp` | WhatsApp delivery / read statuses | `X-Hub-Signature-256: sha256=<HMAC(appSecret, rawBody)>` with a configured provider's `appSecret`; else `401 BAD_SIGNATURE` |
| `POST /hooks/email/ses` | SES bounce / delivery notifications via SNS | SNS message signature (subscription confirmations are handled) |

## Endpoint index

Permissions are tenant permission keys (see the [permissions reference](permissions-reference.md)) unless marked
*platform* (Super Admin role) or *public*. `+` means all keys are needed; "or" means any one. `<type>` and `<key>` are
taken from the URL. Every tenant route also applies data scope and field access.

### Auth

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/auth/login` | public |
| POST | `/auth/platform/login` | public |
| POST | `/auth/refresh` | public (cookie `rt`) |
| POST | `/auth/logout` | signed in |
| GET | `/auth/me` | signed in |
| POST | `/auth/password/change` | signed in |
| GET | `/auth/sessions` | signed in |
| DELETE | `/auth/sessions/:id` | signed in (own session) |

### Users, roles, notifications, usage

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/users` | `admin.users:action.view` |
| POST | `/users` | `admin.users:action.add` |
| GET | `/users/:id` | `admin.users:action.view` |
| PUT | `/users/:id` | `admin.users:action.edit` |
| POST | `/users/:id/deactivate` | `admin.users:action.deactivate` |
| POST | `/users/:id/activate` | `admin.users:action.deactivate` |
| POST | `/users/:id/reset-password` | `admin.users:action.reset_password` |
| POST | `/users/:id/unlock` | `admin.users:action.reset_password` |
| GET | `/users/:id/sessions` | `admin.users:action.force_logout` |
| POST | `/users/:id/force-logout` | `admin.users:action.force_logout` |
| GET | `/roles` | `admin.roles:action.view` |
| POST | `/roles` | `admin.roles:action.add` |
| GET | `/notifications` | any tenant user |
| POST | `/notifications/:id/read` | any tenant user |
| GET | `/tenant/usage` | `admin.usage:action.view` |

### Permissions

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/permissions/registry` | `admin.roles:action.manage_permissions` or `admin.users:action.manage_permissions` |
| GET | `/roles/:id/permissions` | `admin.roles:action.manage_permissions` |
| PUT | `/roles/:id/permissions/tabs/:tabKey` | `admin.roles:action.manage_permissions` |
| PUT | `/roles/:id/scope` | `admin.roles:action.manage_permissions` |
| PUT | `/roles/:id` | `admin.roles:action.edit` |
| DELETE | `/roles/:id` | `admin.roles:action.delete` |
| GET | `/users/:id/permissions` | `admin.users:action.manage_permissions` |
| PUT | `/users/:id/permissions/tabs/:tabKey` | `admin.users:action.manage_permissions` |
| PUT | `/users/:id/scope` | `admin.users:action.manage_permissions` |
| PUT | `/users/:id/roles` | `admin.users:action.manage_permissions` |
| GET | `/users/:id/effective-permissions` | `admin.users:action.view` |

### Locations

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/locations` | `admin.locations:action.view` (`scope=mine`: any user) |
| GET | `/locations/tree` | `admin.locations:action.view` (`scope=mine`: any user) |
| GET | `/locations/:id` | `admin.locations:action.view` (within scope) |
| POST | `/locations` | `admin.locations:action.add` |
| PUT | `/locations/:id` | `admin.locations:action.edit` |
| POST | `/locations/:id/move` | `admin.locations:action.move` |
| POST | `/locations/:id/deactivate` | `admin.locations:action.deactivate` |
| POST | `/locations/:id/activate` | `admin.locations:action.deactivate` |
| DELETE | `/locations/:id` | `admin.locations:action.deactivate` |

### Settings and labels

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/config/settings` | `admin.settings:action.view` |
| PUT | `/config/settings` | `admin.settings:action.edit` |
| GET | `/config/labels` | any tenant user |
| PUT | `/config/labels` | `admin.settings:action.edit` |

### Forms

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/config/forms` | `config.forms:action.view` |
| POST | `/config/forms/validate` | feature `form_builder`, `config.forms:action.edit` |
| GET | `/config/forms/:formKey` | `config.forms:action.view` |
| PUT | `/config/forms/:formKey/draft` | feature `form_builder`, `config.forms:action.edit` |
| DELETE | `/config/forms/:formKey/draft` | feature `form_builder`, `config.forms:action.edit` |
| POST | `/config/forms/:formKey/publish` | feature `form_builder`, `config.forms:action.publish` |
| GET | `/config/forms/:formKey/versions` | `config.forms:action.view` |
| GET | `/config/forms/:formKey/versions/:version` | `config.forms:action.view` |
| GET | `/forms/:formKey/render` | any tenant user (hidden fields removed) |
| GET | `/users/options` | any tenant user |

### Masters and records

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/config/masters` | feature `form_builder`, `config.masters:action.add` |
| PUT | `/config/masters/:key` | feature `form_builder`, `config.masters:action.edit` |
| POST | `/config/masters/:key/deactivate` | feature `form_builder`, `config.masters:action.edit` |
| POST | `/config/masters/:key/activate` | feature `form_builder`, `config.masters:action.edit` |
| GET | `/masters` | any (lists masters the caller can view) |
| GET | `/masters/:key/records` | `master.<key>:action.view` + view key |
| POST | `/masters/:key/records` | `master.<key>:action.add` |
| GET | `/masters/:key/records/:id` | `master.<key>:action.view` |
| PUT | `/masters/:key/records/:id` | `master.<key>:action.edit` |
| POST | `/masters/:key/records/:id/deactivate` | `master.<key>:action.deactivate` |
| POST | `/masters/:key/records/:id/activate` | `master.<key>:action.deactivate` |
| DELETE | `/masters/:key/records/:id` | `master.<key>:action.delete` |
| GET | `/masters/:key/records/:id/usage` | `master.<key>:action.view` |
| GET | `/masters/:key/options` | any tenant user (field access applies) |
| GET | `/masters/:key/template.xlsx` | `master.<key>:action.import` |
| POST | `/masters/:key/import` | `master.<key>:action.import` |
| GET | `/masters/:key/export` | `master.<key>:action.export` |

### Files

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/files` | any tenant user |
| GET | `/files/:id` | any tenant user |
| GET | `/files/:id/content` | public; HMAC-signed URL (`exp`, `sig`) |

### Document types, numbering, documents, saved views

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/doc-types` | any user (lists types the caller can view) |
| POST | `/config/doc-types` | feature `form_builder`, `config.doc_types:action.add` |
| PUT | `/config/doc-types/:key` | feature `form_builder`, `config.doc_types:action.edit` |
| POST | `/config/doc-types/:key/deactivate` | `config.doc_types:action.edit` |
| POST | `/config/doc-types/:key/activate` | `config.doc_types:action.edit` |
| GET | `/config/numbering` | `config.numbering:action.view` |
| POST | `/config/numbering` | `config.numbering:action.edit` |
| PUT | `/config/numbering/:id` | `config.numbering:action.edit` |
| GET | `/config/numbering/:id/preview` | `config.numbering:action.view` |
| GET | `/docs/:type` | `doc.<type>:action.view` + status view keys |
| GET | `/docs/:type/counts` | `doc.<type>:action.view` |
| POST | `/docs/:type` | `doc.<type>:action.add` (PO without sources: `doc.po:action.create_direct`) |
| GET | `/docs/:type/:id` | `doc.<type>:action.view` + view of its status |
| PUT | `/docs/:type/:id` | `doc.<type>:action.edit` |
| DELETE | `/docs/:type/:id` | `doc.<type>:action.delete` |
| POST | `/docs/:type/:id/submit` | `doc.<type>:action.submit` |
| POST | `/docs/:type/:id/cancel` | `doc.<type>:action.cancel` |
| POST | `/docs/:type/:id/close` | `doc.<type>:action.close` |
| POST | `/docs/:type/:id/copy` | `doc.<type>:action.add` + `…copy` |
| GET | `/docs/:type/:id/timeline` | `doc.<type>:action.view` |
| GET | `/docs/:type/:id/comments` | `doc.<type>:action.view` |
| POST | `/docs/:type/:id/comments` | `doc.<type>:action.comment` |
| PUT | `/docs/:type/:id/comments/:commentId` | author, within 15 minutes |
| DELETE | `/docs/:type/:id/comments/:commentId` | author |
| GET | `/docs/:type/:id/attachments` | `doc.<type>:action.view` |
| POST | `/docs/:type/:id/attachments` | `doc.<type>:action.attach` |
| DELETE | `/docs/:type/:id/attachments/:attId` | `doc.<type>:action.attach` |
| GET | `/saved-views` | any user |
| POST | `/saved-views` | any user (sharing to roles: tenant admin or `admin.roles:action.edit`) |
| PUT | `/saved-views/:id` | owner |
| DELETE | `/saved-views/:id` | owner |

### Workflows, actions and approvals inbox

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/config/workflows` | `config.workflows:action.view` |
| GET | `/config/workflows/:docType` | `config.workflows:action.view` |
| PUT | `/config/workflows/:docType/draft` | feature `workflow_designer`, `config.workflows:action.edit` |
| DELETE | `/config/workflows/:docType/draft` | feature `workflow_designer`, `config.workflows:action.edit` |
| POST | `/config/workflows/:docType/publish` | feature `workflow_designer`, `config.workflows:action.publish` |
| GET | `/config/workflows/:docType/versions` | `config.workflows:action.view` |
| GET | `/config/workflows/:docType/versions/:v` | `config.workflows:action.view` |
| POST | `/config/workflows/:docType/simulate` | `config.workflows:action.view` |
| POST | `/docs/:type/:id/actions` | `doc.<type>:action.stage_<stage>` + actor rules + scope |
| GET | `/approvals` | `approvals:action.view` |
| GET | `/approvals/counts` | `approvals:action.view` |

### Audit

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/audit` | `admin.audit:action.view` |
| GET | `/audit/checks` | `admin.audit:action.view` |
| POST | `/audit/checks` | `admin.audit:action.verify` |

### Procurement

| Method | Path | Permission |
| --- | --- | --- |
| POST | `/docs/indent/:id/short-close` | `doc.indent:action.short_close` |
| GET | `/procurement/orderable-lines` | `doc.po:action.add` |
| POST | `/procurement/po/from-lines` | `doc.po:action.add` |
| GET | `/docs/po/:id/taxes` | `doc.po:action.view` |
| GET | `/docs/po/:id/followups` | `doc.po:action.view` |
| POST | `/docs/po/:id/followups` | `doc.po:action.followup` |
| POST | `/docs/po/:id/amend` | `doc.po:action.amend` |
| DELETE | `/docs/po/:id/amend` | `doc.po:action.amend` |
| GET | `/docs/po/:id/revisions` | `doc.po:action.view` |
| POST | `/docs/po/:id/short-close` | `doc.po:action.short_close` |
| GET | `/procurement/indent-lines/:lineId/quotes` | `doc.indent:action.view` |
| POST | `/procurement/indent-lines/:lineId/quotes` | `doc.indent:action.log_quote` |
| PUT | `/procurement/quotes/:quoteId` | `doc.indent:action.log_quote` |
| GET | `/procurement/indent-lines/:lineId/comparison` | `doc.indent:action.compare` |
| GET | `/procurement/items/:itemId/comparison` | `doc.indent:action.compare` |
| GET | `/procurement/selectable-lines` | `doc.vendor_selection:action.add` |
| POST | `/procurement/selections` | `doc.vendor_selection:action.add` |

### Inventory (GRN, RTV, issue, return)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/inventory/receivable-po-lines` | `doc.grn:action.add` |
| POST | `/inventory/grn/from-po` | `doc.grn:action.add` |
| GET | `/inventory/returnable-grn-lines` | `doc.rtv:action.add` |
| POST | `/inventory/rtv/from-grn` | `doc.rtv:action.add` |
| GET | `/inventory/issuable-lines` | `doc.store_issue:action.add` |
| POST | `/inventory/issues/from-requests` | `doc.store_issue:action.add` |
| GET | `/inventory/returnable-lines` | `doc.store_return:action.add` |
| POST | `/inventory/returns/from-issues` | `doc.store_return:action.add` |

### Stock

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/stock/balances` | `stock:action.view` |
| GET | `/stock/ledger` | `stock:action.view` |
| GET | `/stock/items/:itemId/summary` | `stock:action.view` |
| POST | `/stock/opening` | `stock:action.opening` |
| POST | `/stock/block` | `stock:action.block` |
| GET | `/stock/reorder-rules` | `stock:action.reorder` |
| GET | `/stock/reorder-rules/:id` | `stock:action.reorder` |
| POST | `/stock/reorder-rules` | `stock:action.reorder` |
| PUT | `/stock/reorder-rules/:id` | `stock:action.reorder` |
| DELETE | `/stock/reorder-rules/:id` | `stock:action.reorder` |
| GET | `/stock/reorder` | `stock:action.view` |
| GET | `/stock/valuation` | `stock:action.view` + `stock:action.view_value` |
| POST | `/stock/counts/snapshot` | `doc.stock_count:action.add` |

### Templates and PDF

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/config/templates` | `config.templates:action.view` |
| GET | `/config/templates/context-fields` | `config.templates:action.view` |
| POST | `/config/templates/preview` | `config.templates:action.view` |
| POST | `/config/templates` | `config.templates:action.edit` |
| PUT | `/config/templates/:id` | `config.templates:action.edit` |
| DELETE | `/config/templates/:id` | `config.templates:action.edit` |
| POST | `/config/templates/:id/test-pdf` | `config.templates:action.view` |
| POST | `/docs/:type/:id/print` | `doc.<type>:action.view` + `…print` |
| GET | `/pdf-jobs/:id` | requester |

### Notifications, messages and webhooks

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/config/triggers` | `config.triggers:action.view` |
| GET | `/config/triggers/events` | `config.triggers:action.view` |
| GET | `/config/triggers/:id` | `config.triggers:action.view` |
| POST | `/config/triggers` | `config.triggers:action.edit` |
| PUT | `/config/triggers/:id` | `config.triggers:action.edit` |
| DELETE | `/config/triggers/:id` | `config.triggers:action.edit` |
| GET | `/config/whatsapp-templates` | `config.templates:action.view` |
| GET | `/config/webhooks` | feature `api_access`, `config.webhooks:action.view` |
| GET | `/config/webhooks/:id` | feature `api_access`, `config.webhooks:action.view` |
| POST | `/config/webhooks` | feature `api_access`, `config.webhooks:action.edit` |
| PUT | `/config/webhooks/:id` | feature `api_access`, `config.webhooks:action.edit` |
| DELETE | `/config/webhooks/:id` | feature `api_access`, `config.webhooks:action.edit` |
| GET | `/config/webhooks/:id/deliveries` | feature `api_access`, `config.webhooks:action.view` |
| POST | `/config/webhooks/:id/test` | feature `api_access`, `config.webhooks:action.edit` |
| GET | `/messages` | `messages:action.view` |
| POST | `/messages/:id/retry` | `messages:action.retry` |
| GET | `/docs/:type/:id/messages` | `doc.<type>:action.view` |
| GET | `/docs/:type/:id/send/options` | `doc.<type>:action.send_email` or `send_whatsapp` |
| GET | `/docs/:type/:id/send/suggestions` | `doc.<type>:action.send_email` or `send_whatsapp` |
| POST | `/docs/:type/:id/send/preview` | `doc.<type>:action.send_email` / `send_whatsapp` |
| POST | `/docs/:type/:id/send` | `doc.<type>:action.send_email` / `send_whatsapp` |
| GET | `/hooks/whatsapp` | public (verify token) |
| POST | `/hooks/whatsapp` | public; `X-Hub-Signature-256` |
| POST | `/hooks/email/ses` | public; SNS signature |

### Reports, exports and dashboards

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/reports/sources` | `reports:action.view` |
| GET | `/reports` | `reports:action.view` |
| POST | `/reports/preview` | `reports:action.view` + `reports:action.build` |
| GET | `/reports/:id` | `reports:action.view` |
| POST | `/reports` | `reports:action.view` + `reports:action.build` |
| PUT | `/reports/:id` | `reports:action.view` + `reports:action.build` |
| DELETE | `/reports/:id` | `reports:action.view` + `reports:action.build` |
| POST | `/reports/:id/run` | `reports:action.view` |
| POST | `/reports/:id/schedules` | `reports:action.view` + `reports:action.schedule` |
| GET | `/reports/:id/schedules` | `reports:action.view` + `reports:action.schedule` |
| DELETE | `/reports/:id/schedules/:scheduleId` | `reports:action.view` + `reports:action.schedule` |
| POST | `/exports` | per kind: report → `reports:action.view` + `…export`; list → `doc.<type>:action.view`; master → `master.<key>:action.view` + `…export` |
| GET | `/exports` | requester |
| GET | `/exports/:id` | requester |
| GET | `/dashboards` | `dashboards:action.view` |
| GET | `/dashboards/mine` | any tenant user |
| POST | `/dashboards/widgets/:widgetId/data` | can open the dashboard; report widgets need `reports:action.view` |
| GET | `/dashboards/:id` | `dashboards:action.view` |
| POST | `/dashboards` | `dashboards:action.view` + `dashboards:action.edit` |
| PUT | `/dashboards/:id` | `dashboards:action.view` + `dashboards:action.edit` |
| DELETE | `/dashboards/:id` | `dashboards:action.view` + `dashboards:action.edit` |

### Platform (Super Admin)

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/platform/providers` | platform: owner |
| GET | `/platform/providers/:id` | platform: owner |
| POST | `/platform/providers` | platform: owner |
| PUT | `/platform/providers/:id` | platform: owner |
| DELETE | `/platform/providers/:id` | platform: owner |
| GET | `/platform/whatsapp-templates` | platform: owner |
| POST | `/platform/whatsapp-templates` | platform: owner |
| PUT | `/platform/whatsapp-templates/:id` | platform: owner |
| DELETE | `/platform/whatsapp-templates/:id` | platform: owner |
| GET | `/platform/tenants/:id/whatsapp-templates` | platform: owner |
| PUT | `/platform/tenants/:id/whatsapp-templates` | platform: owner |
| GET | `/platform/catalog` | platform: any role |
| GET | `/platform/plans` | platform: any role |
| POST | `/platform/plans` | platform: owner, billing |
| PUT | `/platform/plans/:id` | platform: owner, billing |
| GET | `/platform/tenants` | platform: any role |
| POST | `/platform/tenants` | platform: owner, support |
| GET | `/platform/tenants/:id` | platform: any role |
| PUT | `/platform/tenants/:id` | platform: owner, support |
| POST | `/platform/tenants/:id/suspend` | platform: owner, support, billing |
| POST | `/platform/tenants/:id/reactivate` | platform: owner, support, billing |
| POST | `/platform/tenants/:id/archive` | platform: owner |
| PUT | `/platform/tenants/:id/overrides` | platform: owner, billing |
| GET | `/platform/tenants/:id/overrides/history` | platform: any role |
| POST | `/platform/tenants/:id/subscription` | platform: owner, billing |
| GET | `/platform/tenants/:id/subscriptions` | platform: any role |
| POST | `/platform/tenants/:id/admin/reset-password` | platform: owner, support |
| POST | `/platform/tenants/:id/impersonate` | platform: owner, support |
| GET | `/platform/usage` | platform: any role |
| GET | `/platform/audit` | platform: any role |

### Health

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/health` | public |
