# Phase 6 API contract (FROZEN) — templates, PDF, email, WhatsApp, in-app, webhooks

Types: `packages/schema/src/notify.ts`. Migration `0012_notify.sql`. Seam: `TemplateRenderer` in
`apps/api/src/core/ports.ts`. ADR-0014. Everything goes through the outbox → BullMQ with idempotency keys; nothing
is sent for a rolled-back transaction; nothing is sent twice.

## Module split
- **Templates & PDF** (`modules/templates`): template CRUD, Handlebars rendering (fixed helper set), document
  context builder, PDF rendering in the worker with headless Chromium (Playwright; prod image ships it; local
  executable `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` via `PDF_CHROMIUM_PATH`), print endpoints,
  starter templates per system/custom doc type (PO, indent, vendor selection, comparison sheet, generic document),
  `generate_pdf` workflow effect. Implements `TemplateRenderer`.
- **Notify** (`modules/notify`): trigger engine (consumer of the `events` queue from the Phase 3 outbox relay),
  channels (email: `ses` | `smtp` | `log`; WhatsApp: `meta` | `bsp` | `log`; in-app), limits, manual send,
  outbound log, provider webhooks (delivery/read), outgoing webhooks, `send_email` / `send_whatsapp` workflow
  effects, Super Admin provider credentials + WhatsApp template catalogue/approvals.

## Templates & PDF endpoints
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| GET | `/config/templates` | `?channel=&docType=` | `TemplateRow[]` | `config.templates:action.view` |
| POST / PUT / DELETE | `/config/templates[/:id]` | `TemplateInput` (+version) | `TemplateRow` | `config.templates:action.edit`; PDF templates beyond the first per doc type need feature `pdf_templates`; one default per (channel, doc type) |
| POST | `/config/templates/preview` | `{ template: TemplateInput, documentId? }` | `{ subject, html }` (pdf/email rendered HTML; uses a sample document of the doc type if none given) | `…view` |
| POST | `/config/templates/:id/test-pdf` | `{ documentId? }` | `PdfJobRow` | `…view` |
| GET | `/config/templates/context-fields` | `?docType=` | `{ path, label, example }[]` placeholder picker (incl. every custom header/line field) | `…view` |
| POST | `/docs/:type/:id/print` | `PrintInput` | `PdfJobRow` (queued or ready from cache keyed by doc version + template version) | `doc.<type>:action.view` + `doc.<type>:action.print` (new generated action key "Print / PDF"; documents agent's generator gets it added by you) |
| GET | `/pdf-jobs/:id` | – | `PdfJobRow` (signed file URL when ready) | requester |

Rendering safety: Handlebars `noEscape: false`, `strict` off, no prototype access (`allowProtoPropertiesByDefault:
false`), template size ≤ 200 KB, render timeout 2 s; Chromium with JavaScript disabled, all network requests
blocked except `data:` and the API's own signed file URLs (logo/signatures), 20 s timeout, max 3 concurrent renders
per worker, A4 default. Logos/letterhead/signatures via file fields (tenant profile logo, `signature` fields).

## Notify endpoints
| Method | Path | Body | Response | Key |
| --- | --- | --- | --- | --- |
| GET / POST / PUT / DELETE | `/config/triggers[/:id]` | `TriggerRuleInput` | `TriggerRuleRow` | `config.triggers:action.view|edit`; channel must be in plan (`email`/`whatsapp` features); WhatsApp template must be allowed for the tenant |
| GET | `/config/triggers/:id` | – | `TriggerRuleRow` | `config.triggers:action.view` |
| GET | `/config/triggers/events` | – | `{ type, label, docScoped }[]` (DomainEventType + workflow `emit` events in published workflows + Phase 4 events) | `…view` |
| GET | `/docs/:type/:id/send/options` | – | `SendOptions` (per channel — null when the key or plan feature is missing — usable templates + manual rules' suggested recipients; PDF templates only with `…print`; party contact; this month's quota) | `doc.<type>:action.send_email` or `send_whatsapp` (no config keys needed) |
| GET | `/docs/:type/:id/send/suggestions` | – | `SendSuggestion[]` (active manual rules of the type, per channel the caller may send, with resolved recipients) | same |
| POST | `/docs/:type/:id/send/preview` | `ManualSendInput` minus idempotencyKey | `SendPreview` | `doc.<type>:action.send_email` / `send_whatsapp` (new generated action keys) |
| POST | `/docs/:type/:id/send` | `ManualSendInput` | `OutboundMessageRow[]` | same |
| GET | `/messages` | `?channel=&status=&documentId=&cursor=` | `Page<OutboundMessageRow>` | `messages:action.view` |
| POST | `/messages/:id/retry` | – | `OutboundMessageRow` | `messages:action.retry` (failed only) |
| GET | `/docs/:type/:id/messages` | – | `OutboundMessageRow[]` (also shown on the timeline) | view |
| GET / POST / PUT / DELETE | `/config/webhooks[/:id]` | `WebhookEndpointInput` | `WebhookEndpointRow` (secret only on create) | `config.webhooks:action.*`; **`webhook_endpoints` limit**; URL must resolve to a public IP (SSRF guard: block private/loopback/link-local ranges, re-checked at send time) |
| GET | `/config/webhooks/:id` | – | `WebhookEndpointRow` (never the secret) | feature `api_access` + `config.webhooks:action.view` |
| GET | `/config/webhooks/:id/deliveries` | – | `WebhookDeliveryRow[]` | view |
| POST | `/config/webhooks/:id/test` | – | `WebhookDeliveryRow` | edit |
| GET | `/config/whatsapp-templates` | – | allowed templates (`app.my_whatsapp_templates()`) | `config.templates:action.view` |
| POST | `/hooks/whatsapp` (+ GET verify) | Meta webhook | 200 | **Public**, verified by `X-Hub-Signature-256` with the provider app secret |
| POST | `/hooks/email/ses` | SNS notification | 200 | **Public**, SNS signature verified |
| Platform | `/platform/providers[/:id]`, `/platform/whatsapp-templates[/:id]`, `/platform/tenants/:id/whatsapp-templates` (PUT allowed ids) | `ProviderCredentialInput`, `WhatsAppTemplateInput` | rows (secrets never returned) | `@PlatformOnly('owner')` |

## Trigger engine rules
- Consumer of queue `events` (Phase 3 relay, `jobId = outbox:<id>`). For each active rule matching event type +
  doc type, evaluate `condition` (formula language over the document snapshot; errors → rule skipped + logged),
  resolve recipients (party email/phone from vendor master fields `email`/`phone`; users' email/phone; role holders
  within the document's location scope; stage actors), render, and enqueue one send per recipient with
  `idempotency_key = hash(tenant, rule, outboxId, recipient, channel)` (unique → duplicates impossible).
  `mode = 'manual'` rules don't send; they appear as suggested sends on the document ("Email vendor").
- **Limits**: before each email/WhatsApp send call `app.consume_quota('<channel>_per_month', 1, '<YYYY-MM in tenant
  tz>')`; not allowed → status `blocked_limit` (logged, never sent) + 80%/100% admin notifications. Feature off or no
  provider configured → `blocked_config`.
- Sends: queue `send-email` / `send-whatsapp` (concurrency 5, attempts 5, exponential backoff); provider errors
  4xx (bad address) fail fast, 5xx/timeouts retry. PDF attachments wait for `TemplateRenderer.pdfForDocument`.
  WhatsApp: template messages only, document header for PDFs, variables from the template mapping; per-tenant
  allowed-template check at send time.
- Status updates from provider webhooks update `delivered_at` / `read_at` / `failed`.
- In-app channel writes `app.notification` rows (same as Phase 3 notifications) — used for custom in-app rules.
- **Outgoing webhooks** (feature `api_access`): consumer of `events` too; for each active endpoint subscribed to the
  event, POST JSON `{ id, type, occurredAt, tenant, data }` with headers `X-Procure-Signature: t=<ts>,v1=<hmac
  sha256(secret, ts + '.' + body)>`, `X-Procure-Event`, `X-Procure-Delivery`; 10 s timeout; retries 8× exponential
  (max 6 h); record every attempt; auto-disable after 50 consecutive failures (+ admin notification).

## Defaults & seed
Every tenant gets starter templates: PO PDF (letterhead, vendor block, lines with HSN + GST split, totals in
words, T&C, signature, QR with document URL), Indent PDF, Comparison sheet PDF, generic document PDF, "PO approved →
email vendor" email template + trigger rule (manual by default for safety; acme demo: auto), "Approval pending"
in-app. Platform providers default to `log` (writes rendered messages to the outbound log and to
`.data/mail/<tenant>/` for email) so dev/test never send real messages; staging/prod configure SES + Meta.
Seed WhatsApp templates `po_issued` (document header, vars: vendor name, PO number, amount) and
`approval_pending` (vars: doc type, number), allowed for acme.
