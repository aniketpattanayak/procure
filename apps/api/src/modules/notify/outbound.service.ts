import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import type { RenderHiddenFields } from '../../core/ports';
import { EntitlementsService } from '../../core/entitlements.service';
import { QueueService } from '../../core/queue.service';
import { DocsPortRef } from '../workflow';
import { ProviderStore } from './platform/providers.store';
import { formatWhatsAppVariables } from './presentation';
import { consumeQuota, notifyQuotaCrossing } from './quota';
import type { Channel, Resolved } from './recipients';
import { RendererRef } from './renderer';
import { monthPeriod } from './util/address';
import { sha256hex } from './util/crypto';

export const SEND_QUEUE = { email: 'send-email', whatsapp: 'send-whatsapp' } as const;
/** Contract: attempts 5, exponential backoff (10 s, 20 s, 40 s, 80 s). */
export const SEND_JOB_OPTS = { attempts: 5, backoff: { type: 'exponential' as const, delay: 10_000 } };
/** Full rendered bodies are kept on the row (the outbound log); API responses show the first 500 characters. */
export const MAX_STORED_BODY = 200_000;

export interface SendSpec {
  tenantId: string;
  channel: Channel;
  /** Message template; null for a system email whose subject/body come from `content` (e.g. scheduled reports). */
  templateId: string | null;
  /** System email content (HTML body), used only when `templateId` is null. */
  content?: { subject: string; body: string };
  documentId: string | null;
  recipients: Resolved[];
  /** Idempotency scope, e.g. `rule:<id>:outbox:<id>`, `manual:<client key>`, `effect:<wfActionId>:<n>`. */
  keyBase: string;
  triggerRuleId?: string | null;
  attachPdfTemplateId?: string | null;
  /** QA47-BUG-006: the sender's hidden fields (manual sends), stored on the message: the attached PDF and WhatsApp
   *  variables render with them at send time. */
  hidden?: RenderHiddenFields | null;
  manual: boolean;
  createdBy: string | null;
  context: Record<string, unknown>;
  /** Edited preview (email only). */
  edit?: { subject?: string; body?: string };
  link?: string | null;
}

export interface SendJob { messageId: string; tenantId: string; attachPdfTemplateId: string | null }
export interface CreateResult { ids: string[]; enqueue: { channel: 'email' | 'whatsapp'; job: SendJob }[] }

export const idempotencyKey = (tenantId: string, keyBase: string, channel: string, address: string) =>
  sha256hex(`${tenantId}|${keyBase}|${channel}|${address.toLowerCase()}`);

/** Reason a channel cannot send for the tenant right now (feature off, no provider, WhatsApp template not allowed). */
export interface Gate { blocked: string | null; waTemplate: { id: string; name: string; language: string; header_kind: string; body: string } | null }

/**
 * Creates outbound_message rows (one per recipient, unique idempotency key → a redelivered event or a double click
 * never sends twice), applies the config gate and the monthly quota, writes in-app notifications, and hands the
 * caller the jobs to enqueue AFTER its transaction commits (nothing is sent for a rolled-back transaction).
 */
@Injectable()
export class OutboundService {
  private readonly log = new Logger('Notify');
  constructor(
    private readonly ent: EntitlementsService,
    private readonly providers: ProviderStore,
    private readonly renderer: RendererRef,
    private readonly queue: QueueService,
    private readonly docs: DocsPortRef,
  ) {}

  async gate(tx: Tx, tenantId: string, channel: Channel, template: { whatsapp_template_id: string | null }): Promise<Gate> {
    if (channel === 'inapp') return { blocked: null, waTemplate: null };
    if (!(await this.ent.hasFeature(tenantId, channel))) return { blocked: `${channel === 'email' ? 'Email' : 'WhatsApp'} is not included in your plan`, waTemplate: null };
    let waTemplate: Gate['waTemplate'] = null;
    if (channel === 'whatsapp') {
      if (template.whatsapp_template_id) {
        waTemplate = (await sql<NonNullable<Gate['waTemplate']>>`select id, name, language, header_kind, body from app.my_whatsapp_templates() where id = ${template.whatsapp_template_id}::uuid`.execute(tx)).rows[0] ?? null;
      }
      if (!waTemplate) return { blocked: 'The WhatsApp template is not approved for your company', waTemplate: null };
    }
    if (!(await this.providers.resolve(tenantId, channel))) return { blocked: `No ${channel === 'email' ? 'email' : 'WhatsApp'} provider is configured`, waTemplate };
    return { blocked: null, waTemplate };
  }

  async create(tx: Tx, spec: SendSpec): Promise<CreateResult> {
    const out: CreateResult = { ids: [], enqueue: [] };
    if (!spec.recipients.length) return out;
    let tpl: { whatsapp_template_id: string | null; whatsapp_variables: unknown } | undefined;
    if (spec.templateId) {
      tpl = await tx.selectFrom('app.message_template').select(['id', 'channel', 'version', 'whatsapp_template_id', 'is_active', 'whatsapp_variables'])
        .where('id', '=', spec.templateId).executeTakeFirst();
      if (!tpl) throw new Error(`template ${spec.templateId} not found`);
    } else if (!spec.content || spec.channel !== 'email') {
      throw new Error('a message without a template needs `content` and the email channel');
    }
    const gate = await this.gate(tx, spec.tenantId, spec.channel, tpl ?? { whatsapp_template_id: null });
    const state = await this.ent.state(spec.tenantId);
    const period = monthPeriod(state?.timezone ?? 'Asia/Kolkata');
    const quotaKey = `${spec.channel}_per_month`;
    const queue = (id: string) => {
      if (spec.channel !== 'inapp') out.enqueue.push({ channel: spec.channel, job: { messageId: id, tenantId: spec.tenantId, attachPdfTemplateId: spec.attachPdfTemplateId ?? null } });
    };

    for (const r of spec.recipients) {
      const key = idempotencyKey(spec.tenantId, spec.keyBase, spec.channel, r.address);
      const existing = await tx.selectFrom('app.outbound_message').select(['id', 'status']).where('idempotency_key', '=', key).executeTakeFirst();
      if (existing) {
        out.ids.push(existing.id);
        if (existing.status === 'queued') queue(existing.id);
        continue;
      }
      const ctx = { ...spec.context, recipient: { name: r.name ?? '' } };
      const rendered: { subject: string | null; body: string; templateVersion: number | null; whatsappVariables?: string[] } = spec.templateId
        ? await this.renderer.get().render(tx, spec.templateId, ctx)
        : { subject: spec.content!.subject, body: spec.content!.body, templateVersion: null };
      let subject = rendered.subject;
      let body = rendered.body;
      if (spec.channel === 'email' && spec.edit) {
        if (spec.edit.subject !== undefined) subject = spec.edit.subject;
        if (spec.edit.body !== undefined) body = spec.edit.body;
      }
      if (spec.channel === 'whatsapp' && gate.waTemplate && tpl) {
        const vars = formatWhatsAppVariables(rendered.whatsappVariables ?? [], (tpl.whatsapp_variables ?? []) as { index: number; expr: string }[], ctx);
        body = gate.waTemplate.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => vars[Number(n) - 1] ?? '');
        subject = null;
      }
      const ins = await tx.insertInto('app.outbound_message').values({
        tenant_id: spec.tenantId, channel: spec.channel, idempotency_key: key, trigger_rule_id: spec.triggerRuleId ?? null,
        template_id: spec.templateId, template_version: rendered.templateVersion, document_id: spec.documentId,
        recipient: r.address, recipient_name: r.name, subject: subject?.slice(0, 1000) ?? null, body_preview: body.slice(0, MAX_STORED_BODY),
        status: gate.blocked ? 'blocked_config' : spec.channel === 'inapp' ? 'sent' : 'queued', error: gate.blocked,
        manual: spec.manual, created_by: spec.createdBy, sent_at: spec.channel === 'inapp' ? new Date() : null,
        ...(spec.hidden && (spec.hidden.header.length || spec.hidden.line.length) ? { render_hidden: JSON.stringify(spec.hidden) } : {}),
      }).onConflict(oc => oc.columns(['tenant_id', 'idempotency_key']).doNothing()).returning('id').executeTakeFirst();
      if (!ins) { // concurrent duplicate: the other transaction owns it
        const dup = await tx.selectFrom('app.outbound_message').select('id').where('idempotency_key', '=', key).executeTakeFirst();
        if (dup) out.ids.push(dup.id);
        continue;
      }
      out.ids.push(ins.id);
      if (gate.blocked) continue;
      if (spec.channel === 'inapp') {
        await tx.insertInto('app.notification').values({
          user_id: r.userId!, kind: 'message', title: (subject ?? 'Notification').slice(0, 300), body: body.slice(0, 2000), link: spec.link ?? null,
          data: JSON.stringify({ messageId: ins.id, documentId: spec.documentId, templateId: spec.templateId }),
        }).execute();
        continue;
      }
      const q = await consumeQuota(tx, quotaKey, period);
      if (q.crossed) {
        await notifyQuotaCrossing(tx, quotaKey, q);
        await this.docs.get().emit(tx, 'limit.warning', { kind: 'tenant', id: null }, { limitKey: quotaKey, threshold: Number(q.crossed), limit: q.limit, used: q.used, period });
      }
      if (!q.allowed) {
        await tx.updateTable('app.outbound_message').set({ status: 'blocked_limit', error: `Plan limit of ${q.limit} ${spec.channel === 'email' ? 'emails' : 'WhatsApp messages'} per month reached` })
          .where('id', '=', ins.id).execute();
        continue;
      }
      queue(ins.id);
    }
    return out;
  }

  /** Enqueue after commit. jobId `msg:<id>` de-duplicates a job still waiting/active/kept. */
  async enqueue(items: CreateResult['enqueue']): Promise<void> {
    for (const it of items) {
      await this.queue.enqueue(SEND_QUEUE[it.channel], 'send', it.job, { ...SEND_JOB_OPTS, jobId: `msg:${it.job.messageId}` });
    }
  }

  /** Re-queues a message (retry endpoint, sweeper): drops a finished job with the same id first. */
  async requeue(channel: 'email' | 'whatsapp', job: SendJob, opts: { replaceFinished?: boolean } = {}): Promise<void> {
    const q = this.queue.queue(SEND_QUEUE[channel]);
    const prev = await q.getJob(`msg:${job.messageId}`);
    if (prev) {
      const state = await prev.getState();
      if (!opts.replaceFinished || (state !== 'failed' && state !== 'completed')) return;
      const keep = (prev.data as Partial<SendJob>)?.attachPdfTemplateId ?? null;
      await prev.remove();
      job = { ...job, attachPdfTemplateId: job.attachPdfTemplateId ?? keep };
    }
    await this.queue.enqueue(SEND_QUEUE[channel], 'send', job, { ...SEND_JOB_OPTS, jobId: `msg:${job.messageId}` });
  }
}
