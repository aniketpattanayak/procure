import { Injectable } from '@nestjs/common';
import { ErrorCode, WhatsAppTemplateInput } from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import { DbService } from '../../../core/db.service';
import { AppError } from '../../../core/errors';

type Input = z.infer<typeof WhatsAppTemplateInput>;
export interface WhatsAppTemplateRow extends Input { id: string; createdAt: string }

/** Placeholders {{n}} used in the body must be exactly 1..N and each must have a variable label. */
function validate(i: Input) {
  const used = [...new Set([...i.body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a, b) => a - b);
  const declared = new Set(i.variables.map(v => v.index));
  const missing = used.filter(n => !declared.has(n));
  if (missing.length) throw new AppError(400, ErrorCode.VALIDATION, `Describe variable {{${missing[0]}}} in "variables".`, undefined, [{ path: 'variables', message: `Missing {{${missing.join('}}, {{')}}}` }]);
  if (used.some((n, k) => n !== k + 1)) throw new AppError(400, ErrorCode.VALIDATION, 'Placeholders must be numbered {{1}}, {{2}}, … without gaps.', undefined, [{ path: 'body', message: 'Placeholders must be consecutive' }]);
}

/** Super Admin WhatsApp template catalogue (Meta-approved) and per-tenant approvals. */
@Injectable()
export class WhatsAppCatalogService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private toRow(r: { id: string; name: string; language: string; category: string; header_kind: string; body: string; variables: unknown; meta_status: string; is_active: boolean; created_at: Date }): WhatsAppTemplateRow {
    return {
      id: r.id, name: r.name, language: r.language, category: r.category as Input['category'], headerKind: r.header_kind as Input['headerKind'], body: r.body,
      variables: (r.variables ?? []) as Input['variables'], metaStatus: r.meta_status as Input['metaStatus'], isActive: r.is_active, createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async list(): Promise<WhatsAppTemplateRow[]> {
    const rows = await this.db.platform.selectFrom('platform.whatsapp_template').selectAll().orderBy('name').orderBy('language').execute();
    return rows.map(r => this.toRow(r));
  }

  async create(i: Input): Promise<WhatsAppTemplateRow> {
    validate(i);
    return this.db.platformTx(async tx => {
      const r = await tx.insertInto('platform.whatsapp_template').values({
        name: i.name, language: i.language, category: i.category, header_kind: i.headerKind, body: i.body, variables: JSON.stringify(i.variables), meta_status: i.metaStatus, is_active: i.isActive,
      }).returningAll().executeTakeFirstOrThrow().catch(e => {
        if ((e as { code?: string }).code === '23505') throw AppError.conflict(`A template "${i.name}" (${i.language}) already exists.`, { field: 'name' });
        throw e;
      });
      await this.audit.platform(tx, { action: 'create', entity: 'whatsapp_template', entityId: r.id, after: { name: i.name, language: i.language, status: i.metaStatus } });
      return this.toRow(r);
    });
  }

  async update(id: string, i: Input): Promise<WhatsAppTemplateRow> {
    validate(i);
    return this.db.platformTx(async tx => {
      const cur = await tx.selectFrom('platform.whatsapp_template').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw AppError.notFound('WhatsApp template');
      const r = await tx.updateTable('platform.whatsapp_template').set({
        name: i.name, language: i.language, category: i.category, header_kind: i.headerKind, body: i.body, variables: JSON.stringify(i.variables), meta_status: i.metaStatus, is_active: i.isActive,
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
      await this.audit.platform(tx, { action: 'update', entity: 'whatsapp_template', entityId: id, before: { status: cur.meta_status, isActive: cur.is_active }, after: { status: i.metaStatus, isActive: i.isActive } });
      return this.toRow(r);
    });
  }

  /** Deactivates (tenant mappings and message templates keep referencing it; sends are refused). */
  async remove(id: string): Promise<void> {
    await this.db.platformTx(async tx => {
      const n = await tx.updateTable('platform.whatsapp_template').set({ is_active: false }).where('id', '=', id).executeTakeFirst();
      if (!Number(n.numUpdatedRows)) throw AppError.notFound('WhatsApp template');
      await this.audit.platform(tx, { action: 'deactivate', entity: 'whatsapp_template', entityId: id });
    });
  }

  async tenantAllowed(tenantId: string): Promise<{ templateIds: string[] }> {
    await this.tenant(tenantId);
    const rows = await this.db.platform.selectFrom('platform.tenant_whatsapp_template').select('template_id').where('tenant_id', '=', tenantId).execute();
    return { templateIds: rows.map(r => r.template_id).sort() };
  }

  /** Replaces the tenant's allowed set. Counts against the plan's `whatsapp_templates` limit when it has one. */
  async setTenantAllowed(tenantId: string, templateIds: string[], approvedBy: string | null): Promise<{ templateIds: string[] }> {
    const ids = [...new Set(templateIds)];
    await this.db.platformTx(async tx => {
      await this.tenant(tenantId);
      if (ids.length) {
        const found = await tx.selectFrom('platform.whatsapp_template').select('id').where('id', 'in', ids).execute();
        if (found.length !== ids.length) throw new AppError(400, ErrorCode.VALIDATION, 'One or more templates do not exist.', undefined, [{ path: 'templateIds', message: 'Unknown template' }]);
        const lim = (await sql<{ lim: string | null }>`select platform.effective_limit('whatsapp_templates', ${tenantId}::uuid) as lim`.execute(tx)).rows[0]?.lim;
        // A limit of 0 means "not set on this plan" here: the catalogue is curated by the platform, so only a positive cap restricts.
        if (lim !== null && lim !== undefined && Number(lim) > 0 && ids.length > Number(lim)) throw AppError.limitExceeded('whatsapp_templates', Number(lim), ids.length, 'WhatsApp templates');
      }
      const before = await tx.selectFrom('platform.tenant_whatsapp_template').select('template_id').where('tenant_id', '=', tenantId).execute();
      await tx.deleteFrom('platform.tenant_whatsapp_template').where('tenant_id', '=', tenantId).$if(ids.length > 0, qb => qb.where('template_id', 'not in', ids)).execute();
      if (ids.length) {
        await tx.insertInto('platform.tenant_whatsapp_template').values(ids.map(template_id => ({ tenant_id: tenantId, template_id, approved_by: approvedBy })))
          .onConflict(oc => oc.columns(['tenant_id', 'template_id']).doNothing()).execute();
      }
      await this.audit.platform(tx, { action: 'set_whatsapp_templates', entity: 'tenant', entityId: tenantId, tenantId, before: before.map(b => b.template_id), after: ids });
    });
    return this.tenantAllowed(tenantId);
  }

  private async tenant(id: string) {
    const t = await this.db.platform.selectFrom('platform.tenant').select('id').where('id', '=', id).executeTakeFirst();
    if (!t) throw AppError.notFound('Company');
  }
}
