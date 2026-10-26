/**
 * In-memory implementation of the Phase 6 contract for building and demoing the UI before the backend lands.
 * Loaded only when the mock is switched on (see `notifyMockOn()` in ./api.ts). Never imported eagerly.
 */
import type {
  OutboundMessageRow, Page, PdfJobRow, SendPreview, TemplateRow, TriggerRuleRow, WebhookDeliveryRow, WebhookEndpointRow,
} from '@procure/schema';
import { ApiError, type RequestOptions } from '@/lib/api';
import type { ContextField, ProviderRow, TriggerEvent, WhatsAppTemplateRow } from './api';

const now = () => new Date().toISOString();
const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const sample = {
  tenant: { name: 'Acme Industries', legalName: 'Acme Industries Pvt Ltd', gstin: '27AABCA1234F1Z5', address: { line1: 'Plot 14, MIDC', city: 'Pune', state: 'Maharashtra' } },
  document: {
    number: 'PO/PUN/25-26/0042', statusLabel: 'Approved', docDate: '2026-10-20', requiredBy: '2026-11-05', totalAmount: 118000, revNo: 0,
    url: 'https://app.procure.local/docs/purchase_order/1', location: { name: 'Pune Plant', code: 'PUN' },
    party: { code: 'V-0007', name: 'Shree Ganesh Steels', email: 'sales@ganeshsteels.example', phone: '+919812345678', gstin: '27AAACS9999K1Z2' },
    values: { payment_terms: '30 days from invoice', delivery_terms: 'Door delivery' },
  },
  lines: [
    { lineNo: 1, item: { code: 'MS-PL-6', name: 'MS plate 6 mm' }, uom: 'kg', qty: 500, rate: 120, amount: 60000 },
    { lineNo: 2, item: { code: 'MS-ANG-50', name: 'MS angle 50x50x5' }, uom: 'kg', qty: 400, rate: 100, amount: 40000 },
  ],
  totals: { taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, cess: 0, grand: 118000 },
  recipient: { name: 'Shree Ganesh Steels' },
  event: { type: 'workflow.completed', at: now(), actor: { name: 'Asha Rao' } },
};

function lookup(ctx: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx);
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (n: unknown) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(n) || 0);

/** Enough Handlebars for previews: {{path}}, {{helper path …}}, {{#each list}}…{{/each}}, {{#if x}}…{{/if}}. */
export function renderMini(src: string, ctx: Record<string, unknown>): string {
  let out = src.replace(/\{\{#each\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, p: string, inner: string) => {
    const list = lookup(ctx, p);
    return Array.isArray(list) ? list.map((row, i) => renderMini(inner, { ...ctx, ...(row as object), this: row, '@index': i })).join('') : '';
  });
  out = out.replace(/\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g, (_m, p: string, a: string, b = '') => (lookup(ctx, p) ? a : b));
  return out.replace(/\{\{\{?\s*([\w.@]+)((?:\s+[^}]+)?)\s*\}?\}\}/g, (_m, head: string, rest: string) => {
    const args = rest.trim().match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    const val = (a: string) => (/^['"]/.test(a) ? a.slice(1, -1) : /^-?\d/.test(a) ? Number(a) : lookup(ctx, a));
    switch (head) {
      case 'formatMoney': return esc(money(val(args[0] ?? '')));
      case 'formatNumber': return esc(String(Number(val(args[0] ?? '')).toFixed(Number(val(args[1] ?? '2')) || 0)));
      case 'formatDate': { const d = new Date(String(val(args[0] ?? ''))); return Number.isNaN(d.getTime()) ? '' : esc(d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })); }
      case 'upper': return esc(String(val(args[0] ?? '') ?? '').toUpperCase());
      case 'lower': return esc(String(val(args[0] ?? '') ?? '').toLowerCase());
      case 'amountInWords': return 'Rupees One Lakh Eighteen Thousand Only';
      case 'qrCode': return '<svg width="64" height="64" viewBox="0 0 8 8" style="image-rendering:pixelated"><path d="M0 0h3v3H0zM5 0h3v3H5zM0 5h3v3H0zM4 4h1v1H4zM6 5h1v2H6z"/></svg>';
      default: { const v = lookup(ctx, head); return v === undefined || v === null ? '' : esc(String(v)); }
    }
  });
}

const PO_BODY = `<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10.5pt; color: #1f2328; }
  .head { display: flex; justify-content: space-between; border-bottom: 2px solid #1f2328; padding-bottom: 8px; }
  h1 { font-size: 16pt; margin: 0; letter-spacing: .02em; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th, td { border-bottom: 1px solid #c4cad2; padding: 5px 6px; text-align: left; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .tot td { border: 0; }
</style>
<div class="head">
  <div><h1>{{tenant.legalName}}</h1><div>{{tenant.address.line1}}, {{tenant.address.city}}</div><div>GSTIN {{tenant.gstin}}</div></div>
  <div style="text-align:right"><strong>Purchase order</strong><div>{{document.number}}</div><div>{{formatDate document.docDate 'DD-MMM-YYYY'}}</div></div>
</div>
<p><strong>To</strong><br>{{document.party.name}}<br>GSTIN {{document.party.gstin}}</p>
<table>
  <thead><tr><th>#</th><th>Item</th><th class="n">Qty</th><th>UoM</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead>
  <tbody>
  {{#each lines}}<tr><td>{{lineNo}}</td><td>{{item.name}}</td><td class="n">{{qty}}</td><td>{{uom}}</td><td class="n">{{formatMoney rate 'INR'}}</td><td class="n">{{formatMoney amount 'INR'}}</td></tr>{{/each}}
  </tbody>
</table>
<table class="tot">
  <tr><td class="n">Taxable</td><td class="n" style="width:9rem">{{formatMoney totals.taxable 'INR'}}</td></tr>
  <tr><td class="n">CGST</td><td class="n">{{formatMoney totals.cgst 'INR'}}</td></tr>
  <tr><td class="n">SGST</td><td class="n">{{formatMoney totals.sgst 'INR'}}</td></tr>
  <tr><td class="n"><strong>Grand total</strong></td><td class="n"><strong>{{formatMoney totals.grand 'INR'}}</strong></td></tr>
</table>
<p>{{amountInWords totals.grand 'INR'}}</p>
<p style="margin-top:28px">For {{tenant.legalName}}<br><br><br>Authorised signatory</p>`;

interface Db {
  templates: TemplateRow[]; triggers: TriggerRuleRow[]; messages: OutboundMessageRow[]; webhooks: (WebhookEndpointRow & { secret?: string })[];
  deliveries: WebhookDeliveryRow[]; jobs: Map<string, { row: PdfJobRow; polls: number; html: string }>; providers: ProviderRow[];
  wa: WhatsAppTemplateRow[]; tenantWa: Map<string, string[]>; quotaUsed: { email: number; whatsapp: number };
}

let db: Db | null = null;
function seed(): Db {
  const t = (p: Partial<TemplateRow> & Pick<TemplateRow, 'channel' | 'key' | 'name' | 'body'>): TemplateRow => ({
    id: uid(), version: 1, updatedAt: now(), docTypeKey: null, whatsappVariables: [], isDefault: false, isActive: true,
    pdfOptions: { format: 'A4', landscape: false, marginMm: { top: 15, right: 12, bottom: 15, left: 12 } }, ...p,
  });
  const wa: WhatsAppTemplateRow[] = [
    { id: uid(), name: 'po_issued', language: 'en', category: 'utility', headerKind: 'document', body: 'Hello {{1}}, purchase order {{2}} for {{3}} is attached. Please confirm the delivery date.', variables: [{ index: 1, label: 'Vendor name' }, { index: 2, label: 'PO number' }, { index: 3, label: 'Amount' }], metaStatus: 'approved', isActive: true, version: 1 },
    { id: uid(), name: 'approval_pending', language: 'en', category: 'utility', headerKind: 'none', body: '{{1}} {{2}} is waiting for your approval.', variables: [{ index: 1, label: 'Document type' }, { index: 2, label: 'Number' }], metaStatus: 'approved', isActive: true, version: 1 },
    { id: uid(), name: 'grn_received', language: 'en', category: 'utility', headerKind: 'none', body: 'Goods for {{1}} received at {{2}}.', variables: [{ index: 1, label: 'PO number' }, { index: 2, label: 'Location' }], metaStatus: 'pending', isActive: true, version: 1 },
  ];
  const poPdf = t({ channel: 'pdf', docTypeKey: 'purchase_order', key: 'po_standard', name: 'Purchase order', body: PO_BODY, isDefault: true, pdfOptions: { format: 'A4', landscape: false, marginMm: { top: 15, right: 12, bottom: 15, left: 12 }, footerHtml: '<div style="font-size:8pt;width:100%;text-align:center">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>' } });
  const poCompact = t({ channel: 'pdf', docTypeKey: 'purchase_order', key: 'po_compact', name: 'Purchase order (compact)', body: PO_BODY.replace('10.5pt', '9pt') });
  const indentPdf = t({ channel: 'pdf', docTypeKey: 'indent', key: 'indent_standard', name: 'Indent', body: '<h1>Indent {{document.number}}</h1>{{#each lines}}<p>{{lineNo}}. {{item.name}} — {{qty}} {{uom}}</p>{{/each}}', isDefault: true });
  const email = t({ channel: 'email', docTypeKey: 'purchase_order', key: 'po_approved_vendor', name: 'PO approved: email vendor', subject: 'Purchase order {{document.number}} from {{tenant.name}}', body: '<p>Dear {{recipient.name}},</p><p>Please find attached purchase order <strong>{{document.number}}</strong> for {{formatMoney document.totalAmount \'INR\'}}.</p><p>Kindly confirm the delivery date by reply.</p><p>Regards,<br>{{tenant.name}}</p>', isDefault: true });
  const waT = t({ channel: 'whatsapp', docTypeKey: 'purchase_order', key: 'po_issued_wa', name: 'PO issued (WhatsApp)', body: '-', whatsappTemplateId: wa[0]!.id, whatsappVariables: [{ index: 1, expr: '{{document.party.name}}' }, { index: 2, expr: '{{document.number}}' }, { index: 3, expr: "{{formatMoney document.totalAmount 'INR'}}" }], isDefault: true });
  const inapp = t({ channel: 'inapp', docTypeKey: null, key: 'approval_pending', name: 'Approval pending', subject: '{{document.number}} needs your approval', body: '{{event.actor.name}} submitted {{document.number}}.', isDefault: true });
  const rule: TriggerRuleRow = { id: uid(), version: 1, name: 'PO approved → email vendor', eventType: 'workflow.completed', docTypeKey: 'purchase_order', condition: 'total_amount > 0', channel: 'email', templateId: email.id, recipients: [{ type: 'party' }], attachPdfTemplateId: poPdf.id, mode: 'manual', isActive: true };
  const rule2: TriggerRuleRow = { id: uid(), version: 1, name: 'PO issued on WhatsApp', eventType: 'workflow.completed', docTypeKey: 'purchase_order', channel: 'whatsapp', templateId: waT.id, recipients: [{ type: 'party' }], attachPdfTemplateId: poPdf.id, mode: 'manual', isActive: true };
  const msg = (p: Partial<OutboundMessageRow>): OutboundMessageRow => ({
    id: uid(), channel: 'email', recipient: 'sales@ganeshsteels.example', recipientName: 'Shree Ganesh Steels', subject: 'Purchase order PO/PUN/25-26/0041 from Acme Industries',
    bodyPreview: 'Dear Shree Ganesh Steels, Please find attached purchase order PO/PUN/25-26/0041…', status: 'delivered', error: null, attempts: 1, manual: true,
    document: { id: 'doc-41', docTypeKey: 'purchase_order', number: 'PO/PUN/25-26/0041' }, triggerRule: null, createdAt: new Date(Date.now() - 86400e3).toISOString(),
    sentAt: new Date(Date.now() - 86390e3).toISOString(), deliveredAt: new Date(Date.now() - 86300e3).toISOString(), readAt: null, ...p,
  });
  return {
    templates: [poPdf, poCompact, indentPdf, email, waT, inapp],
    triggers: [rule, rule2],
    messages: [
      msg({ status: 'read', channel: 'whatsapp', recipient: '+919812345678', subject: null, bodyPreview: 'Hello Shree Ganesh Steels, purchase order PO/PUN/25-26/0041 for ₹2,36,000.00 is attached.', readAt: new Date(Date.now() - 80000e3).toISOString() }),
      msg({}),
      msg({ status: 'failed', recipient: 'accounts@bluewave.example', recipientName: 'Bluewave Traders', error: '550 Mailbox unavailable', attempts: 5, sentAt: null, deliveredAt: null, document: { id: 'doc-39', docTypeKey: 'purchase_order', number: 'PO/PUN/25-26/0039' } }),
      msg({ status: 'blocked_limit', channel: 'whatsapp', recipient: '+919900011122', recipientName: 'Bluewave Traders', subject: null, error: 'Monthly WhatsApp limit reached', attempts: 0, sentAt: null, deliveredAt: null, manual: false, triggerRule: 'PO issued on WhatsApp' }),
      msg({ status: 'sent', channel: 'inapp', recipient: 'Asha Rao', recipientName: 'Asha Rao', subject: 'IND/PUN/0102 needs your approval', document: { id: 'doc-102', docTypeKey: 'indent', number: 'IND/PUN/0102' }, deliveredAt: null, manual: false, triggerRule: 'Approval pending' }),
    ],
    webhooks: [{ id: uid(), url: 'https://erp.acme.example/hooks/procure', description: 'ERP sync', events: ['document.submitted', 'workflow.completed'], isActive: true, createdAt: now(), version: 1 }],
    deliveries: [],
    jobs: new Map(),
    providers: [
      { id: uid(), tenantId: null, tenantName: null, channel: 'email', provider: 'log', config: { from: 'Procure <no-reply@procure.local>' }, hasSecret: false, isActive: true, version: 1, updatedAt: now() },
      { id: uid(), tenantId: null, tenantName: null, channel: 'whatsapp', provider: 'log', config: {}, hasSecret: false, isActive: true, version: 1, updatedAt: now() },
    ],
    wa, tenantWa: new Map(), quotaUsed: { email: 212, whatsapp: 41 },
  };
}

const CONTEXT_FIELDS: ContextField[] = [
  { path: 'document.number', label: 'Document number', example: sample.document.number },
  { path: 'document.statusLabel', label: 'Status', example: 'Approved' },
  { path: 'document.docDate', label: 'Document date', example: sample.document.docDate },
  { path: 'document.requiredBy', label: 'Required by', example: sample.document.requiredBy },
  { path: 'document.totalAmount', label: 'Total amount', example: sample.document.totalAmount },
  { path: 'document.location.name', label: 'Location', example: 'Pune Plant' },
  { path: 'document.party.name', label: 'Vendor name', example: sample.document.party.name },
  { path: 'document.party.gstin', label: 'Vendor GSTIN', example: sample.document.party.gstin },
  { path: 'document.url', label: 'Link to document', example: sample.document.url },
  { path: 'document.values.payment_terms', label: 'Payment terms (custom field)', example: '30 days from invoice' },
  { path: 'lines', label: 'Lines (list)', example: '2 lines' },
  { path: 'lines.lineNo', label: 'Line number', example: 1 },
  { path: 'lines.item.name', label: 'Item name', example: 'MS plate 6 mm' },
  { path: 'lines.item.code', label: 'Item code', example: 'MS-PL-6' },
  { path: 'lines.qty', label: 'Quantity', example: 500 },
  { path: 'lines.uom', label: 'Unit', example: 'kg' },
  { path: 'lines.rate', label: 'Rate', example: 120 },
  { path: 'lines.amount', label: 'Amount', example: 60000 },
  { path: 'totals.taxable', label: 'Taxable value', example: 100000 },
  { path: 'totals.cgst', label: 'CGST', example: 9000 },
  { path: 'totals.sgst', label: 'SGST', example: 9000 },
  { path: 'totals.grand', label: 'Grand total', example: 118000 },
  { path: 'tenant.name', label: 'Company name', example: sample.tenant.name },
  { path: 'tenant.legalName', label: 'Legal name', example: sample.tenant.legalName },
  { path: 'tenant.gstin', label: 'Company GSTIN', example: sample.tenant.gstin },
  { path: 'recipient.name', label: 'Recipient name', example: 'Shree Ganesh Steels' },
  { path: 'event.actor.name', label: 'Who triggered it', example: 'Asha Rao' },
];

const EVENTS: TriggerEvent[] = [
  { type: 'document.submitted', label: 'Document submitted', docScoped: true },
  { type: 'document.cancelled', label: 'Document cancelled', docScoped: true },
  { type: 'document.closed', label: 'Document closed', docScoped: true },
  { type: 'workflow.stage_entered', label: 'Reached an approval stage', docScoped: true },
  { type: 'workflow.decided', label: 'Approval decision made', docScoped: true },
  { type: 'workflow.completed', label: 'Fully approved', docScoped: true },
  { type: 'workflow.sent_back', label: 'Sent back', docScoped: true },
  { type: 'workflow.sla_reminder', label: 'Approval running late', docScoped: true },
  { type: 'comment.mentioned', label: 'Someone was mentioned', docScoped: true },
  { type: 'limit.warning', label: 'Plan limit warning', docScoped: false },
];

function notFound(): never { throw new ApiError({ status: 404, code: 'NOT_FOUND', title: 'Not found' }); }
function conflict(): never { throw new ApiError({ status: 409, code: 'VERSION_CONFLICT', title: 'Someone else changed this. Reload and try again.' }); }

function makeJob(html: string): PdfJobRow {
  const row: PdfJobRow = { id: uid(), status: 'queued', fileUrl: null, error: null };
  db!.jobs.set(row.id, { row, polls: 0, html });
  return row;
}

export async function mockCall<T>(path: string, opts: RequestOptions): Promise<T> {
  db ??= seed();
  await wait(120 + Math.random() * 180);
  const method = opts.method ?? 'GET';
  const body = (opts.body ?? {}) as Record<string, unknown>;
  const q = (opts.query ?? {}) as Record<string, string | undefined>;
  const seg = path.split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  const r = <X>(v: X) => v as unknown as T;

  // ---- templates
  if (seg[0] === 'config' && seg[1] === 'templates') {
    if (seg[2] === 'context-fields') return r(CONTEXT_FIELDS);
    if (seg[2] === 'preview') {
      const tpl = body.template as { channel: string; body: string; subject?: string; pdfOptions?: { headerHtml?: string; footerHtml?: string } };
      return r({ subject: tpl.subject ? renderMini(tpl.subject, sample) : null, html: renderMini(tpl.body, sample) });
    }
    if (!seg[2]) {
      if (method === 'GET') return r(db.templates.filter(t => (!q.channel || t.channel === q.channel) && (!q.docType || t.docTypeKey === q.docType || t.docTypeKey === null)));
      const row = { ...(body as unknown as TemplateRow), id: uid(), version: 1, updatedAt: now() };
      if (row.isDefault) db.templates.forEach(t => { if (t.channel === row.channel && t.docTypeKey === row.docTypeKey) t.isDefault = false; });
      db.templates.push(row);
      return r(row);
    }
    const i = db.templates.findIndex(t => t.id === seg[2]);
    if (i < 0) notFound();
    if (seg[3] === 'test-pdf') return r(makeJob(renderMini(db.templates[i]!.body, sample)));
    if (method === 'GET') return r(db.templates[i]);
    if (method === 'DELETE') { db.templates.splice(i, 1); return r(undefined); }
    if (body.version !== db.templates[i]!.version) conflict();
    const next = { ...db.templates[i]!, ...(body as object), version: db.templates[i]!.version + 1, updatedAt: now() } as TemplateRow;
    if (next.isDefault) db.templates.forEach(t => { if (t.id !== next.id && t.channel === next.channel && t.docTypeKey === next.docTypeKey) t.isDefault = false; });
    db.templates[i] = next;
    return r(next);
  }
  if (seg[0] === 'config' && seg[1] === 'whatsapp-templates') {
    const allowed = db.wa.filter(w => w.metaStatus === 'approved' && w.isActive);
    return r(allowed.map(({ metaStatus: _m, isActive: _a, ...w }) => w));
  }
  if (seg[0] === 'pdf-jobs') {
    const j = db.jobs.get(seg[1]!);
    if (!j) notFound();
    j.polls++;
    if (j.polls >= 2 && j.row.status !== 'ready') {
      const url = URL.createObjectURL(new Blob([`<!doctype html><meta charset="utf-8"><title>PDF preview</title>${j.html}`], { type: 'text/html' }));
      j.row = { ...j.row, status: 'ready', fileUrl: url };
    } else if (j.polls === 1) j.row = { ...j.row, status: 'rendering' };
    return r(j.row);
  }

  // ---- triggers
  if (seg[0] === 'config' && seg[1] === 'triggers') {
    if (seg[2] === 'events') return r(EVENTS);
    if (!seg[2]) {
      if (method === 'GET') return r(db.triggers);
      const row = { ...(body as unknown as TriggerRuleRow), id: uid(), version: 1 };
      db.triggers.push(row);
      return r(row);
    }
    const i = db.triggers.findIndex(x => x.id === seg[2]);
    if (i < 0) notFound();
    if (method === 'GET') return r(db.triggers[i]);
    if (method === 'DELETE') { db.triggers.splice(i, 1); return r(undefined); }
    if (body.version !== db.triggers[i]!.version) conflict();
    db.triggers[i] = { ...db.triggers[i]!, ...(body as object), version: db.triggers[i]!.version + 1 } as TriggerRuleRow;
    return r(db.triggers[i]);
  }

  // ---- documents: print, send, messages
  if (seg[0] === 'docs' && seg.length >= 4) {
    const [, type, id, action, sub] = seg;
    if (action === 'print') {
      const tpl = db.templates.find(t => t.id === body.templateId) ?? db.templates.find(t => t.channel === 'pdf' && t.docTypeKey === type && t.isDefault) ?? db.templates.find(t => t.channel === 'pdf');
      return r(makeJob(renderMini(tpl?.body ?? '<p>No template</p>', sample)));
    }
    if (action === 'messages') return r(db.messages.filter(m => m.document?.id === id || (type === 'purchase_order' && m.document?.docTypeKey === type)).slice(0, 6));
    if (action === 'send') {
      const tpl = db.templates.find(t => t.id === body.templateId);
      if (!tpl) throw new ApiError({ status: 422, code: 'VALIDATION', title: 'Pick a template', errors: [{ path: 'templateId', message: 'Pick a template' }] });
      const channel = body.channel as 'email' | 'whatsapp' | 'inapp';
      const recips = (body.recipients as string[]) ?? [];
      const valid = (a: string) => (channel === 'email' ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a) : channel === 'whatsapp' ? /^\+[1-9]\d{7,14}$/.test(a) : a.length > 0);
      const wa = tpl.whatsappTemplateId ? db.wa.find(w => w.id === tpl.whatsappTemplateId) : null;
      const waBody = wa ? wa.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => renderMini(tpl.whatsappVariables.find(v => v.index === Number(n))?.expr ?? '', sample)) : '';
      const subject = channel === 'whatsapp' ? null : (body.subject as string | undefined) ?? (tpl.subject ? renderMini(tpl.subject, sample) : null);
      const html = channel === 'whatsapp' ? waBody : (body.body as string | undefined) ?? renderMini(tpl.body, sample);
      const limit = channel === 'email' ? 500 : channel === 'whatsapp' ? 50 : null;
      if (sub === 'preview') {
        const pv: SendPreview = {
          subject, body: html,
          recipients: recips.map(a => ({ address: a, name: a.includes('ganesh') || a === '+919812345678' ? 'Shree Ganesh Steels' : null, valid: valid(a), reason: valid(a) ? undefined : channel === 'email' ? 'Not an email address' : 'Use the international format, e.g. +919812345678' })),
          attachments: body.attachPdfTemplateId ? [{ name: `${sample.document.number.replace(/\//g, '-')}.pdf` }] : [],
          quota: channel === 'inapp' ? null : { used: db.quotaUsed[channel], limit },
        };
        return r(pv);
      }
      const bad = recips.filter(a => !valid(a));
      if (bad.length) throw new ApiError({ status: 422, code: 'VALIDATION', title: `Check the recipients: ${bad.join(', ')}`, errors: bad.map(a => ({ path: 'recipients', message: a })) });
      const rows = recips.map<OutboundMessageRow>(a => {
        const over = channel !== 'inapp' && limit !== null && db!.quotaUsed[channel] >= limit;
        if (!over && channel !== 'inapp') db!.quotaUsed[channel]++;
        return {
          id: uid(), channel, recipient: a, recipientName: null, subject, bodyPreview: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
          status: over ? 'blocked_limit' : 'queued', error: over ? 'Monthly limit reached' : null, attempts: 0, manual: true,
          document: { id: id!, docTypeKey: type!, number: sample.document.number }, triggerRule: null, createdAt: now(), sentAt: null, deliveredAt: null, readAt: null,
        };
      });
      db.messages.unshift(...rows);
      // Simulate the provider: sent → delivered (→ read for WhatsApp).
      for (const m of rows.filter(x => x.status === 'queued')) {
        setTimeout(() => Object.assign(m, { status: 'sent', sentAt: now(), attempts: 1 }), 1500);
        setTimeout(() => Object.assign(m, { status: 'delivered', deliveredAt: now() }), 4000);
        if (channel === 'whatsapp') setTimeout(() => Object.assign(m, { status: 'read', readAt: now() }), 7000);
      }
      return r(rows);
    }
  }

  // ---- message log
  if (seg[0] === 'messages') {
    if (seg[2] === 'retry') {
      const m = db.messages.find(x => x.id === seg[1]);
      if (!m) notFound();
      if (m.status !== 'failed') throw new ApiError({ status: 409, code: 'NOT_RETRYABLE', title: 'Only failed messages can be retried' });
      Object.assign(m, { status: 'queued', error: null });
      setTimeout(() => Object.assign(m, { status: 'sent', sentAt: now(), attempts: m.attempts + 1 }), 1500);
      return r({ ...m });
    }
    const list = db.messages.filter(m => (!q.channel || m.channel === q.channel) && (!q.status || m.status === q.status) && (!q.documentId || m.document?.id === q.documentId || m.document?.number?.includes(q.documentId)));
    const page: Page<OutboundMessageRow> = { data: list.map(m => ({ ...m })), nextCursor: null };
    return r(page);
  }

  // ---- webhooks
  if (seg[0] === 'config' && seg[1] === 'webhooks') {
    if (!seg[2]) {
      if (method === 'GET') return r(db.webhooks.map(({ secret: _s, ...w }) => w));
      if (db.webhooks.length >= 3) throw new ApiError({ status: 409, code: 'LIMIT_EXCEEDED.webhook_endpoints', title: 'Your plan allows 3 webhook endpoints. Remove one or upgrade the plan.' });
      const secret = `whsec_${uid().replace(/-/g, '')}`;
      const row = { ...(body as unknown as WebhookEndpointRow), id: uid(), createdAt: now(), version: 1, description: (body.description as string) ?? null, isActive: body.isActive !== false };
      db.webhooks.push(row);
      return r({ ...row, secret });
    }
    const i = db.webhooks.findIndex(w => w.id === seg[2]);
    if (i < 0) notFound();
    if (seg[3] === 'deliveries') return r(db.deliveries.filter(d => d.endpointId === seg[2]));
    if (seg[3] === 'test') {
      const ok = !db.webhooks[i]!.url.includes('fail');
      const d: WebhookDeliveryRow = { id: uid(), endpointId: seg[2]!, eventType: 'webhook.test', status: ok ? 'delivered' : 'failed', attempts: 1, responseCode: ok ? 200 : 500, createdAt: now(), deliveredAt: ok ? now() : null };
      db.deliveries.unshift(d);
      return r(d);
    }
    if (method === 'DELETE') { db.webhooks.splice(i, 1); return r(undefined); }
    if (body.version !== db.webhooks[i]!.version) conflict();
    db.webhooks[i] = { ...db.webhooks[i]!, ...(body as object), version: db.webhooks[i]!.version + 1 } as WebhookEndpointRow;
    return r(db.webhooks[i]);
  }

  // ---- platform
  if (seg[0] === 'platform' && seg[1] === 'providers') {
    if (!seg[2]) {
      if (method === 'GET') return r(db.providers);
      const { secret, ...rest } = body as { secret?: string };
      const row = { ...(rest as unknown as ProviderRow), id: uid(), hasSecret: !!secret, version: 1, updatedAt: now() };
      db.providers.push(row);
      return r(row);
    }
    const i = db.providers.findIndex(p => p.id === seg[2]);
    if (i < 0) notFound();
    if (method === 'DELETE') { db.providers.splice(i, 1); return r(undefined); }
    const { secret, ...rest } = body as { secret?: string };
    db.providers[i] = { ...db.providers[i]!, ...(rest as object), hasSecret: secret ? true : db.providers[i]!.hasSecret, version: (db.providers[i]!.version ?? 1) + 1, updatedAt: now() } as ProviderRow;
    return r(db.providers[i]);
  }
  if (seg[0] === 'platform' && seg[1] === 'whatsapp-templates') {
    if (!seg[2]) {
      if (method === 'GET') return r(db.wa);
      const row = { ...(body as unknown as WhatsAppTemplateRow), id: uid(), version: 1, createdAt: now() };
      db.wa.push(row);
      return r(row);
    }
    const i = db.wa.findIndex(p => p.id === seg[2]);
    if (i < 0) notFound();
    if (method === 'DELETE') { db.wa.splice(i, 1); return r(undefined); }
    db.wa[i] = { ...db.wa[i]!, ...(body as object), version: (db.wa[i]!.version ?? 1) + 1 } as WhatsAppTemplateRow;
    return r(db.wa[i]);
  }
  if (seg[0] === 'platform' && seg[1] === 'tenants' && seg[3] === 'whatsapp-templates') {
    if (method === 'PUT') { db.tenantWa.set(seg[2]!, (body.templateIds as string[]) ?? []); return r({ templateIds: db.tenantWa.get(seg[2]!) }); }
    return r(db.tenantWa.get(seg[2]!) ?? db.wa.slice(0, 2).map(w => w.id));
  }
  notFound();
}
