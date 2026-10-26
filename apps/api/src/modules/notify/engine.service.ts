import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { evaluate } from '@procure/formula';
import type { Effect } from '@procure/schema';
import { DbService, Tx } from '../../core/db.service';
import { EFFECT_REGISTRY, EffectContext, EffectRegistry, DocumentSnapshot } from '../../core/ports';
import { QueueService } from '../../core/queue.service';
import { EVENTS_NOTIFY_QUEUE } from '../documents';
import { tenantToday } from '../forms';
import { DocsPortRef } from '../workflow';
import { CreateResult, OutboundService } from './outbound.service';
import { NotifyPlatformReader } from './platform/usage.reader';
import { Channel, Recipient, RecipientResolver } from './recipients';
import { RendererRef } from './renderer';
import { INTERNAL_EVENT_PREFIX } from './rules.service';
import { WebhooksService } from './webhooks.service';

export interface EventJob {
  outboxId: string;
  tenantId: string;
  type: string;
  aggregate: { kind: string; id: string | null };
  payload: Record<string, unknown>;
  at: string;
}

/** Outbox event written by the send_email / send_whatsapp workflow effects (processed after the action commits). */
export const EFFECT_EVENT = `${INTERNAL_EVENT_PREFIX}effect_send`;
export const MAINT_QUEUE = 'notify-maint';

interface RuleRow {
  id: string; name: string; event_type: string; doc_type_key: string | null; condition: string | null; channel: Channel; template_id: string;
  recipients: unknown; attach_pdf_template_id: string | null;
}

/**
 * Trigger engine (ADR-0014): consumer of `events-notify` (fan-out copy of the outbox events). For each active auto
 * rule matching the event (and doc type, and condition) it resolves recipients, renders and creates one
 * idempotent outbound message per recipient; then fans the event out to outgoing webhooks. Every step is idempotent,
 * so a redelivered event (same outbox id) sends nothing twice.
 */
@Injectable()
export class TriggerEngine implements OnModuleInit {
  private readonly log = new Logger('Notify');
  constructor(
    private readonly db: DbService,
    private readonly queue: QueueService,
    private readonly docs: DocsPortRef,
    private readonly recipients: RecipientResolver,
    private readonly renderer: RendererRef,
    private readonly outbound: OutboundService,
    private readonly webhooks: WebhooksService,
    private readonly reader: NotifyPlatformReader,
    @Inject(EFFECT_REGISTRY) private readonly effects: EffectRegistry,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor(EVENTS_NOTIFY_QUEUE, job => this.handle(job.data as EventJob), 4);
    this.queue.registerProcessor(MAINT_QUEUE, async job => (job.name === 'notify-sweep' ? this.sweep() : undefined), 1);
    this.queue.registerRepeat(MAINT_QUEUE, 'notify-sweep', { every: 60_000 });
    this.effects.register('send_email', (e, c) => this.effectRequested('email', e, c), { requiresFeature: 'email' });
    this.effects.register('send_whatsapp', (e, c) => this.effectRequested('whatsapp', e, c), { requiresFeature: 'whatsapp' });
  }

  /** Processes one event: trigger rules (or a requested effect send), then outgoing webhooks. */
  async handle(evt: EventJob): Promise<{ messages: number; webhooks: number }> {
    if (evt.type === EFFECT_EVENT) return { messages: await this.effectSend(evt), webhooks: 0 };
    if (evt.type.startsWith(INTERNAL_EVENT_PREFIX)) return { messages: 0, webhooks: 0 };
    const rules = await this.db.tenantTx(evt.tenantId, tx => tx.selectFrom('app.trigger_rule')
      .select(['id', 'name', 'event_type', 'doc_type_key', 'condition', 'channel', 'template_id', 'recipients', 'attach_pdf_template_id'])
      .where('event_type', '=', evt.type).where('is_active', '=', true).where('mode', '=', 'auto').orderBy('id').execute()) as RuleRow[];
    let messages = 0;
    for (const rule of rules) messages += await this.runRule(evt, rule);
    const webhooks = await this.webhooks.fanout(evt);
    return { messages, webhooks };
  }

  private documentIdOf(evt: EventJob): string | null {
    const p = evt.payload?.documentId;
    if (typeof p === 'string') return p;
    return evt.aggregate?.kind === 'document' ? evt.aggregate.id : null;
  }

  /** Runs one rule for one event in its own transaction; returns the number of message rows touched. */
  async runRule(evt: EventJob, rule: RuleRow): Promise<number> {
    const docId = this.documentIdOf(evt);
    const res = await this.db.tenantTx(evt.tenantId, async tx => {
      const snap = docId ? await this.snapshot(tx, docId) : null;
      if (rule.doc_type_key && snap?.docTypeKey !== rule.doc_type_key) return null;
      if (rule.condition && rule.condition.trim()) {
        if (!snap) return null;
        const ok = await this.conditionHolds(tx, rule, snap, evt);
        if (!ok) return null;
      }
      const stage = typeof evt.payload?.stageKey === 'string' ? evt.payload.stageKey : null;
      const { to, skipped } = await this.recipients.resolve(tx, evt.tenantId, rule.channel, (rule.recipients ?? []) as Recipient[], snap, stage);
      if (skipped.length) this.log.debug(`rule ${rule.id}: skipped ${skipped.map(s => `${s.source}(${s.reason})`).join(', ')}`);
      if (!to.length) return null;
      const context = await this.context(tx, evt, snap);
      return this.outbound.create(tx, {
        tenantId: evt.tenantId, channel: rule.channel, templateId: rule.template_id, documentId: snap?.id ?? null, recipients: to,
        keyBase: `rule:${rule.id}:outbox:${evt.outboxId}`, triggerRuleId: rule.id, attachPdfTemplateId: rule.attach_pdf_template_id,
        manual: false, createdBy: null, context, link: snap ? `/docs/${snap.docTypeKey}/${snap.id}` : null,
      });
    });
    if (!res) return 0;
    await this.outbound.enqueue(res.enqueue);
    return res.ids.length;
  }

  private async snapshot(tx: Tx, id: string): Promise<DocumentSnapshot | null> {
    try {
      return await this.docs.get().snapshot(tx, id, { lock: false });
    } catch {
      return null; // deleted draft or not a document
    }
  }

  /** Formula condition over header values + `lines`; an error skips the rule (logged), never sends. */
  private async conditionHolds(tx: Tx, rule: RuleRow, snap: DocumentSnapshot, evt: EventJob): Promise<boolean> {
    const lines = snap.lines.filter(l => !l.isCancelled).map(l => ({ qty: l.qty, ...l.values }));
    const statusTo = evt.type === 'document.status_changed' && typeof evt.payload?.to === 'string' ? evt.payload.to : null;
    const values = { doc_status: snap.statusKey, status_to: statusTo, ...snap.values, lines };
    const r = evaluate(rule.condition!, { values, lookups: snap.lookups ?? {}, today: await tenantToday(tx) });
    if (r.error) {
      this.log.warn(`rule "${rule.name}" (${rule.id}) skipped: condition error: ${r.error.message}`);
      return false;
    }
    return r.value === true;
  }

  private async context(tx: Tx, evt: EventJob, snap: DocumentSnapshot | null): Promise<Record<string, unknown>> {
    const base = snap ? await this.renderer.get().documentContext(tx, snap.id) : {};
    const actorId = [evt.payload?.actorId, evt.payload?.by].find((v): v is string => typeof v === 'string');
    const actor = actorId ? await tx.selectFrom('app.tenant_user').select('name').where('id', '=', actorId).executeTakeFirst() : null;
    const comment = [evt.payload?.comment, evt.payload?.reason].find((v): v is string => typeof v === 'string') ?? null;
    return { ...base, event: { type: evt.type, at: evt.at, actor: { name: actor?.name ?? '' }, comment, stageKey: evt.payload?.stageKey ?? null } };
  }

  // ------------------------------------------------------------------ workflow effects send_email / send_whatsapp
  /** Runs inside the workflow action's transaction: only writes an outbox event (sent after commit). */
  private async effectRequested(channel: 'email' | 'whatsapp', e: Effect, c: EffectContext): Promise<void> {
    const template = (e as { template?: string }).template;
    await this.docs.get().emit(c.tx, EFFECT_EVENT, { kind: 'document', id: c.documentId }, {
      documentId: c.documentId, channel, template, wfActionId: c.wfActionId, stageKey: c.stageKey, actorId: c.actorId,
    });
  }

  /** Effect send: template by key (doc-type specific first), recipients party + submitter, default PDF attached. */
  private async effectSend(evt: EventJob): Promise<number> {
    const p = evt.payload as { documentId?: string; channel?: 'email' | 'whatsapp'; template?: string; wfActionId?: string | null };
    if (!p.documentId || !p.channel || !p.template) return 0;
    const res = await this.db.tenantTx(evt.tenantId, async (tx): Promise<CreateResult | null> => {
      const snap = await this.snapshot(tx, p.documentId!);
      if (!snap) return null;
      const tpl = await tx.selectFrom('app.message_template').select(['id', 'doc_type_key']).where('key', '=', p.template!).where('channel', '=', p.channel!)
        .where('is_active', '=', true).where(eb => eb.or([eb('doc_type_key', '=', snap.docTypeKey), eb('doc_type_key', 'is', null)]))
        .orderBy(eb => eb.case().when('doc_type_key', 'is', null).then(1).else(0).end()).executeTakeFirst();
      if (!tpl) {
        this.log.warn(`effect send_${p.channel}: template "${p.template}" not found for ${snap.docTypeKey}`);
        return null;
      }
      const pdf = await tx.selectFrom('app.message_template').select('id').where('channel', '=', 'pdf').where('doc_type_key', '=', snap.docTypeKey)
        .where('is_default', '=', true).where('is_active', '=', true).executeTakeFirst();
      const { to } = await this.recipients.resolve(tx, evt.tenantId, p.channel!, [{ type: 'party' }, { type: 'submitter' }], snap);
      if (!to.length) return null;
      return this.outbound.create(tx, {
        tenantId: evt.tenantId, channel: p.channel!, templateId: tpl.id, documentId: snap.id, recipients: to,
        keyBase: `effect:${p.wfActionId ?? `outbox:${evt.outboxId}`}:${p.channel}:${p.template}`, attachPdfTemplateId: pdf?.id ?? null,
        manual: false, createdBy: null, context: await this.context(tx, evt, snap), link: `/docs/${snap.docTypeKey}/${snap.id}`,
      });
    });
    if (!res) return 0;
    await this.outbound.enqueue(res.enqueue);
    return res.ids.length;
  }

  // ------------------------------------------------------------------ sweeper
  /** Re-enqueues messages / webhook deliveries left without a job (crash between commit and enqueue). */
  async sweep(): Promise<{ messages: number; deliveries: number }> {
    const msgs = await this.reader.staleQueued();
    for (const m of msgs) await this.outbound.requeue(m.channel as 'email' | 'whatsapp', { messageId: m.id, tenantId: m.tenant_id, attachPdfTemplateId: null });
    const dels = await this.reader.stalePending();
    for (const d of dels) await this.webhooks.schedule(d.tenant_id, d.id, d.attempts, 0);
    return { messages: msgs.length, deliveries: dels.length };
  }
}
