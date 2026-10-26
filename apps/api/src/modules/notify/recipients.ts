import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { TriggerRecipient } from '@procure/schema';
import { RawBuilder, sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import type { DocumentSnapshot } from '../../core/ports';
import { EngineService } from '../workflow';
import { normaliseAddress } from './util/address';

export type Recipient = z.infer<typeof TriggerRecipient>;
export type Channel = 'email' | 'whatsapp' | 'inapp';
/** `stage_actors` with this stage = the stage named by the event (workflow.stage_entered, sla_reminder, …). */
export const CURRENT_STAGE = '_current';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One resolved destination. `address` is an email / E.164 phone, or the user id for in-app. */
export interface Resolved { address: string; name: string | null; userId: string | null; source: Recipient['type'] }
export interface Skipped { source: Recipient['type']; name: string | null; reason: string }

interface UserRow { id: string; name: string; email: string; phone: string | null }

/**
 * Turns rule recipients into channel addresses for one document: party (vendor master email/phone), submitter,
 * role holders (optionally limited to users whose data scope covers the document's location), named users, stage
 * actors, a header field (user lookup, master lookup with email/phone, or a literal address) and fixed addresses.
 * Missing / invalid addresses are reported as skipped, never sent. Duplicates collapse to one.
 */
@Injectable()
export class RecipientResolver {
  constructor(private readonly engine: EngineService) {}

  /** `eventStage`: stage key carried by the event (workflow.* events) — used by `stage_actors` with stage `_current`. */
  async resolve(tx: Tx, tenantId: string, channel: Channel, list: Recipient[], snap: DocumentSnapshot | null, eventStage: string | null = null): Promise<{ to: Resolved[]; skipped: Skipped[] }> {
    const to: Resolved[] = [];
    const skipped: Skipped[] = [];
    const users = async (ids: string[], source: Recipient['type']) => {
      const uniq = [...new Set(ids.filter(id => UUID_RE.test(id)))];
      if (!uniq.length) return;
      const rows = await tx.selectFrom('app.tenant_user').select(['id', 'name', 'email', 'phone'])
        .where('id', 'in', uniq).where('is_active', '=', true).where('is_deleted', '=', false).execute();
      for (const u of rows) this.addUser(channel, u, source, to, skipped);
    };
    for (const r of list) {
      switch (r.type) {
        case 'party': {
          const id = snap?.values.party;
          if (typeof id !== 'string' || !UUID_RE.test(id)) { skipped.push({ source: 'party', name: null, reason: 'The document has no party (vendor)' }); break; }
          await this.masterRecord(tx, channel, id, 'party', to, skipped);
          break;
        }
        case 'submitter':
          if (snap?.submittedBy) await users([snap.submittedBy], 'submitter');
          else skipped.push({ source: 'submitter', name: null, reason: 'The document has not been submitted' });
          break;
        case 'users': await users(r.userIds, 'users'); break;
        case 'role': {
          const scope: RawBuilder<boolean> = r.withinScope && snap ? inScopeSql(`doc.${snap.docTypeKey}`, snap.locationPath) : sql<boolean>`true`;
          const rows = await sql<UserRow>`
            select u.id, u.name, u.email, u.phone from app.tenant_user u
             where u.is_active and not u.is_deleted
               and exists (select 1 from app.user_role ur join app.role ro on ro.id = ur.role_id and not ro.is_deleted where ur.user_id = u.id and ur.role_id = ${r.roleId})
               and ${scope}
             order by u.name, u.id limit 200`.execute(tx);
          for (const u of rows.rows) this.addUser(channel, u, 'role', to, skipped);
          break;
        }
        case 'stage_actors': {
          const stage = r.stage === CURRENT_STAGE ? eventStage : r.stage;
          if (snap && stage) await users(await this.engine.stageActors(tx, tenantId, snap.id, stage), 'stage_actors');
          else skipped.push({ source: 'stage_actors', name: r.stage, reason: 'No stage' });
          break;
        }
        case 'field': {
          const v = snap?.values[r.field];
          if (typeof v !== 'string' || !v.trim()) { skipped.push({ source: 'field', name: r.field, reason: `"${r.field}" is empty` }); break; }
          if (UUID_RE.test(v)) {
            const isUser = await tx.selectFrom('app.tenant_user').select('id').where('id', '=', v).executeTakeFirst();
            if (isUser) await users([v], 'field');
            else await this.masterRecord(tx, channel, v, 'field', to, skipped);
          } else this.addAddress(channel, v, null, 'field', to, skipped);
          break;
        }
        case 'fixed': this.addAddress(channel, r.address, null, 'fixed', to, skipped); break;
      }
    }
    const seen = new Set<string>();
    return { to: to.filter(x => (seen.has(x.address) ? false : (seen.add(x.address), true))), skipped };
  }

  private addUser(channel: Channel, u: UserRow, source: Recipient['type'], to: Resolved[], skipped: Skipped[]) {
    if (channel === 'inapp') { to.push({ address: u.id, name: u.name, userId: u.id, source }); return; }
    const raw = channel === 'email' ? u.email : u.phone;
    if (!raw) { skipped.push({ source, name: u.name, reason: channel === 'email' ? 'No email address' : 'No phone number' }); return; }
    const n = normaliseAddress(channel, raw);
    if (n.valid) to.push({ address: n.address, name: u.name, userId: u.id, source });
    else skipped.push({ source, name: u.name, reason: n.reason ?? 'Invalid address' });
  }

  private addAddress(channel: Channel, raw: string, name: string | null, source: Recipient['type'], to: Resolved[], skipped: Skipped[]) {
    if (channel === 'inapp') { skipped.push({ source, name, reason: 'In-app messages go to users only' }); return; }
    const n = normaliseAddress(channel, raw);
    if (n.valid) to.push({ address: n.address, name, userId: null, source });
    else skipped.push({ source, name: name ?? raw, reason: n.reason ?? 'Invalid address' });
  }

  /** Master record (vendor/customer) contact: data.email / data.phone (also `mobile` / `whatsapp` for phones). */
  private async masterRecord(tx: Tx, channel: Channel, id: string, source: Recipient['type'], to: Resolved[], skipped: Skipped[]) {
    const m = await tx.selectFrom('app.master_record').select(['name', 'data']).where('id', '=', id).where('is_deleted', '=', false).executeTakeFirst();
    if (!m) { skipped.push({ source, name: null, reason: 'Record not found' }); return; }
    if (channel === 'inapp') { skipped.push({ source, name: m.name, reason: 'In-app messages go to users only' }); return; }
    const d = (m.data ?? {}) as Record<string, unknown>;
    const raw = channel === 'email' ? d.email : (d.whatsapp ?? d.phone ?? d.mobile);
    if (typeof raw !== 'string' || !raw.trim()) { skipped.push({ source, name: m.name, reason: channel === 'email' ? 'No email address on the record' : 'No phone number on the record' }); return; }
    this.addAddress(channel, raw, m.name, source, to, skipped);
  }
}

/** SQL: location `path` is in user u's data scope for `tab` (tab-specific scope rows replace the default rows). */
export function inScopeSql(tab: string, path: string): RawBuilder<boolean> {
  const mine = (a: string) => sql`(${sql.ref(`${a}.user_id`)} = u.id or ${sql.ref(`${a}.role_id`)} in (select ur.role_id from app.user_role ur join app.role r on r.id = ur.role_id and not r.is_deleted where ur.user_id = u.id))`;
  return sql<boolean>`(u.is_tenant_admin or exists (
    select 1 from app.scope_grant sg left join app.location_node n on n.id = sg.node_id
    where ${mine('sg')}
      and sg.tab_key is not distinct from (case when exists (select 1 from app.scope_grant sg2 where ${mine('sg2')} and sg2.tab_key = ${tab}) then ${tab} else null end)
      and (sg.all_nodes or (sg.include_descendants and ${path}::ltree <@ n.path) or (not sg.include_descendants and n.path = ${path}::ltree))))`;
}
