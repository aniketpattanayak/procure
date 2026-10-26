import { Injectable } from '@nestjs/common';
import { ErrorCode, ManualSendInput, OutboundMessageRow, Page, SendPreview } from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Tx } from '../../core/db.service';
import type { RenderHiddenFields } from '../../core/ports';
import { DbService } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';
import { docAction, DocActor, DocumentsService } from '../documents';
import { DocsPortRef } from '../workflow';
import { OutboundService } from './outbound.service';
import { NotifyPlatformReader } from './platform/usage.reader';
import { Recipient, RecipientResolver } from './recipients';
import { RendererRef } from './renderer';
import { formatWhatsAppVariables } from './presentation';
import { monthPeriod, normaliseAddress } from './util/address';

export const MessageListQuery = z.object({
  channel: z.enum(['email', 'whatsapp', 'inapp']).optional(),
  status: z.enum(['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked_limit', 'blocked_config', 'cancelled']).optional(),
  documentId: z.string().uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const PreviewInput = ManualSendInput.omit({ idempotencyKey: true });
type Send = z.infer<typeof ManualSendInput>;
type Preview = z.infer<typeof PreviewInput>;

export interface TemplateOption { id: string; name: string; isDefault: boolean }
export interface ChannelOptions { templates: TemplateOption[]; suggested: { ruleId: string; name: string; templateId: string; attachPdfTemplateId: string | null; recipients: string[] }[] }
export interface SendOptions {
  email: ChannelOptions | null;
  whatsapp: ChannelOptions | null;
  pdfTemplates: TemplateOption[];
  party: { name: string; email: string | null; phone: string | null } | null;
  quota: { email: { used: number; limit: number | null } | null; whatsapp: { used: number; limit: number | null } | null };
}

export interface SendSuggestion {
  ruleId: string; name: string; channel: 'email' | 'whatsapp' | 'inapp'; templateId: string; attachPdfTemplateId: string | null;
  recipients: { address: string; name: string | null }[];
}

const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
/** Cursor = exact created_at text (microseconds) + id: rows created in one transaction share created_at. */
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(c: string): { at: string; id: string } {
  const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) throw bad('cursor', 'The page cursor is invalid. Start again from the first page.');
  return { at, id };
}

interface MsgDb {
  id: string; channel: OutboundMessageRow['channel']; recipient: string; recipient_name: string | null; subject: string | null; body_preview: string | null;
  status: OutboundMessageRow['status']; error: string | null; attempts: number; manual: boolean; document_id: string | null; doc_type_key: string | null; doc_number: string | null;
  rule_name: string | null; created_at: Date; sent_at: Date | null; delivered_at: Date | null; read_at: Date | null;
}
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
export const toMessageRow = (m: MsgDb): OutboundMessageRow => ({
  id: m.id, channel: m.channel, recipient: m.recipient, recipientName: m.recipient_name, subject: m.subject,
  bodyPreview: m.body_preview === null ? null : m.channel === 'email' ? plain(m.body_preview).slice(0, 500) : m.body_preview.slice(0, 500),
  status: m.status, error: m.error, attempts: m.attempts, manual: m.manual,
  document: m.document_id ? { id: m.document_id, docTypeKey: m.doc_type_key ?? '', number: m.doc_number } : null,
  triggerRule: m.rule_name, createdAt: new Date(m.created_at).toISOString(), sentAt: iso(m.sent_at), deliveredAt: iso(m.delivered_at), readAt: iso(m.read_at),
});
/** HTML → readable text for previews. */
export function plain(html: string): string {
  return html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Message log, retries, per-document messages, manual send (preview → edit → send) and suggested sends. */
@Injectable()
export class MessagesService {
  constructor(
    private readonly db: DbService,
    private readonly ent: EntitlementsService,
    private readonly docs: DocumentsService,
    private readonly port: DocsPortRef,
    private readonly outbound: OutboundService,
    private readonly renderer: RendererRef,
    private readonly recipients: RecipientResolver,
    private readonly reader: NotifyPlatformReader,
  ) {}

  private base(tx: Tx) {
    return tx.selectFrom('app.outbound_message as m')
      .leftJoin('app.document as d', 'd.id', 'm.document_id')
      .leftJoin('app.doc_type as t', 't.id', 'd.doc_type_id')
      .leftJoin('app.trigger_rule as r', 'r.id', 'm.trigger_rule_id')
      .select(['m.id', 'm.channel', 'm.recipient', 'm.recipient_name', 'm.subject', 'm.body_preview', 'm.status', 'm.error', 'm.attempts', 'm.manual', 'm.document_id',
        't.key as doc_type_key', 'd.number as doc_number', 'r.name as rule_name', 'm.created_at', 'm.sent_at', 'm.delivered_at', 'm.read_at',
        sql<string>`to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('cursor_at')]);
  }

  async list(tx: Tx, q: z.infer<typeof MessageListQuery>): Promise<Page<OutboundMessageRow>> {
    let qb = this.base(tx);
    if (q.channel) qb = qb.where('m.channel', '=', q.channel);
    if (q.status) qb = qb.where('m.status', '=', q.status);
    if (q.documentId) qb = qb.where('m.document_id', '=', q.documentId);
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      qb = qb.where(sql<boolean>`(m.created_at, m.id) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const rows = (await qb.orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(q.limit + 1).execute()) as MsgDb[];
    const more = rows.length > q.limit;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { data: page.map(toMessageRow), nextCursor: more && last ? encodeCursor((last as MsgDb & { cursor_at: string }).cursor_at, last.id) : null };
  }

  async byIds(tx: Tx, ids: string[]): Promise<OutboundMessageRow[]> {
    if (!ids.length) return [];
    const rows = (await this.base(tx).where('m.id', 'in', ids).orderBy('m.created_at').orderBy('m.id').execute()) as MsgDb[];
    return rows.map(toMessageRow);
  }

  /** Failed messages only: back to queued (no new quota) and re-enqueued (the PDF choice of the first send is kept). */
  async retry(tenantId: string, id: string): Promise<OutboundMessageRow> {
    const m = await this.db.tenantTx(tenantId, async tx => {
      const cur = await tx.selectFrom('app.outbound_message as m').leftJoin('app.trigger_rule as r', 'r.id', 'm.trigger_rule_id')
        .select(['m.id', 'm.channel', 'm.status', 'r.attach_pdf_template_id']).where('m.id', '=', id).forUpdate('m').executeTakeFirst();
      if (!cur) throw AppError.notFound('Message');
      if (cur.status !== 'failed') throw AppError.conflict('Only failed messages can be retried.', { status: cur.status });
      if (cur.channel === 'inapp') throw AppError.conflict('In-app messages cannot be retried.');
      await tx.updateTable('app.outbound_message').set({ status: 'queued', error: null }).where('id', '=', id).execute();
      return cur;
    });
    await this.outbound.requeue(m.channel as 'email' | 'whatsapp', { messageId: id, tenantId, attachPdfTemplateId: m.attach_pdf_template_id }, { replaceFinished: true });
    return this.db.tenantTx(tenantId, async tx => (await this.byIds(tx, [id]))[0]!);
  }

  // ------------------------------------------------------------------ per document
  private async target(tx: Tx, actor: DocActor, typeKey: string, id: string) {
    const type = await this.docs.typeFor(tx, actor, typeKey);
    const doc = await this.docs.access(tx, actor, type, id);
    return { type, doc };
  }

  async forDocument(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<OutboundMessageRow[]> {
    await this.target(tx, actor, typeKey, id);
    const rows = (await this.base(tx).where('m.document_id', '=', id).orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(500).execute()) as MsgDb[];
    return rows.map(toMessageRow);
  }

  /** Manual rules of the doc type ("Email vendor") with their resolved recipients, for the send dialog. */
  async suggestions(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<SendSuggestion[]> {
    await this.target(tx, actor, typeKey, id);
    const rules = await tx.selectFrom('app.trigger_rule').select(['id', 'name', 'channel', 'template_id', 'attach_pdf_template_id', 'recipients'])
      .where('is_active', '=', true).where('mode', '=', 'manual').where('channel', 'in', ['email', 'whatsapp'])
      .where(eb => eb.or([eb('doc_type_key', '=', typeKey), eb('doc_type_key', 'is', null)])).orderBy('name').execute();
    const allowed = rules.filter(r => actor.perms === null || actor.perms.keys.includes(docAction(typeKey, `send_${r.channel}`)));
    if (!allowed.length) return [];
    const snap = await this.port.get().snapshot(tx, id, { lock: false });
    const out: SendSuggestion[] = [];
    for (const r of allowed) {
      const { to } = await this.recipients.resolve(tx, actor.tenantId, r.channel, (r.recipients ?? []) as Recipient[], snap);
      out.push({ ruleId: r.id, name: r.name, channel: r.channel, templateId: r.template_id, attachPdfTemplateId: r.attach_pdf_template_id, recipients: to.map(x => ({ address: x.address, name: x.name })) });
    }
    return out;
  }

  /**
   * Everything the send dialog needs, for holders of doc.<type>:action.send_email / send_whatsapp (no config keys):
   * per channel (null when not allowed or not in plan) the usable templates and the rules' suggested recipients,
   * PDF templates (only with the print key), the party's contact and this month's quota.
   */
  async options(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<SendOptions> {
    const { type } = await this.target(tx, actor, typeKey, id);
    const holds = (k: string) => actor.perms === null || actor.perms.keys.includes(docAction(type.key, k));
    if (!holds('send_email') && !holds('send_whatsapp')) throw AppError.forbidden();
    const snap = await this.port.get().snapshot(tx, id, { lock: false });
    const state = await this.ent.state(actor.tenantId);
    const period = monthPeriod(state?.timezone ?? 'Asia/Kolkata');
    const templatesOf = (channel: 'email' | 'whatsapp' | 'pdf') => tx.selectFrom('app.message_template').select(['id', 'name', 'is_default', 'whatsapp_template_id'])
      .where('channel', '=', channel).where('is_active', '=', true).where(eb => eb.or([eb('doc_type_key', '=', type.key), eb('doc_type_key', 'is', null)]))
      .orderBy('is_default', 'desc').orderBy('name').execute();
    const channel = async (ch: 'email' | 'whatsapp'): Promise<ChannelOptions | null> => {
      if (!holds(`send_${ch}`) || !state?.features.includes(ch)) return null;
      let rows = await templatesOf(ch);
      if (ch === 'whatsapp') {
        const allowed = new Set((await sql<{ id: string }>`select id from app.my_whatsapp_templates()`.execute(tx)).rows.map(r => r.id));
        rows = rows.filter(r => r.whatsapp_template_id && allowed.has(r.whatsapp_template_id));
      }
      const rules = await tx.selectFrom('app.trigger_rule').select(['id', 'name', 'template_id', 'attach_pdf_template_id', 'recipients'])
        .where('is_active', '=', true).where('mode', '=', 'manual').where('channel', '=', ch)
        .where(eb => eb.or([eb('doc_type_key', '=', type.key), eb('doc_type_key', 'is', null)])).orderBy('name').execute();
      const suggested: ChannelOptions['suggested'] = [];
      for (const r of rules) {
        const { to } = await this.recipients.resolve(tx, actor.tenantId, ch, (r.recipients ?? []) as Recipient[], snap);
        suggested.push({ ruleId: r.id, name: r.name, templateId: r.template_id, attachPdfTemplateId: r.attach_pdf_template_id, recipients: to.map(x => x.address) });
      }
      return { templates: rows.map(r => ({ id: r.id, name: r.name, isDefault: r.is_default })), suggested };
    };
    const [email, whatsapp] = [await channel('email'), await channel('whatsapp')];
    const pdfTemplates = holds('print') ? (await templatesOf('pdf')).map(r => ({ id: r.id, name: r.name, isDefault: r.is_default })) : [];
    let party: SendOptions['party'] = null;
    if (typeof snap.values.party === 'string') {
      const m = await tx.selectFrom('app.master_record').select(['name', 'data']).where('id', '=', snap.values.party).where('is_deleted', '=', false).executeTakeFirst();
      if (m) {
        const d = (m.data ?? {}) as Record<string, unknown>;
        const e = typeof d.email === 'string' ? normaliseAddress('email', d.email) : null;
        const ph = [d.whatsapp, d.phone, d.mobile].find((x): x is string => typeof x === 'string' && !!x.trim());
        const p = ph ? normaliseAddress('whatsapp', ph) : null;
        party = { name: m.name, email: e?.valid ? e.address : null, phone: p?.valid ? p.address : null };
      }
    }
    const quota = {
      email: email ? await this.reader.usage(actor.tenantId, 'email_per_month', period) : null,
      whatsapp: whatsapp ? await this.reader.usage(actor.tenantId, 'whatsapp_per_month', period) : null,
    };
    return { email, whatsapp, pdfTemplates, party, quota };
  }

  private async prepare(tx: Tx, actor: DocActor, typeKey: string, id: string, input: Preview) {
    const { type, doc } = await this.target(tx, actor, typeKey, id);
    if (input.channel === 'inapp') throw bad('channel', 'Choose email or WhatsApp.');
    if (actor.perms !== null && !actor.perms.keys.includes(docAction(type.key, `send_${input.channel}`))) throw AppError.forbidden();
    const tpl = await tx.selectFrom('app.message_template').select(['id', 'channel', 'doc_type_key', 'whatsapp_template_id', 'is_active', 'whatsapp_variables']).where('id', '=', input.templateId).executeTakeFirst();
    if (!tpl || !tpl.is_active || tpl.channel !== input.channel) throw bad('templateId', `Choose an active ${input.channel} template.`);
    if (tpl.doc_type_key && tpl.doc_type_key !== type.key) throw bad('templateId', `This template is for "${tpl.doc_type_key}" documents.`);
    if (input.channel === 'whatsapp' && input.body !== undefined) throw bad('body', 'WhatsApp messages use an approved template; the text cannot be edited.');
    if (input.attachPdfTemplateId) {
      const pdf = await tx.selectFrom('app.message_template').select(['channel', 'doc_type_key', 'is_active']).where('id', '=', input.attachPdfTemplateId).executeTakeFirst();
      if (!pdf || !pdf.is_active || pdf.channel !== 'pdf' || (pdf.doc_type_key && pdf.doc_type_key !== type.key)) throw bad('attachPdfTemplateId', 'Choose an active PDF template for this document type.');
    }
    // Names for known addresses (the party, users); tokens `party` / `submitter` resolve server-side.
    const snap = await this.port.get().snapshot(tx, id, { lock: false });
    const known = await this.recipients.resolve(tx, actor.tenantId, input.channel, [{ type: 'party' }, { type: 'submitter' }], snap);
    const nameOf = new Map(known.to.map(k => [k.address, k.name]));
    const recipients: { address: string; valid: boolean; reason?: string; name?: string | null }[] = [];
    const seen = new Set<string>();
    for (const raw of input.recipients) {
      const token = raw.trim().toLowerCase();
      let r: { address: string; valid: boolean; reason?: string; name?: string | null };
      if (token === 'party' || token === 'submitter') {
        const hit = known.to.find(k => k.source === token);
        const why = known.skipped.find(k => k.source === token)?.reason;
        r = hit ? { address: hit.address, valid: true, name: hit.name } : { address: token, valid: false, reason: why ?? (token === 'party' ? 'The document has no vendor contact' : 'The document has no submitter contact') };
      } else r = normaliseAddress(input.channel as 'email' | 'whatsapp', raw);
      if (r.valid && seen.has(r.address)) continue;
      seen.add(r.address);
      recipients.push(r);
    }
    const plainAddrs = recipients.filter(r => r.valid).map(r => r.address);
    const users = plainAddrs.length ? await tx.selectFrom('app.tenant_user').select(['name', 'email', 'phone'])
      .where(eb => eb.or([eb('email', 'in', plainAddrs), eb('phone', 'in', plainAddrs)])).execute() : [];
    for (const u of users) nameOf.set(input.channel === 'email' ? u.email.toLowerCase() : (u.phone ?? ''), u.name);
    return { type, doc, tpl, recipients: recipients.map(r => ({ address: r.address, valid: r.valid, ...(r.reason ? { reason: r.reason } : {}), name: r.name ?? nameOf.get(r.address) ?? null })) };
  }

  private async senderHidden(tx: Tx, actor: DocActor, documentId: string): Promise<RenderHiddenFields | null> {
    return (await this.renderer.get().hiddenFields?.(tx, documentId, actor)) ?? null;
  }

  async preview(tx: Tx, actor: DocActor, typeKey: string, id: string, input: Preview): Promise<SendPreview> {
    const { doc, tpl, recipients } = await this.prepare(tx, actor, typeKey, id, input);
    const gate = await this.outbound.gate(tx, actor.tenantId, input.channel, tpl);
    // QA47-BUG-006: a manual send shows (and sends) only what the sender can read.
    const hidden = await this.senderHidden(tx, actor, id);
    const docCtx = await this.renderer.get().documentContext(tx, id, { hidden });
    const ctx = { ...docCtx, recipient: { name: recipients[0]?.name ?? '' }, event: { type: 'manual', at: new Date().toISOString(), actor: { name: '' }, comment: null } };
    const r = await this.renderer.get().render(tx, input.templateId, ctx);
    let subject = r.subject;
    let body = r.body;
    if (input.channel === 'email') {
      if (input.subject !== undefined) subject = input.subject;
      if (input.body !== undefined) body = input.body;
    } else if (gate.waTemplate) {
      const vars = formatWhatsAppVariables(r.whatsappVariables ?? [], (tpl.whatsapp_variables ?? []) as { index: number; expr: string }[], ctx);
      body = gate.waTemplate.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => vars[Number(n) - 1] ?? '');
      subject = null;
    }
    const attach = input.attachPdfTemplateId || (input.channel === 'whatsapp' && gate.waTemplate?.header_kind === 'document');
    const state = await this.ent.state(actor.tenantId);
    const quota = await this.reader.usage(actor.tenantId, `${input.channel}_per_month`, monthPeriod(state?.timezone ?? 'Asia/Kolkata'));
    return {
      subject, body,
      recipients: recipients.map(x => ({ address: x.address, name: x.name, valid: x.valid, ...(x.reason ? { reason: x.reason } : {}) })),
      attachments: attach ? [{ name: `${(doc.number ?? 'document').replace(/[^\w.-]+/g, '-')}.pdf` }] : [],
      quota,
    };
  }

  /** Validates, creates one message per recipient (idempotent on the client key) and enqueues after commit. */
  async send(actor: DocActor, typeKey: string, id: string, input: Send): Promise<OutboundMessageRow[]> {
    const res = await this.db.tenantTx(actor.tenantId, async tx => {
      const { recipients } = await this.prepare(tx, actor, typeKey, id, input);
      const invalid = recipients.map((r, k) => ({ r, k })).filter(x => !x.r.valid);
      if (invalid.length) {
        throw new AppError(400, ErrorCode.VALIDATION, `${invalid[0]!.r.address}: ${invalid[0]!.r.reason}`, undefined,
          invalid.map(x => ({ path: `recipients.${x.k}`, message: x.r.reason ?? 'Invalid address' })));
      }
      const hidden = await this.senderHidden(tx, actor, id);
      const ctx = await this.renderer.get().documentContext(tx, id, { hidden });
      const user = actor.userId ? await tx.selectFrom('app.tenant_user').select('name').where('id', '=', actor.userId).executeTakeFirst() : null;
      return this.outbound.create(tx, {
        tenantId: actor.tenantId, channel: input.channel, templateId: input.templateId, documentId: id,
        recipients: recipients.map(r => ({ address: r.address, name: r.name, userId: null, source: 'fixed' as const })),
        keyBase: `manual:${input.idempotencyKey}`, attachPdfTemplateId: input.attachPdfTemplateId ?? null, manual: true, createdBy: actor.userId, hidden,
        context: { ...ctx, event: { type: 'manual', at: new Date().toISOString(), actor: { name: user?.name ?? '' }, comment: null } },
        edit: input.channel === 'email' ? { subject: input.subject, body: input.body } : undefined,
        link: `/docs/${typeKey}/${id}`,
      });
    });
    await this.outbound.enqueue(res.enqueue);
    return this.db.tenantTx(actor.tenantId, tx => this.byIds(tx, res.ids));
  }
}
