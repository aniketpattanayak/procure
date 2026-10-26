import { z } from 'zod';
import { Uuid } from './common';

/**
 * NOTIFICATIONS / TEMPLATES / PDF / EMAIL / WHATSAPP / WEBHOOKS CONTRACT (Phase 6, frozen). ADR-0014.
 * One trigger engine: "when EVENT on DOC TYPE (and CONDITION) → render TEMPLATE for RECIPIENTS via CHANNEL,
 * automatically or after a manual click". Everything goes through queues with idempotency keys.
 */

export const Channel = z.enum(['email', 'whatsapp', 'inapp']);
export const TemplateChannel = z.enum(['pdf', 'email', 'whatsapp', 'inapp']);

/**
 * Template language: Handlebars (logic-less; no custom helpers that touch I/O). Context available to every template:
 *   tenant { name, legalName, logoUrl, gstin, pan, address{…} }
 *   document { id, number, statusLabel, docDate, requiredBy, location{name, code}, party{code, name, …vendor fields},
 *              totalAmount, revNo, url, values{<all header field keys>}, refs{…} }
 *   lines [ { lineNo, item{code,name}, uom, qty, rate, amount, requiredDate, values{<line field keys>}, taxes[] } ]
 *   totals { taxable, cgst, sgst, igst, cess, grand }   (PO)
 *   terms [ { code, name, body } ]                       (PO T&C picked from the terms master)
 *   approvals [ { stage, by, at, outcome } ]
 *   event { type, at, actor{name}, comment }
 *   recipient { name }
 * Helpers (fixed set): formatDate d 'DD-MMM-YYYY', formatMoney n currency, formatNumber n places, upper, lower,
 * eq a b, ifEq, qrCode text (inline SVG), amountInWords n currency.
 */
export const TemplateInput = z.object({
  channel: TemplateChannel,
  docTypeKey: z.string().nullable().default(null),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  name: z.string().trim().min(1).max(120),
  subject: z.string().max(300).optional(),
  body: z.string().min(1).max(200_000),
  whatsappTemplateId: Uuid.optional(),
  whatsappVariables: z.array(z.object({ index: z.number().int().min(1).max(20), expr: z.string().max(300) })).max(20).default([]),
  pdfOptions: z.object({
    format: z.enum(['A4', 'A5', 'Letter', 'Legal']).default('A4'),
    landscape: z.boolean().default(false),
    marginMm: z.object({ top: z.number().min(0).max(50), right: z.number().min(0).max(50), bottom: z.number().min(0).max(50), left: z.number().min(0).max(50) }).default({ top: 15, right: 12, bottom: 15, left: 12 }),
    headerHtml: z.string().max(20_000).optional(),
    footerHtml: z.string().max(20_000).optional(),
  }).default({}),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type TemplateInput = z.infer<typeof TemplateInput>;
export interface TemplateRow extends TemplateInput { id: string; version: number; updatedAt: string }

export const TriggerRecipient = z.discriminatedUnion('type', [
  z.object({ type: z.literal('party') }),                                     // document's vendor (email / phone from master)
  z.object({ type: z.literal('submitter') }),
  z.object({ type: z.literal('role'), roleId: Uuid, withinScope: z.boolean().default(true) }),
  z.object({ type: z.literal('users'), userIds: z.array(Uuid).min(1).max(50) }),
  z.object({ type: z.literal('stage_actors'), stage: z.string() }),
  z.object({ type: z.literal('field'), field: z.string() }),                 // header email/phone/user field
  z.object({ type: z.literal('fixed'), address: z.string().max(254) }),       // email or E.164 phone
]);
export const TriggerRuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  eventType: z.string().min(3).max(80),
  docTypeKey: z.string().nullable().default(null),
  condition: z.string().max(2000).optional(),
  channel: Channel,
  templateId: Uuid,
  recipients: z.array(TriggerRecipient).min(1).max(20),
  attachPdfTemplateId: Uuid.optional(),
  mode: z.enum(['auto', 'manual']).default('auto'),
  isActive: z.boolean().default(true),
});
export interface TriggerRuleRow extends z.infer<typeof TriggerRuleInput> { id: string; version: number }

/** POST /docs/:type/:id/send/preview and /send — manual send with editable preview. */
export const ManualSendInput = z.object({
  channel: Channel,
  templateId: Uuid,
  recipients: z.array(z.string().max(254)).min(1).max(20),     // emails / E.164 phones (validated per channel)
  subject: z.string().max(300).optional(),                     // edited preview (email)
  body: z.string().max(200_000).optional(),                    // edited preview (email); WhatsApp bodies are not editable
  attachPdfTemplateId: Uuid.optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export interface SendPreview { subject: string | null; body: string; recipients: { address: string; name: string | null; valid: boolean; reason?: string }[]; attachments: { name: string }[]; quota: { used: number; limit: number | null } | null }

export interface OutboundMessageRow {
  id: string; channel: 'email' | 'whatsapp' | 'inapp'; recipient: string; recipientName: string | null; subject: string | null;
  bodyPreview: string | null; status: 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'blocked_limit' | 'blocked_config' | 'cancelled';
  error: string | null; attempts: number; manual: boolean; document: { id: string; docTypeKey: string; number: string | null } | null;
  triggerRule: string | null; createdAt: string; sentAt: string | null; deliveredAt: string | null; readAt: string | null;
}

export const PrintInput = z.object({ templateId: Uuid.optional() /* default template of the doc type */ });
export interface PdfJobRow { id: string; status: 'queued' | 'rendering' | 'ready' | 'failed'; fileUrl: string | null; error: string | null }

export const WebhookEndpointInput = z.object({
  url: z.string().url().refine(u => u.startsWith('https://'), 'HTTPS only'),
  description: z.string().max(300).optional(),
  events: z.array(z.string()).min(1).max(50),
  isActive: z.boolean().default(true),
});
export interface WebhookEndpointRow { id: string; url: string; description: string | null; events: string[]; isActive: boolean; createdAt: string; version: number; /** only in the create response */ secret?: string }
export interface WebhookDeliveryRow { id: string; endpointId: string; eventType: string; status: 'pending' | 'delivered' | 'failed'; attempts: number; responseCode: number | null; createdAt: string; deliveredAt: string | null }

// Super Admin
export const ProviderCredentialInput = z.object({
  tenantId: Uuid.nullable().default(null),
  channel: z.enum(['email', 'whatsapp']),
  provider: z.enum(['ses', 'smtp', 'meta', 'bsp', 'log']),
  config: z.record(z.string(), z.unknown()).default({}),
  secret: z.string().max(4000).optional(),     // write-only; never returned
  isActive: z.boolean().default(true),
});
export const WhatsAppTemplateInput = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().min(2).max(10).default('en'),
  category: z.enum(['utility', 'marketing', 'authentication']),
  headerKind: z.enum(['none', 'text', 'document', 'image']).default('none'),
  body: z.string().min(1).max(1024),
  variables: z.array(z.object({ index: z.number().int().min(1).max(20), label: z.string().max(60) })).max(20).default([]),
  metaStatus: z.enum(['pending', 'approved', 'rejected', 'paused']).default('approved'),
  isActive: z.boolean().default(true),
});
