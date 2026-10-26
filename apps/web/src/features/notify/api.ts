'use client';
/**
 * Phase 6 client (docs/contracts/phase-6-api.md, packages/schema/src/notify.ts): templates + PDF, trigger rules,
 * manual sends, message log, outgoing webhooks, and the Super Admin providers / WhatsApp catalogue.
 *
 * Every call goes through `call()`, which uses the real API unless the typed mock is switched on
 * (`NEXT_PUBLIC_NOTIFY_MOCK=1` at build time, or `localStorage['procure.notifyMock'] = '1'` in a tab). The mock
 * (./mock.ts) implements the same contract in memory and is only loaded when switched on.
 */
import type {
  ManualSendInput, OutboundMessageRow, Page, PdfJobRow, PrintInput, SendPreview, TemplateInput, TemplateRow,
  TriggerRuleInput, TriggerRuleRow, WebhookDeliveryRow, WebhookEndpointInput, WebhookEndpointRow,
  ProviderCredentialInput, WhatsAppTemplateInput,
} from '@procure/schema';
import type { z } from 'zod';
import { api, type RequestOptions } from '@/lib/api';
import { asArray } from '@/lib/types';

export type {
  OutboundMessageRow, PdfJobRow, SendPreview, TemplateRow, TriggerRuleRow, WebhookDeliveryRow, WebhookEndpointRow,
};

export type TemplateChannel = 'pdf' | 'email' | 'whatsapp' | 'inapp';
export type MessageChannel = 'email' | 'whatsapp' | 'inapp';
export type MessageStatus = OutboundMessageRow['status'];

/** Bodies as the forms build them (defaults applied by the server). */
export type TemplateBody = z.input<typeof TemplateInput>;
export type TriggerBody = z.input<typeof TriggerRuleInput>;
export type TriggerRecipientSpec = TriggerBody['recipients'][number];
export type ManualSendBody = z.input<typeof ManualSendInput>;
export type WebhookBody = z.input<typeof WebhookEndpointInput>;
export type ProviderBody = z.input<typeof ProviderCredentialInput>;
export type WhatsAppTemplateBody = z.input<typeof WhatsAppTemplateInput>;
export type PdfOptions = NonNullable<TemplateInput['pdfOptions']>;

export interface ContextField { path: string; label: string; example?: unknown }
export interface TriggerEvent { type: string; label: string; docScoped: boolean }
export interface TemplatePreview { subject: string | null; html: string }

/** `app.my_whatsapp_templates()` row (tenant view) and the platform catalogue row. */
export interface WhatsAppTemplate {
  id: string; name: string; language: string; category: 'utility' | 'marketing' | 'authentication';
  headerKind: 'none' | 'text' | 'document' | 'image'; body: string; variables: { index: number; label: string }[];
}
export interface WhatsAppTemplateRow extends WhatsAppTemplate {
  metaStatus: 'pending' | 'approved' | 'rejected' | 'paused'; isActive: boolean; createdAt?: string; version?: number;
}
/** Platform provider credential row. Secrets are never returned; `hasSecret` says whether one is stored. */
export interface ProviderRow {
  id: string; tenantId: string | null; tenantName?: string | null; channel: 'email' | 'whatsapp';
  provider: 'ses' | 'smtp' | 'meta' | 'bsp' | 'log'; config: Record<string, unknown>; hasSecret?: boolean;
  isActive: boolean; updatedAt?: string; version?: number;
}

export interface MessageFilters { channel?: MessageChannel; status?: MessageStatus; documentId?: string }

// ---------------------------------------------------------------------------
// Transport (real API or typed mock)
// ---------------------------------------------------------------------------

export function notifyMockOn(): boolean {
  if (process.env.NEXT_PUBLIC_NOTIFY_MOCK === '1') return true;
  try { return typeof window !== 'undefined' && window.localStorage.getItem('procure.notifyMock') === '1'; } catch { return false; }
}

let mockMod: Promise<typeof import('./mock')> | null = null;

async function call<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (notifyMockOn()) {
    mockMod ??= import('./mock');
    return (await mockMod).mockCall<T>(path, opts);
  }
  return api<T>(path, opts);
}
type Q = RequestOptions['query'];
const get = <T>(path: string, query?: Q) => call<T>(path, { query });
const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) => call<T>(path, { method: 'POST', body: body ?? {}, headers });
const put = <T>(path: string, body?: unknown) => call<T>(path, { method: 'PUT', body });
const del = <T>(path: string) => call<T>(path, { method: 'DELETE' });
const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const templatesApi = {
  list: async (q: { channel?: TemplateChannel; docType?: string } = {}) => asArray(await get<TemplateRow[] | Page<TemplateRow>>('/config/templates', q)),
  get: (id: string) => get<TemplateRow>(`/config/templates/${enc(id)}`),
  create: (body: TemplateBody) => post<TemplateRow>('/config/templates', body),
  update: (id: string, body: TemplateBody & { version: number }) => put<TemplateRow>(`/config/templates/${enc(id)}`, body),
  remove: (id: string) => del<void>(`/config/templates/${enc(id)}`),
  preview: (template: TemplateBody, documentId?: string) => post<TemplatePreview>('/config/templates/preview', { template, documentId }),
  testPdf: (id: string, documentId?: string) => post<PdfJobRow>(`/config/templates/${enc(id)}/test-pdf`, { documentId }),
  contextFields: async (docType?: string | null) => asArray(await get<ContextField[] | Page<ContextField>>('/config/templates/context-fields', { docType: docType ?? undefined })),
  whatsapp: async () => asArray(await get<WhatsAppTemplate[] | Page<WhatsAppTemplate>>('/config/whatsapp-templates')),
};

export const pdfApi = {
  print: (type: string, id: string, body: z.input<typeof PrintInput>) => post<PdfJobRow>(`/docs/${enc(type)}/${enc(id)}/print`, body),
  job: (id: string) => get<PdfJobRow>(`/pdf-jobs/${enc(id)}`),
};

export const triggersApi = {
  list: async () => asArray(await get<TriggerRuleRow[] | Page<TriggerRuleRow>>('/config/triggers')),
  get: (id: string) => get<TriggerRuleRow>(`/config/triggers/${enc(id)}`),
  create: (body: TriggerBody) => post<TriggerRuleRow>('/config/triggers', body),
  update: (id: string, body: TriggerBody & { version: number }) => put<TriggerRuleRow>(`/config/triggers/${enc(id)}`, body),
  remove: (id: string) => del<void>(`/config/triggers/${enc(id)}`),
  events: async () => asArray(await get<TriggerEvent[] | Page<TriggerEvent>>('/config/triggers/events')),
};

export const sendApi = {
  preview: (type: string, id: string, body: Omit<ManualSendBody, 'idempotencyKey'>) => post<SendPreview>(`/docs/${enc(type)}/${enc(id)}/send/preview`, body),
  send: (type: string, id: string, body: ManualSendBody) =>
    post<OutboundMessageRow[]>(`/docs/${enc(type)}/${enc(id)}/send`, body, { 'Idempotency-Key': body.idempotencyKey }),
  docMessages: async (type: string, id: string) => asArray(await get<OutboundMessageRow[] | Page<OutboundMessageRow>>(`/docs/${enc(type)}/${enc(id)}/messages`)),
};

export const messagesApi = {
  list: (f: MessageFilters, cursor: string | null, limit = 50) => get<Page<OutboundMessageRow>>('/messages', { ...f, cursor: cursor ?? undefined, limit }),
  retry: (id: string) => post<OutboundMessageRow>(`/messages/${enc(id)}/retry`),
};

export const webhooksApi = {
  list: async () => asArray(await get<WebhookEndpointRow[] | Page<WebhookEndpointRow>>('/config/webhooks')),
  create: (body: WebhookBody) => post<WebhookEndpointRow>('/config/webhooks', body),
  update: (id: string, body: WebhookBody & { version: number }) => put<WebhookEndpointRow>(`/config/webhooks/${enc(id)}`, body),
  remove: (id: string) => del<void>(`/config/webhooks/${enc(id)}`),
  deliveries: async (id: string) => asArray(await get<WebhookDeliveryRow[] | Page<WebhookDeliveryRow>>(`/config/webhooks/${enc(id)}/deliveries`)),
  test: (id: string) => post<WebhookDeliveryRow>(`/config/webhooks/${enc(id)}/test`),
};

export const platformNotifyApi = {
  providers: async () => asArray(await get<ProviderRow[] | Page<ProviderRow>>('/platform/providers')),
  createProvider: (body: ProviderBody) => post<ProviderRow>('/platform/providers', body),
  updateProvider: (id: string, body: ProviderBody & { version?: number }) => put<ProviderRow>(`/platform/providers/${enc(id)}`, body),
  removeProvider: (id: string) => del<void>(`/platform/providers/${enc(id)}`),
  waTemplates: async () => asArray(await get<WhatsAppTemplateRow[] | Page<WhatsAppTemplateRow>>('/platform/whatsapp-templates')),
  createWaTemplate: (body: WhatsAppTemplateBody) => post<WhatsAppTemplateRow>('/platform/whatsapp-templates', body),
  updateWaTemplate: (id: string, body: WhatsAppTemplateBody & { version?: number }) => put<WhatsAppTemplateRow>(`/platform/whatsapp-templates/${enc(id)}`, body),
  removeWaTemplate: (id: string) => del<void>(`/platform/whatsapp-templates/${enc(id)}`),
  /** Allowed template ids for a tenant. Accepts ids, rows, or `{ templateIds }`. */
  tenantWaTemplates: async (tenantId: string) => {
    const r = await get<unknown>(`/platform/tenants/${enc(tenantId)}/whatsapp-templates`);
    const list = Array.isArray(r) ? r : (r as { templateIds?: unknown[]; data?: unknown[] })?.templateIds ?? (r as { data?: unknown[] })?.data ?? [];
    return list.map(x => (typeof x === 'string' ? x : String((x as { id?: string; templateId?: string }).templateId ?? (x as { id?: string }).id)));
  },
  setTenantWaTemplates: (tenantId: string, templateIds: string[]) => put<unknown>(`/platform/tenants/${enc(tenantId)}/whatsapp-templates`, { templateIds }),
};

export const notifyKeys = {
  templates: (q: { channel?: string; docType?: string } = {}) => ['notify', 'templates', q] as const,
  templatesAll: ['notify', 'templates'] as const,
  template: (id: string) => ['notify', 'template', id] as const,
  contextFields: (docType: string | null | undefined) => ['notify', 'context-fields', docType ?? ''] as const,
  waAllowed: ['notify', 'wa-allowed'] as const,
  triggers: ['notify', 'triggers'] as const,
  events: ['notify', 'events'] as const,
  docMessages: (type: string, id: string) => ['notify', 'doc-messages', type, id] as const,
  messages: ['notify', 'messages'] as const,
  webhooks: ['notify', 'webhooks'] as const,
  deliveries: (id: string) => ['notify', 'webhook-deliveries', id] as const,
  providers: ['notify', 'providers'] as const,
  waCatalogue: ['notify', 'wa-catalogue'] as const,
  tenantWa: (id: string) => ['notify', 'tenant-wa', id] as const,
};
