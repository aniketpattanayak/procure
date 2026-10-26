import { Injectable } from '@nestjs/common';
import { compile } from '@procure/formula';
import { ErrorCode, TriggerRuleInput, TriggerRuleRow } from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';
import { DefinitionsService } from '../workflow';
import { CURRENT_STAGE } from './recipients';
import { normaliseAddress } from './util/address';

/** Events whose payload names a stage (`stageKey`), so `stage_actors: _current` can resolve. */
const STAGE_EVENTS = new Set(['workflow.stage_entered', 'workflow.decided', 'workflow.forwarded', 'workflow.sla_reminder', 'workflow.sla_escalated']);

type Input = z.infer<typeof TriggerRuleInput>;
export interface EventInfo { type: string; label: string; docScoped: boolean }

/** DomainEventType (Phase 3) + Phase 4 procurement events. Workflow `emit` events are added from published workflows. */
export const BUILTIN_EVENTS: EventInfo[] = [
  { type: 'document.created', label: 'Document created', docScoped: true },
  { type: 'document.submitted', label: 'Document submitted', docScoped: true },
  { type: 'document.updated', label: 'Document edited', docScoped: true },
  { type: 'document.cancelled', label: 'Document cancelled', docScoped: true },
  { type: 'document.closed', label: 'Document closed', docScoped: true },
  { type: 'document.status_changed', label: 'Document status changed', docScoped: true },
  { type: 'workflow.stage_entered', label: 'Approval stage entered', docScoped: true },
  { type: 'workflow.decided', label: 'Approval decision taken', docScoped: true },
  { type: 'workflow.completed', label: 'Approval workflow completed', docScoped: true },
  { type: 'workflow.sent_back', label: 'Sent back', docScoped: true },
  { type: 'workflow.forwarded', label: 'Forwarded', docScoped: true },
  { type: 'workflow.sla_reminder', label: 'Approval reminder (SLA)', docScoped: true },
  { type: 'workflow.sla_escalated', label: 'Approval escalated (SLA)', docScoped: true },
  { type: 'comment.created', label: 'Comment added', docScoped: true },
  { type: 'comment.mentioned', label: 'Someone was @mentioned', docScoped: true },
  { type: 'limit.warning', label: 'Plan limit warning', docScoped: false },
  { type: 'indent.quote_logged', label: 'Vendor quote logged', docScoped: true },
  { type: 'selection.submitted', label: 'Vendor selection submitted', docScoped: true },
  { type: 'po.created_from_lines', label: 'Purchase order created', docScoped: true },
  { type: 'po.amended', label: 'Purchase order amended', docScoped: true },
  { type: 'po.followup_logged', label: 'Purchase order follow-up logged', docScoped: true },
];
/** Events used internally by this module (never offered for rules or webhooks). */
export const INTERNAL_EVENT_PREFIX = 'notify.';

/**
 * Extra names a rule condition may use besides the header fields (a header field with the same key wins):
 * `doc_status` = the document's status key when the event is processed, `status_to` = the new status of a
 * `document.status_changed` event (null for other events). "PO approved" = status_changed with status_to = 'approved'.
 */
export const CONDITION_PSEUDO_FIELDS = { doc_status: 'text', status_to: 'text' } as const;

const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const TEMPLATE_CHANNEL: Record<Input['channel'], string> = { email: 'email', whatsapp: 'whatsapp', inapp: 'inapp' };

interface RuleDb {
  id: string; name: string; event_type: string; doc_type_key: string | null; condition: string | null; channel: Input['channel']; template_id: string;
  recipients: unknown; attach_pdf_template_id: string | null; mode: 'auto' | 'manual'; is_active: boolean; version: number;
}
export const RULE_COLS = ['id', 'name', 'event_type', 'doc_type_key', 'condition', 'channel', 'template_id', 'recipients', 'attach_pdf_template_id', 'mode', 'is_active', 'version'] as const;

export function toRuleRow(r: RuleDb): TriggerRuleRow {
  return {
    id: r.id, name: r.name, eventType: r.event_type, docTypeKey: r.doc_type_key, ...(r.condition ? { condition: r.condition } : {}), channel: r.channel,
    templateId: r.template_id, recipients: (r.recipients ?? []) as TriggerRuleRow['recipients'], ...(r.attach_pdf_template_id ? { attachPdfTemplateId: r.attach_pdf_template_id } : {}),
    mode: r.mode, isActive: r.is_active, version: r.version,
  };
}

class Issues {
  readonly list: { path: string; message: string }[] = [];
  add(path: string, message: string) { this.list.push({ path, message }); }
  throwIfAny() {
    if (this.list.length) throw new AppError(400, ErrorCode.VALIDATION, this.list[0]!.message, undefined, this.list);
  }
}

/** Trigger rule CRUD + validation (contract "Notify endpoints": channel in plan, WhatsApp template allowed, …). */
@Injectable()
export class RulesService {
  constructor(private readonly ent: EntitlementsService, private readonly audit: AuditService, private readonly defs: DefinitionsService) {}

  async events(tx: Tx): Promise<EventInfo[]> {
    const emits = await sql<{ event: string }>`
      select distinct e.value->>'event' as event
        from app.workflow_def d join app.workflow_version v on v.id = d.current_version_id,
             lateral jsonb_path_query(v.definition, 'strict $.**') as e(value)
       where jsonb_typeof(e.value) = 'object' and e.value->>'effect' = 'emit'`.execute(tx);
    const known = new Set(BUILTIN_EVENTS.map(e => e.type));
    const custom = emits.rows.map(r => r.event).filter((e): e is string => !!e && !known.has(e) && !e.startsWith(INTERNAL_EVENT_PREFIX)).sort()
      .map(type => ({ type, label: `Workflow event: ${type}`, docScoped: true }));
    return [...BUILTIN_EVENTS, ...custom];
  }

  async list(tx: Tx, q: { docTypeKey?: string; eventType?: string } = {}): Promise<TriggerRuleRow[]> {
    let qb = tx.selectFrom('app.trigger_rule').select([...RULE_COLS]);
    if (q.docTypeKey) qb = qb.where('doc_type_key', '=', q.docTypeKey);
    if (q.eventType) qb = qb.where('event_type', '=', q.eventType);
    return (await qb.orderBy('name').orderBy('id').execute()).map(r => toRuleRow(r as RuleDb));
  }

  async get(tx: Tx, id: string): Promise<TriggerRuleRow> {
    const r = await tx.selectFrom('app.trigger_rule').select([...RULE_COLS]).where('id', '=', id).executeTakeFirst();
    if (!r) throw AppError.notFound('Rule');
    return toRuleRow(r as RuleDb);
  }

  async validate(tx: Tx, tenantId: string, i: Input): Promise<void> {
    const issues = new Issues();
    if (!EVENT_NAME.test(i.eventType) || i.eventType.startsWith(INTERNAL_EVENT_PREFIX)) issues.add('eventType', 'Choose an event from the list.');
    if (i.channel !== 'inapp' && !(await this.ent.hasFeature(tenantId, i.channel))) {
      issues.add('channel', `${i.channel === 'email' ? 'Email' : 'WhatsApp'} is not included in your plan.`);
    }
    // document type
    const dt = i.docTypeKey ? await tx.selectFrom('app.doc_type').select(['id', 'key', 'name', 'header_form_id', 'line_form_id']).where('key', '=', i.docTypeKey).executeTakeFirst() : null;
    if (i.docTypeKey && !dt) issues.add('docTypeKey', `Document type "${i.docTypeKey}" does not exist.`);
    // template
    const tpl = await tx.selectFrom('app.message_template').select(['id', 'channel', 'doc_type_key', 'whatsapp_template_id', 'is_active']).where('id', '=', i.templateId).executeTakeFirst();
    if (!tpl || !tpl.is_active) issues.add('templateId', 'This template does not exist or is inactive.');
    else {
      if (tpl.channel !== TEMPLATE_CHANNEL[i.channel]) issues.add('templateId', `Choose a ${i.channel === 'inapp' ? 'in-app' : i.channel} template.`);
      if (tpl.doc_type_key && tpl.doc_type_key !== i.docTypeKey) issues.add('templateId', `This template is for "${tpl.doc_type_key}" documents.`);
      if (i.channel === 'whatsapp') {
        const ok = tpl.whatsapp_template_id
          ? (await sql<{ id: string }>`select id from app.my_whatsapp_templates() where id = ${tpl.whatsapp_template_id}::uuid`.execute(tx)).rows.length > 0
          : false;
        if (!ok) issues.add('templateId', 'The WhatsApp template behind this template is not approved for your company.');
      }
    }
    if (i.attachPdfTemplateId) {
      if (i.channel === 'inapp') issues.add('attachPdfTemplateId', 'In-app messages cannot carry attachments.');
      if (!i.docTypeKey) issues.add('attachPdfTemplateId', 'Attachments need a document type.');
      const pdf = await tx.selectFrom('app.message_template').select(['channel', 'doc_type_key', 'is_active']).where('id', '=', i.attachPdfTemplateId).executeTakeFirst();
      if (!pdf || !pdf.is_active || pdf.channel !== 'pdf') issues.add('attachPdfTemplateId', 'Choose an active PDF template.');
      else if (pdf.doc_type_key && pdf.doc_type_key !== i.docTypeKey) issues.add('attachPdfTemplateId', `This PDF template is for "${pdf.doc_type_key}" documents.`);
    }
    // recipients
    const ctx = dt ? await this.defs.validationContext(tx, tenantId, dt) : null;
    const headerKeys = new Set(ctx ? Object.keys(ctx.scope.fields) : []);
    const stages = dt ? await this.stageKeys(tx, dt.id) : new Set<string>();
    const roleIds = i.recipients.flatMap(r => (r.type === 'role' ? [r.roleId] : []));
    const userIds = i.recipients.flatMap(r => (r.type === 'users' ? r.userIds : []));
    const roles = roleIds.length ? new Set((await tx.selectFrom('app.role').select('id').where('id', 'in', roleIds).where('is_deleted', '=', false).execute()).map(r => r.id)) : new Set<string>();
    const users = userIds.length ? new Set((await tx.selectFrom('app.tenant_user').select('id').where('id', 'in', userIds).where('is_active', '=', true).where('is_deleted', '=', false).execute()).map(r => r.id)) : new Set<string>();
    i.recipients.forEach((r, k) => {
      const p = `recipients.${k}`;
      const needsDoc = r.type === 'party' || r.type === 'submitter' || r.type === 'field';
      if (needsDoc && !i.docTypeKey) { issues.add(p, 'This recipient needs a document type.'); return; }
      if (i.channel === 'inapp' && (r.type === 'party' || r.type === 'fixed')) { issues.add(p, 'In-app messages can only go to users.'); return; }
      switch (r.type) {
        case 'role': if (!roles.has(r.roleId)) issues.add(`${p}.roleId`, 'This role does not exist.'); break;
        case 'users': r.userIds.forEach((u, j) => { if (!users.has(u)) issues.add(`${p}.userIds.${j}`, 'This user does not exist or is inactive.'); }); break;
        case 'stage_actors':
          if (r.stage === CURRENT_STAGE) {
            if (!STAGE_EVENTS.has(i.eventType)) issues.add(`${p}.stage`, '"Current stage" only works with approval stage events.');
          } else if (!dt) issues.add(p, 'This recipient needs a document type.');
          else if (!stages.has(r.stage)) issues.add(`${p}.stage`, `Stage "${r.stage}" is not in the published workflow of ${dt.name}.`);
          break;
        case 'field': if (dt && !headerKeys.has(r.field)) issues.add(`${p}.field`, `"${r.field}" is not a header field of ${dt.name}.`); break;
        case 'fixed': {
          if (i.channel === 'inapp') break;
          const n = normaliseAddress(i.channel, r.address);
          if (!n.valid) issues.add(`${p}.address`, n.reason ?? 'Invalid address');
          break;
        }
        default: break;
      }
    });
    // condition
    if (i.condition && i.condition.trim()) {
      if (!ctx) issues.add('condition', 'A condition needs a document type.');
      else {
        const scope = { ...ctx.scope, fields: { ...CONDITION_PSEUDO_FIELDS, ...ctx.scope.fields } };
        const c = compile(i.condition, scope, 'boolean');
        if (!c.ok) issues.add('condition', c.errors[0]?.message ?? 'The condition is not valid.');
        else if (c.resultType !== 'boolean' && c.resultType !== 'any') issues.add('condition', 'The condition must be true or false (for example total_amount > 100000).');
      }
    }
    issues.throwIfAny();
  }

  /** Stage keys of the current published workflow of a doc type. */
  private async stageKeys(tx: Tx, docTypeId: string): Promise<Set<string>> {
    const r = await sql<{ key: string }>`
      select s.value->>'key' as key from app.workflow_def d join app.workflow_version v on v.id = d.current_version_id,
             lateral jsonb_array_elements(coalesce(v.definition->'stages', '[]'::jsonb)) s(value)
       where d.doc_type_id = ${docTypeId}`.execute(tx);
    return new Set(r.rows.map(x => x.key));
  }

  async create(tx: Tx, tenantId: string, userId: string | null, i: Input): Promise<TriggerRuleRow> {
    await this.validate(tx, tenantId, i);
    const r = await tx.insertInto('app.trigger_rule').values({
      tenant_id: tenantId, name: i.name, event_type: i.eventType, doc_type_key: i.docTypeKey, condition: i.condition?.trim() || null, channel: i.channel,
      template_id: i.templateId, recipients: JSON.stringify(i.recipients), attach_pdf_template_id: i.attachPdfTemplateId ?? null, mode: i.mode, is_active: i.isActive, created_by: userId,
    }).returning([...RULE_COLS]).executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'create', entity: 'trigger_rule', entityId: r.id, actorId: userId, after: { name: i.name, eventType: i.eventType, channel: i.channel, mode: i.mode } });
    return toRuleRow(r as RuleDb);
  }

  async update(tx: Tx, tenantId: string, userId: string | null, id: string, i: Input & { version: number }): Promise<TriggerRuleRow> {
    const cur = await tx.selectFrom('app.trigger_rule').select([...RULE_COLS]).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw AppError.notFound('Rule');
    if (cur.version !== i.version) throw AppError.versionConflict();
    await this.validate(tx, tenantId, i);
    const r = await tx.updateTable('app.trigger_rule').set({
      name: i.name, event_type: i.eventType, doc_type_key: i.docTypeKey, condition: i.condition?.trim() || null, channel: i.channel, template_id: i.templateId,
      recipients: JSON.stringify(i.recipients), attach_pdf_template_id: i.attachPdfTemplateId ?? null, mode: i.mode, is_active: i.isActive, version: cur.version + 1,
    }).where('id', '=', id).returning([...RULE_COLS]).executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'update', entity: 'trigger_rule', entityId: id, actorId: userId, before: toRuleRow(cur as RuleDb), after: toRuleRow(r as RuleDb) });
    return toRuleRow(r as RuleDb);
  }

  /** Deletes; a rule that already sent messages is deactivated instead (the message log keeps its reference). */
  async remove(tx: Tx, userId: string | null, id: string): Promise<void> {
    const cur = await tx.selectFrom('app.trigger_rule').select(['id', 'name']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!cur) throw AppError.notFound('Rule');
    const used = await tx.selectFrom('app.outbound_message').select('id').where('trigger_rule_id', '=', id).limit(1).executeTakeFirst();
    if (used) await tx.updateTable('app.trigger_rule').set(eb => ({ is_active: false, version: eb('version', '+', 1) })).where('id', '=', id).execute();
    else await tx.deleteFrom('app.trigger_rule').where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: used ? 'deactivate' : 'delete', entity: 'trigger_rule', entityId: id, actorId: userId, before: { name: cur.name } });
  }
}
