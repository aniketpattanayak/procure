import { Injectable, Logger } from '@nestjs/common';
import { FormDefinition, MasterCreate } from '@procure/schema';
import { sql } from 'kysely';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { Actor, FormsService } from './forms.service';
import { MastersService } from './masters.service';
import { upsertMasterRegistry } from './registry';
import { RecordsService } from './records.service';
import { STANDARD_BUNDLE, STANDARD_TEMPLATE_ROW, SYSTEM_MASTERS, TemplateBundle, TemplateMaster, USER_FORM } from './templates';

/**
 * Copies global templates into the tenant in the caller's transaction (tenant context must be set).
 *
 * - `apply(tx, null)`: system forms/masters only (every tenant).
 * - `apply(tx, 'standard')`: also the bundle's roles, sample records and settings. The bundle is read from
 *   `platform.global_template` (kind `bundle`), so this needs the platform-role transaction of tenant provisioning;
 *   the built-in `standard` content is inserted there on first use if the row is missing (the demo seed also upserts it).
 * - `applyBundle(tx, content)`: same with content in hand (works in a normal tenant transaction).
 *
 * Idempotent: existing forms, masters, records (by code), roles (by key) and settings are left untouched.
 */
@Injectable()
export class TemplateInstaller {
  private readonly log = new Logger('Templates');

  constructor(
    private readonly forms: FormsService,
    private readonly masters: MastersService,
    private readonly records: RecordsService,
    private readonly audit: AuditService,
  ) {}

  async apply(tx: Tx, bundleKey: string | null): Promise<{ bundle: string | null; applied: boolean }> {
    const actor = await this.engineActor(tx);
    await this.installSystem(tx, actor);
    if (!bundleKey) return { bundle: null, applied: false };
    const content = await this.loadBundle(tx, bundleKey);
    if (!content) {
      this.log.warn(`template bundle "${bundleKey}" not found; tenant created with system forms only`);
      return { bundle: bundleKey, applied: false };
    }
    await this.applyBundle(tx, content, actor);
    return { bundle: bundleKey, applied: true };
  }

  async engineActor(tx: Tx): Promise<Actor> {
    const r = await sql<{ t: string | null }>`select app.current_tenant_id()::text as t`.execute(tx);
    const tenantId = r.rows[0]?.t;
    if (!tenantId) throw new Error('TemplateInstaller needs a transaction with tenant context');
    return { tenantId, userId: null, perms: null };
  }

  /** System masters (uom, payment_terms, item, vendor, terms) and the user form. */
  async installSystem(tx: Tx, actor?: Actor): Promise<void> {
    const a = actor ?? await this.engineActor(tx);
    for (const m of SYSTEM_MASTERS) await this.ensureMaster(tx, a, m, true);
    const userForm = await tx.selectFrom('app.form_def').select('id').where('tenant_id', '=', a.tenantId).where('key', '=', USER_FORM.key).executeTakeFirst();
    if (!userForm) {
      await this.forms.createPublished(tx, a, {
        key: USER_FORM.key, name: USER_FORM.name, kind: 'system', isSystem: true, definition: FormDefinition.parse(USER_FORM.definition),
      });
    }
  }

  async applyBundle(tx: Tx, content: TemplateBundle, actor?: Actor): Promise<void> {
    const a = actor ?? await this.engineActor(tx);
    for (const m of content.masters ?? []) await this.ensureMaster(tx, a, m, false);
    const recordSets = [...(content.masters ?? []).filter(m => m.records?.length).map(m => ({ master: m.key, rows: m.records! })), ...(content.records ?? [])];
    for (const set of recordSets) {
      const master = await this.masters.find(tx, a.tenantId, set.master);
      if (!master) continue;
      for (const row of set.rows) {
        const exists = await tx.selectFrom('app.master_record').select('id')
          .where('tenant_id', '=', a.tenantId).where('master_id', '=', master.id).where('is_deleted', '=', false)
          .where(sql<boolean>`code = ${row.code}::citext`).executeTakeFirst();
        if (!exists) await this.records.save(tx, a, master, { code: row.code, name: row.name, data: row.data ?? {} }, null);
      }
    }
    if (content.roles?.length) {
      const known = new Set((await sql<{ key: string }>`
        select key from app.platform_permission_defs()
        union select key from app.permission_def where tenant_id = ${a.tenantId}`.execute(tx)).rows.map(r => r.key));
      for (const role of content.roles) {
        const exists = await tx.selectFrom('app.role').select('id').where('tenant_id', '=', a.tenantId).where('key', '=', role.key).executeTakeFirst();
        if (exists) continue;
        const r = await tx.insertInto('app.role').values({ tenant_id: a.tenantId, key: role.key, name: role.name, description: role.description ?? null })
          .returning('id').executeTakeFirstOrThrow();
        const grants = [...new Set(role.grants)].filter(k => known.has(k));
        if (grants.length) {
          await tx.insertInto('app.permission_grant').values(grants.map(perm_key => ({ tenant_id: a.tenantId, role_id: r.id, perm_key, effect: 'allow' as const }))).execute();
        }
        await this.audit.tenant(tx, { action: 'create', entity: 'role', entityId: r.id, after: { key: role.key, name: role.name, grants, source: 'template' } });
      }
    }
    for (const [key, value] of Object.entries(content.settings ?? {})) {
      await tx.insertInto('app.tenant_setting').values({ tenant_id: a.tenantId, key, value: JSON.stringify(value) })
        .onConflict(oc => oc.columns(['tenant_id', 'key']).doNothing()).execute();
    }
  }

  private async ensureMaster(tx: Tx, actor: Actor, m: TemplateMaster, isSystem: boolean) {
    const existing = await this.masters.find(tx, actor.tenantId, m.key);
    if (existing) {
      // keep generated keys in place (e.g. tenants provisioned before a registry change)
      await upsertMasterRegistry(tx, actor.tenantId, { id: existing.id, key: existing.key, name: existing.name, pluralName: existing.plural_name });
      return;
    }
    const input = MasterCreate.parse({
      key: m.key, name: m.name, pluralName: m.pluralName, description: m.description, settings: m.settings ?? {}, definition: m.definition,
    });
    await this.masters.create(tx, actor, input, { isSystem });
  }

  /** Reads a bundle from platform.global_template (platform role). Inserts the built-in `standard` row if missing. */
  private async loadBundle(tx: Tx, key: string): Promise<TemplateBundle | null> {
    const row = await tx.selectFrom('platform.global_template').select('content')
      .where('kind', '=', 'bundle').where('key', '=', key).where('is_active', '=', true).executeTakeFirst();
    if (row) return row.content as TemplateBundle;
    if (key !== STANDARD_TEMPLATE_ROW.key) return null;
    await tx.insertInto('platform.global_template')
      .values({ ...STANDARD_TEMPLATE_ROW, content: JSON.stringify(STANDARD_BUNDLE) })
      .onConflict(oc => oc.columns(['kind', 'key']).doNothing()).execute();
    return STANDARD_BUNDLE;
  }
}
