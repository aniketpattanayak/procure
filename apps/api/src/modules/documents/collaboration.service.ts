import { Injectable } from '@nestjs/common';
import { AttachmentInput, AttachmentRow, CommentInput, CommentRow, ErrorCode, TimelineEntry } from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { FilesService } from '../files';
import { parseMentions, plainExcerpt } from './mentions';
import { fromUnits, toUnits } from './qty';
import { humanize, statusLabel } from './status';
import { DocumentsService } from './documents.service';
import { DOCUMENT_ENTITY, docAction, DocActor, DocTypeRow, need } from './types';

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FANOUT = 200;
const ATTACH_KIND = 'document_attachment';
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);

interface CommentDb { id: string; parent_id: string | null; body: string; mentions: string[]; created_at: Date; created_by: string; edited_at: Date | null; is_deleted: boolean }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const MESSAGE_STATE: Record<string, string> = {
  queued: 'queued', sending: 'sending', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed',
  blocked_limit: 'blocked: plan limit', blocked_config: 'blocked: not configured', cancelled: 'cancelled',
};

/** Comments with @mentions, attachments and the merged document timeline (contract "Documents" collaboration rows). */
@Injectable()
export class CollaborationService {
  constructor(private readonly docs: DocumentsService, private readonly files: FilesService, private readonly audit: AuditService) {}

  private async target(tx: Tx, actor: DocActor, typeKey: string, id: string) {
    const type = await this.docs.typeFor(tx, actor, typeKey);
    const doc = await this.docs.access(tx, actor, type, id);
    return { type, doc };
  }

  private async names(tx: Tx, tenantId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map();
    const rows = await tx.selectFrom('app.tenant_user').select(['id', 'name']).where('tenant_id', '=', tenantId).where('id', 'in', uniq).execute();
    return new Map(rows.map(r => [r.id, r.name]));
  }

  // ------------------------------------------------------------------ comments
  private toComment(c: CommentDb, names: Map<string, string>, actor: DocActor): CommentRow {
    return {
      id: c.id, parentId: c.parent_id, body: c.is_deleted ? '' : c.body,
      mentions: c.is_deleted ? [] : c.mentions.map(id => ({ id, name: names.get(id) ?? '' })),
      createdBy: { id: c.created_by, name: names.get(c.created_by) ?? '' }, createdAt: new Date(c.created_at).toISOString(),
      editedAt: c.edited_at ? new Date(c.edited_at).toISOString() : null,
      canEdit: !c.is_deleted && c.created_by === actor.userId && Date.now() - new Date(c.created_at).getTime() < EDIT_WINDOW_MS,
    };
  }

  async listComments(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<CommentRow[]> {
    await this.target(tx, actor, typeKey, id);
    const rows = (await tx.selectFrom('app.comment').select(['id', 'parent_id', 'body', 'mentions', 'created_at', 'created_by', 'edited_at', 'is_deleted'])
      .where('tenant_id', '=', actor.tenantId).where('entity_kind', '=', DOCUMENT_ENTITY).where('entity_id', '=', id).orderBy('created_at').orderBy('id').execute()) as CommentDb[];
    const names = await this.names(tx, actor.tenantId, rows.flatMap(r => [r.created_by, ...r.mentions]));
    return rows.map(r => this.toComment(r, names, actor));
  }

  /** Mentioned ids must be active, non-deleted users of this tenant. */
  private async checkMentions(tx: Tx, tenantId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', tenantId).where('id', 'in', ids)
      .where('is_active', '=', true).where('is_deleted', '=', false).execute();
    const ok = new Set(rows.map(r => r.id));
    const badIds = ids.filter(i => !ok.has(i));
    if (badIds.length) throw bad('body', 'Some mentioned people are not active users of your company.');
  }

  private async notifyMentions(tx: Tx, actor: DocActor, type: DocTypeRow, doc: { id: string; number: string | null }, commentId: string, body: string, userIds: string[]) {
    const to = userIds.filter(u => u !== actor.userId).slice(0, MAX_FANOUT);
    if (!to.length) return;
    const author = actor.userId ? (await this.names(tx, actor.tenantId, [actor.userId])).get(actor.userId) ?? 'Someone' : 'Someone';
    const what = doc.number ? `${type.name} ${doc.number}` : `a draft ${type.name.toLowerCase()}`;
    await tx.insertInto('app.notification').values(to.map(u => ({
      user_id: u, kind: 'mention', title: `${author} mentioned you on ${what}`, body: plainExcerpt(body), link: `/docs/${type.key}/${doc.id}`,
      data: JSON.stringify({ documentId: doc.id, docTypeKey: type.key, commentId }),
    }))).execute();
    await this.docs.store.emit(tx, 'comment.mentioned', { kind: DOCUMENT_ENTITY, id: doc.id }, { documentId: doc.id, docTypeKey: type.key, commentId, userIds: to, by: actor.userId });
  }

  async addComment(tx: Tx, actor: DocActor, typeKey: string, id: string, input: z.infer<typeof CommentInput>): Promise<CommentRow> {
    const { type, doc } = await this.target(tx, actor, typeKey, id);
    need(actor, docAction(typeKey, 'comment'));
    if (!actor.userId) throw AppError.forbidden();
    if (input.parentId) {
      const p = await tx.selectFrom('app.comment').select('id').where('tenant_id', '=', actor.tenantId).where('id', '=', input.parentId)
        .where('entity_kind', '=', DOCUMENT_ENTITY).where('entity_id', '=', id).executeTakeFirst();
      if (!p) throw bad('parentId', 'The comment you are replying to does not exist.');
    }
    const mentions = parseMentions(input.body);
    await this.checkMentions(tx, actor.tenantId, mentions);
    const row = (await tx.insertInto('app.comment').values({
      entity_kind: DOCUMENT_ENTITY, entity_id: id, parent_id: input.parentId ?? null, body: input.body, mentions, created_by: actor.userId,
    }).returning(['id', 'parent_id', 'body', 'mentions', 'created_at', 'created_by', 'edited_at', 'is_deleted']).executeTakeFirstOrThrow()) as CommentDb;
    await this.audit.tenant(tx, { action: 'create', entity: 'comment', entityId: row.id, actorId: actor.userId, after: { documentId: id, mentions } });
    await this.docs.store.emit(tx, 'comment.created', { kind: DOCUMENT_ENTITY, id }, { documentId: id, docTypeKey: type.key, commentId: row.id, by: actor.userId });
    await this.notifyMentions(tx, actor, type, doc, row.id, input.body, mentions);
    return this.toComment(row, await this.names(tx, actor.tenantId, [row.created_by, ...mentions]), actor);
  }

  private async ownComment(tx: Tx, actor: DocActor, docId: string, commentId: string, lock = true): Promise<CommentDb> {
    let q = tx.selectFrom('app.comment').select(['id', 'parent_id', 'body', 'mentions', 'created_at', 'created_by', 'edited_at', 'is_deleted'])
      .where('tenant_id', '=', actor.tenantId).where('id', '=', commentId).where('entity_kind', '=', DOCUMENT_ENTITY).where('entity_id', '=', docId);
    if (lock) q = q.forUpdate();
    const c = (await q.executeTakeFirst()) as CommentDb | undefined;
    if (!c || c.is_deleted) throw AppError.notFound('Comment');
    if (c.created_by !== actor.userId) throw AppError.forbidden('Only the author can change this comment.');
    return c;
  }

  async editComment(tx: Tx, actor: DocActor, typeKey: string, id: string, commentId: string, input: z.infer<typeof CommentInput>): Promise<CommentRow> {
    const { type, doc } = await this.target(tx, actor, typeKey, id);
    const c = await this.ownComment(tx, actor, id, commentId);
    if (Date.now() - new Date(c.created_at).getTime() >= EDIT_WINDOW_MS) throw AppError.conflict('Comments can be edited for 15 minutes after posting.');
    const mentions = parseMentions(input.body);
    await this.checkMentions(tx, actor.tenantId, mentions);
    const row = (await tx.updateTable('app.comment').set({ body: input.body, mentions, edited_at: new Date() }).where('tenant_id', '=', actor.tenantId).where('id', '=', commentId)
      .returning(['id', 'parent_id', 'body', 'mentions', 'created_at', 'created_by', 'edited_at', 'is_deleted']).executeTakeFirstOrThrow()) as CommentDb;
    await this.audit.tenant(tx, { action: 'update', entity: 'comment', entityId: commentId, actorId: actor.userId, before: { body: c.body }, after: { body: input.body, mentions } });
    const added = mentions.filter(m => !c.mentions.includes(m));
    await this.notifyMentions(tx, actor, type, doc, commentId, input.body, added);
    return this.toComment(row, await this.names(tx, actor.tenantId, [row.created_by, ...mentions]), actor);
  }

  async deleteComment(tx: Tx, actor: DocActor, typeKey: string, id: string, commentId: string): Promise<void> {
    await this.target(tx, actor, typeKey, id);
    const c = await this.ownComment(tx, actor, id, commentId);
    await tx.updateTable('app.comment').set({ is_deleted: true }).where('tenant_id', '=', actor.tenantId).where('id', '=', commentId).execute();
    await this.audit.tenant(tx, { action: 'delete', entity: 'comment', entityId: commentId, actorId: actor.userId, before: { body: c.body } });
  }

  // ------------------------------------------------------------------ attachments
  async listAttachments(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<AttachmentRow[]> {
    await this.target(tx, actor, typeKey, id);
    const rows = await tx.selectFrom('app.attachment').select(['id', 'file_id', 'note', 'created_by', 'created_at'])
      .where('tenant_id', '=', actor.tenantId).where('entity_kind', '=', DOCUMENT_ENTITY).where('entity_id', '=', id).where('is_deleted', '=', false)
      .orderBy('created_at').orderBy('id').execute();
    return this.toAttachments(tx, actor, rows);
  }

  private async toAttachments(tx: Tx, actor: DocActor, rows: { id: string; file_id: string; note: string | null; created_by: string; created_at: Date }[]): Promise<AttachmentRow[]> {
    const meta = await this.files.metaMap(tx, actor.tenantId, rows.map(r => r.file_id));
    const names = await this.names(tx, actor.tenantId, rows.map(r => r.created_by));
    return rows.map(r => {
      const m = meta.get(r.file_id);
      return {
        id: r.id, note: r.note, createdBy: { id: r.created_by, name: names.get(r.created_by) ?? '' }, createdAt: new Date(r.created_at).toISOString(),
        file: { id: r.file_id, filename: m?.filename ?? '', mime: m?.mime ?? '', sizeBytes: m?.sizeBytes ?? 0, url: m?.url ?? null, thumbUrl: m?.thumbUrl ?? null },
      };
    });
  }

  async addAttachment(tx: Tx, actor: DocActor, typeKey: string, id: string, input: z.infer<typeof AttachmentInput>): Promise<AttachmentRow> {
    const { type } = await this.target(tx, actor, typeKey, id);
    need(actor, docAction(typeKey, 'attach'));
    if (!actor.userId) throw AppError.forbidden();
    const f = (await tx.selectFrom('app.file_object').select(['id', 'filename', 'scan_status', 'attached_to'])
      .where('tenant_id', '=', actor.tenantId).where('id', '=', input.fileId).where('is_deleted', '=', false).forUpdate().executeTakeFirst());
    if (!f) throw bad('fileId', 'The file was not found.');
    if (f.scan_status === 'pending') throw bad('fileId', `"${f.filename}" is still being scanned. Try again in a moment.`);
    if (f.scan_status !== 'clean') throw bad('fileId', `"${f.filename}" failed the virus scan and cannot be attached.`);
    if (f.attached_to) throw bad('fileId', `"${f.filename}" is already attached to another record.`);
    const row = await tx.insertInto('app.attachment').values({ entity_kind: DOCUMENT_ENTITY, entity_id: id, file_id: f.id, note: input.note ?? null, created_by: actor.userId })
      .returning(['id', 'file_id', 'note', 'created_by', 'created_at']).executeTakeFirstOrThrow();
    await tx.updateTable('app.file_object').set({ attached_to: JSON.stringify({ kind: ATTACH_KIND, id, field: 'attachments' }) })
      .where('tenant_id', '=', actor.tenantId).where('id', '=', f.id).execute();
    await this.audit.tenant(tx, { action: 'create', entity: 'attachment', entityId: row.id, actorId: actor.userId, after: { documentId: id, docType: type.key, fileId: f.id, filename: f.filename } });
    return (await this.toAttachments(tx, actor, [row]))[0]!;
  }

  async removeAttachment(tx: Tx, actor: DocActor, typeKey: string, id: string, attId: string): Promise<void> {
    await this.target(tx, actor, typeKey, id);
    need(actor, docAction(typeKey, 'attach'));
    const a = await tx.selectFrom('app.attachment').select(['id', 'file_id']).where('tenant_id', '=', actor.tenantId).where('id', '=', attId)
      .where('entity_kind', '=', DOCUMENT_ENTITY).where('entity_id', '=', id).where('is_deleted', '=', false).forUpdate().executeTakeFirst();
    if (!a) throw AppError.notFound('Attachment');
    await tx.updateTable('app.attachment').set({ is_deleted: true }).where('tenant_id', '=', actor.tenantId).where('id', '=', attId).execute();
    await tx.updateTable('app.file_object').set({ attached_to: null }).where('tenant_id', '=', actor.tenantId).where('id', '=', a.file_id).execute();
    await this.audit.tenant(tx, { action: 'delete', entity: 'attachment', entityId: attId, actorId: actor.userId, before: { documentId: id, fileId: a.file_id } });
  }

  // ------------------------------------------------------------------ timeline
  async timeline(tx: Tx, actor: DocActor, typeKey: string, id: string): Promise<TimelineEntry[]> {
    const { type, doc } = await this.target(tx, actor, typeKey, id);
    const tid = actor.tenantId;
    const info = await this.docs.types.stageInfo(tx, type.id);
    const stageName = (k: string | null) => {
      if (!k) return '';
      const l = info.labels[`waiting_${k}`];
      return l ? l.replace(/^Waiting for /, '') : humanize(k);
    };
    const [audits, actions, comments, attachments, events, lines] = await Promise.all([
      tx.selectFrom('app.audit_log').select(['id', 'at', 'actor_id', 'impersonated_by', 'action', 'before', 'after'])
        .where('tenant_id', '=', tid).where('entity', '=', DOCUMENT_ENTITY).where('entity_id', '=', id).execute(),
      tx.selectFrom('app.wf_action').select(['id', 'at', 'actor_id', 'on_behalf_of', 'stage_key', 'action', 'comment', 'decisions', 'target_stage', 'target_user_id'])
        .where('tenant_id', '=', tid).where('document_id', '=', id).execute(),
      tx.selectFrom('app.comment').select(['id', 'created_at', 'created_by', 'body', 'is_deleted', 'edited_at'])
        .where('tenant_id', '=', tid).where('entity_kind', '=', DOCUMENT_ENTITY).where('entity_id', '=', id).execute(),
      tx.selectFrom('app.attachment as a').leftJoin('app.file_object as f', 'f.id', 'a.file_id').select(['a.id', 'a.created_at', 'a.created_by', 'a.note', 'a.is_deleted', 'f.filename'])
        .where('a.tenant_id', '=', tid).where('a.entity_kind', '=', DOCUMENT_ENTITY).where('a.entity_id', '=', id).execute(),
      sql<{ k: string; event_type: string; at: Date; actor_id: string | null; reason: string | null; n: string; total: string }>`
        select coalesce(wf_action_id::text, to_char(date_trunc('second', at), 'YYYY-MM-DD"T"HH24:MI:SS')) as k, event_type, min(at) as at,
               min(actor_id::text)::uuid as actor_id, min(reason) as reason, count(distinct line_id)::text as n, sum(qty)::text as total
          from app.line_event where tenant_id = ${tid} and document_id = ${id} and wf_action_id is null
         group by 1, 2`.execute(tx),
      tx.selectFrom('app.document_line').select(['id', 'line_no']).where('tenant_id', '=', tid).where('document_id', '=', id).execute(),
    ]);
    const lineNo = new Map(lines.map(l => [l.id, l.line_no]));
    // QA3-BUG-007: edit diffs only carry fields the viewer may read (field access + formulas derived from hidden ones).
    const hidden = this.docs.store.hiddenFields(actor, await this.docs.store.bundleFor(tx, tid, type, doc));
    const names = await this.names(tx, tid, [
      ...audits.map(a => a.actor_id), ...actions.flatMap(a => [a.actor_id, a.on_behalf_of, a.target_user_id]), ...comments.map(c => c.created_by),
      ...attachments.map(a => a.created_by), ...events.rows.map(e => e.actor_id),
    ]);
    const person = (uid: string | null | undefined) => (uid ? { id: uid, name: names.get(uid) ?? '' } : null);
    const out: (TimelineEntry & { seq: number })[] = [];
    let seq = 0;
    const push = (e: TimelineEntry) => out.push({ ...e, seq: seq++ });

    for (const a of audits) {
      const after = (a.after ?? {}) as Record<string, unknown>;
      const before = (a.before ?? {}) as Record<string, unknown>;
      const base = { id: `audit:${a.id}`, at: new Date(a.at).toISOString(), actor: person(a.actor_id), impersonatedBy: a.impersonated_by ? { id: a.impersonated_by, name: 'Support' } : null };
      switch (a.action) {
        case 'create': push({ ...base, kind: 'created', title: `Created ${type.name.toLowerCase()}` }); break;
        case 'copy': push({ ...base, kind: 'created', title: `Created as a copy`, detail: null }); break;
        case 'update': push({ ...base, kind: 'updated', title: 'Edited', changes: diff(before, after, hidden) }); break;
        case 'submit': push({ ...base, kind: 'submitted', title: `Submitted${after.number ? ` as ${String(after.number)}` : ''}` }); break;
        case 'status': push({ ...base, kind: 'status', title: `Status changed to ${String(after.label ?? statusLabel(String(after.status), info.labels))}` }); break;
        case 'cancel': {
          const nos = (after.lineNos as number[] | undefined) ?? [];
          push({ ...base, kind: 'cancelled', title: after.whole ? 'Cancelled the document' : `Cancelled ${plural(nos.length, 'line')} (${nos.map(n => `#${n}`).join(', ')})`, detail: String(after.reason ?? '') || null });
          break;
        }
        case 'close': push({ ...base, kind: 'closed', title: after.whole ? 'Closed the document' : 'Closed lines', detail: String(after.reason ?? '') || null }); break;
        case 'return_to_draft': push({ ...base, kind: 'status', title: 'Returned to draft', detail: String(after.reason ?? '') || null }); break;
        default: push({ ...base, kind: 'audit', title: humanize(a.action) });
      }
    }
    for (const w of actions) {
      const decisions = (Array.isArray(w.decisions) ? w.decisions : []) as { lineId: string; approve?: string; hold?: string; reject?: string; reason?: string | null }[];
      const lineDecisions = decisions.map(d => ({
        lineNo: lineNo.get(d.lineId) ?? 0, approve: d.approve, hold: d.hold, reject: d.reject, reason: d.reason ?? null,
      })).sort((x, y) => x.lineNo - y.lineNo);
      push({
        id: `wf:${w.id}`, kind: 'workflow', at: new Date(w.at).toISOString(), actor: person(w.actor_id), onBehalfOf: person(w.on_behalf_of),
        title: workflowSentence(w.action, stageName(w.stage_key), decisions, stageName(w.target_stage) || w.target_stage, names.get(w.target_user_id ?? '') ?? null),
        detail: w.comment, ...(lineDecisions.length ? { lineDecisions } : {}),
      });
    }
    for (const c of comments) {
      push({ id: `comment:${c.id}`, kind: 'comment', at: new Date(c.created_at).toISOString(), actor: person(c.created_by),
        title: c.is_deleted ? 'Comment removed' : 'Commented', detail: c.is_deleted ? null : plainExcerpt(c.body, 5000) });
    }
    for (const a of attachments) {
      push({ id: `attachment:${a.id}`, kind: 'attachment', at: new Date(a.created_at).toISOString(), actor: person(a.created_by),
        title: `${a.is_deleted ? 'Attached (since removed)' : 'Attached'} ${a.filename ?? 'a file'}`, detail: a.note });
    }
    for (const e of events.rows) {
      push({ id: `qty:${e.event_type}:${e.k}`, kind: 'quantity', at: new Date(e.at).toISOString(), actor: person(e.actor_id),
        title: `${humanize(e.event_type)} ${fromUnits(toUnits(e.total))} on ${plural(Number(e.n), 'line')}`, detail: e.reason });
    }
    // ---- Phase 6 (notify agent): emails / WhatsApp messages sent for this document (timeline kind 'audit', id msg:<id>).
    const messages = await tx.selectFrom('app.outbound_message').select(['id', 'channel', 'recipient', 'recipient_name', 'status', 'created_at', 'created_by', 'manual', 'error'])
      .where('tenant_id', '=', tid).where('document_id', '=', id).where('channel', 'in', ['email', 'whatsapp']).orderBy('created_at').limit(200).execute();
    const msgNames = await this.names(tx, tid, messages.map(m => m.created_by));
    for (const m of messages) {
      const how = m.channel === 'email' ? 'Emailed' : 'Sent on WhatsApp to';
      const state = MESSAGE_STATE[m.status] ?? m.status;
      push({ id: `msg:${m.id}`, kind: 'audit', at: new Date(m.created_at).toISOString(), actor: m.created_by ? { id: m.created_by, name: msgNames.get(m.created_by) ?? '' } : null,
        title: `${how} ${m.recipient_name ? `${m.recipient_name} <${m.recipient}>` : m.recipient} (${state})`, detail: m.error });
    }
    const kindRank: Record<string, number> = { created: 0, updated: 1, submitted: 2, quantity: 3, workflow: 4, status: 5, cancelled: 6, closed: 6, comment: 7, attachment: 7, audit: 8 };
    out.sort((x, y) => (y.at < x.at ? -1 : y.at > x.at ? 1 : (kindRank[y.kind] ?? 9) - (kindRank[x.kind] ?? 9) || y.seq - x.seq));
    return out.map(({ seq: _s, ...e }) => e);
  }
}

/** "Approved 2 lines, held 1, rejected 1 at HOD approval". */
export function workflowSentence(action: string, stage: string, decisions: { approve?: string; hold?: string; reject?: string }[], target: string | null, targetUser: string | null): string {
  const at = stage ? ` at ${stage}` : '';
  switch (action) {
    case 'decide': {
      const n = (k: 'approve' | 'hold' | 'reject') => decisions.filter(d => toUnits(d[k] ?? '0') > 0n).length;
      const parts: string[] = [];
      const a = n('approve'); const h = n('hold'); const r = n('reject');
      if (a) parts.push(`approved ${plural(a, 'line')}`);
      if (h) parts.push(`held ${parts.length ? h : plural(h, 'line')}`);
      if (r) parts.push(`rejected ${parts.length ? r : plural(r, 'line')}`);
      if (!parts.length) return `Decided${at}`;
      const s = parts.join(', ');
      return `${s[0]!.toUpperCase()}${s.slice(1)}${at}`;
    }
    case 'unhold': return `Released held quantity${at}`;
    case 'send_back': return target === '_draft' || target === 'Draft' ? `Sent back to the creator${at ? ` from ${stage}` : ''}` : `Sent back to ${target ?? 'an earlier stage'}${at ? ` from ${stage}` : ''}`;
    case 'forward': return `Forwarded to ${targetUser ?? 'another user'}${at}`;
    case 'escalate': return `Escalated${at}`;
    case 'remind': return `Reminder sent${at}`;
    case 'auto_skip': return `Skipped ${stage || 'a stage'}`;
    case 'auto_approve': return 'Approved automatically';
    case 'submit': return 'Entered the workflow';
    case 'complete': return 'Workflow completed';
    case 'cancel': return 'Workflow cancelled';
    default: return `${humanize(action)}${at}`;
  }
}

/** Field-level changes between two audit snapshots (header values; line changes summarised per line). */
export function diff(
  before: Record<string, unknown>, after: Record<string, unknown>, hidden: { header: Set<string>; line: Set<string> } = { header: new Set(), line: new Set() },
): { field: string; label: string; before: unknown; after: unknown }[] {
  const out: { field: string; label: string; before: unknown; after: unknown }[] = [];
  const visible = (v: unknown, keys: Set<string>) => {
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !keys.has(k) && !k.startsWith('__')));
  };
  const bv = visible(before.values ?? {}, hidden.header) as Record<string, unknown>;
  const av = visible(after.values ?? {}, hidden.header) as Record<string, unknown>;
  const lines = (x: unknown) => ((x ?? []) as { id: string; lineNo: number; values: unknown }[]).map(l => ({ ...l, values: visible(l.values, hidden.line) }));
  before = { ...before, lines: lines(before.lines) };
  after = { ...after, lines: lines(after.lines) };
  for (const k of [...new Set([...Object.keys(bv), ...Object.keys(av)])].sort()) {
    if (JSON.stringify(bv[k] ?? null) !== JSON.stringify(av[k] ?? null)) out.push({ field: k, label: humanize(k), before: bv[k] ?? null, after: av[k] ?? null });
  }
  const bl = new Map(((before.lines ?? []) as { id: string; lineNo: number; values: unknown }[]).map(l => [l.id, l]));
  const al = new Map(((after.lines ?? []) as { id: string; lineNo: number; values: unknown }[]).map(l => [l.id, l]));
  for (const [lid, l] of al) {
    const p = bl.get(lid);
    if (!p) out.push({ field: `lines.${l.lineNo}`, label: `Line ${l.lineNo}`, before: null, after: l.values });
    else if (JSON.stringify(p.values) !== JSON.stringify(l.values)) out.push({ field: `lines.${l.lineNo}`, label: `Line ${l.lineNo}`, before: p.values, after: l.values });
  }
  for (const [lid, p] of bl) if (!al.has(lid)) out.push({ field: `lines.${p.lineNo}`, label: `Line ${p.lineNo}`, before: p.values, after: null });
  return out;
}
