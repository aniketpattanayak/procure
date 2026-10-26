import { Injectable } from '@nestjs/common';
import { FormDefinition, MasterCreate, MasterSettings, MasterSummary, MasterUpdate, perm } from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { emptyMasterDefinition } from './definition';
import { Actor, FormsService } from './forms.service';
import { upsertMasterRegistry } from './registry';

export interface MasterRow {
  id: string;
  key: string;
  name: string;
  plural_name: string;
  description: string | null;
  form_id: string;
  is_system: boolean;
  is_active: boolean;
  settings: unknown;
  version: number;
}

const MASTER_COLS = ['id', 'key', 'name', 'plural_name', 'description', 'form_id', 'is_system', 'is_active', 'settings', 'version'] as const;

export const settingsOf = (m: MasterRow): MasterSettings => MasterSettings.parse(m.settings ?? {});

/** Masters: definition rows, their forms and their generated permission keys. Callers bump permver after commit. */
@Injectable()
export class MastersService {
  constructor(private readonly forms: FormsService, private readonly audit: AuditService) {}

  async load(tx: Tx, tenantId: string, key: string, lock = false): Promise<MasterRow> {
    let q = tx.selectFrom('app.master_def').select([...MASTER_COLS]).where('tenant_id', '=', tenantId).where('key', '=', key);
    if (lock) q = q.forUpdate();
    const m = await q.executeTakeFirst();
    if (!m) throw AppError.notFound('Master');
    return m as MasterRow;
  }

  async find(tx: Tx, tenantId: string, key: string): Promise<MasterRow | undefined> {
    return (await tx.selectFrom('app.master_def').select([...MASTER_COLS]).where('tenant_id', '=', tenantId).where('key', '=', key)
      .executeTakeFirst()) as MasterRow | undefined;
  }

  /**
   * GET /masters: masters whose `master.<key>:action.view` the caller holds; config viewers see all of them (including
   * inactive ones). `perms: null` (engine) sees everything.
   */
  async list(tx: Tx, actor: Actor): Promise<MasterSummary[]> {
    const rows = await tx.selectFrom('app.master_def as m')
      .select(MASTER_COLS.map(c => `m.${c}` as const))
      .select(eb => eb.selectFrom('app.master_record as r').select(e => e.fn.countAll<string>().as('n'))
        .whereRef('r.master_id', '=', 'm.id').where('r.tenant_id', '=', actor.tenantId).where('r.is_deleted', '=', false).as('record_count'))
      .where('m.tenant_id', '=', actor.tenantId).orderBy('m.is_system', 'desc').orderBy('m.name').execute();
    const keys = new Set(actor.perms?.keys ?? []);
    const designer = !actor.perms || keys.has('config.masters:action.view');
    return rows
      .filter(r => designer || (r.is_active && keys.has(perm.action(perm.masterTab(r.key), 'view'))))
      .map(r => toSummary(r as MasterRow, Number(r.record_count ?? 0)));
  }

  async summary(tx: Tx, tenantId: string, m: MasterRow): Promise<MasterSummary> {
    const c = await tx.selectFrom('app.master_record').select(e => e.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenantId).where('master_id', '=', m.id).where('is_deleted', '=', false).executeTakeFirstOrThrow();
    return toSummary(m, Number(c.n));
  }

  /**
   * POST /config/masters (and system masters from the template installer): form + version 1 + master row +
   * registry keys. Non-system masters count against the plan's `custom_forms` limit.
   */
  async create(tx: Tx, actor: Actor, input: z.infer<typeof MasterCreate>, opts: { isSystem?: boolean } = {}): Promise<MasterSummary> {
    const isSystem = opts.isSystem ?? false;
    if (!isSystem) {
      const r = await sql<{ lim: string | null }>`select app.lock_tenant_for_limit('custom_forms') as lim`.execute(tx);
      const lim = r.rows[0]?.lim;
      const limit = lim === null || lim === undefined ? null : Number(lim);
      const c = await tx.selectFrom('app.master_def').select(e => e.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', actor.tenantId).where('is_system', '=', false).executeTakeFirstOrThrow();
      // custom_forms = non-system masters + custom document types (same limit, counted together).
      const d = await tx.selectFrom('app.doc_type').select(e => e.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', actor.tenantId).where('kind', '=', 'custom').executeTakeFirstOrThrow();
      const used = Number(c.n) + Number(d.n);
      if (limit !== null && used + 1 > limit) throw AppError.limitExceeded('custom_forms', limit, used, 'custom forms / masters');
    }
    const clash = await tx.selectFrom('app.master_def').select('id').where('tenant_id', '=', actor.tenantId).where('key', '=', input.key).executeTakeFirst()
      ?? await tx.selectFrom('app.form_def').select('id').where('tenant_id', '=', actor.tenantId).where('key', '=', input.key).executeTakeFirst();
    if (clash) throw AppError.conflict(`The key "${input.key}" is already used by another master or form.`, { field: 'key' });

    const definition: FormDefinition = input.definition ?? emptyMasterDefinition();
    const { form } = await this.forms.createPublished(tx, actor, {
      key: input.key, name: input.name, kind: 'master', isSystem, definition, selfMasterKey: input.key,
    });
    const settings = MasterSettings.parse(input.settings ?? {});
    const row = await tx.insertInto('app.master_def').values({
      tenant_id: actor.tenantId, key: input.key, name: input.name, plural_name: input.pluralName, description: input.description ?? null,
      form_id: form.id, is_system: isSystem, settings: JSON.stringify(settings), created_by: actor.userId, updated_by: actor.userId,
    }).returning([...MASTER_COLS]).executeTakeFirstOrThrow();
    const m = row as MasterRow;
    await upsertMasterRegistry(tx, actor.tenantId, { id: m.id, key: m.key, name: m.name, pluralName: m.plural_name });
    const out = toSummary(m, 0);
    await this.audit.tenant(tx, { action: 'create', entity: 'master', entityId: m.id, after: out, actorId: actor.userId });
    return out;
  }

  async update(tx: Tx, actor: Actor, key: string, input: z.infer<typeof MasterUpdate>): Promise<MasterSummary> {
    const before = await this.load(tx, actor.tenantId, key, true);
    if (before.version !== input.version) throw AppError.versionConflict();
    const set: Record<string, unknown> = { updated_by: actor.userId };
    if (input.name !== undefined) set.name = input.name;
    if (input.pluralName !== undefined) set.plural_name = input.pluralName;
    if (input.description !== undefined) set.description = input.description;
    if (input.settings !== undefined) set.settings = JSON.stringify(MasterSettings.parse(input.settings));
    await tx.updateTable('app.master_def').set(set).where('tenant_id', '=', actor.tenantId).where('id', '=', before.id).execute();
    if (input.name !== undefined) {
      await tx.updateTable('app.form_def').set({ name: input.name, updated_by: actor.userId })
        .where('tenant_id', '=', actor.tenantId).where('id', '=', before.form_id).execute();
    }
    const after = await this.load(tx, actor.tenantId, key);
    await upsertMasterRegistry(tx, actor.tenantId, { id: after.id, key: after.key, name: after.name, pluralName: after.plural_name });
    const out = await this.summary(tx, actor.tenantId, after);
    await this.audit.tenant(tx, { action: 'update', entity: 'master', entityId: after.id, before: toSummary(before, out.recordCount), after: out, actorId: actor.userId });
    return out;
  }

  async setActive(tx: Tx, actor: Actor, key: string, active: boolean): Promise<MasterSummary> {
    const m = await this.load(tx, actor.tenantId, key, true);
    if (m.is_system) throw AppError.conflict(`"${m.name}" is a system master and cannot be ${active ? 'activated' : 'deactivated'}.`);
    if (m.is_active !== active) {
      await tx.updateTable('app.master_def').set({ is_active: active, updated_by: actor.userId })
        .where('tenant_id', '=', actor.tenantId).where('id', '=', m.id).execute();
      await this.audit.tenant(tx, { action: active ? 'activate' : 'deactivate', entity: 'master', entityId: m.id, before: { isActive: m.is_active }, after: { isActive: active }, actorId: actor.userId });
    }
    return this.summary(tx, actor.tenantId, await this.load(tx, actor.tenantId, key));
  }
}

export function toSummary(m: MasterRow, recordCount: number): MasterSummary {
  return {
    id: m.id, key: m.key, name: m.name, pluralName: m.plural_name, description: m.description, isSystem: m.is_system, isActive: m.is_active,
    formKey: m.key, recordCount, settings: settingsOf(m), version: m.version,
  };
}
