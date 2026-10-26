import { Injectable } from '@nestjs/common';
import { DocTypeCreate, WorkflowDefinition } from '@procure/schema';
import type { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { DocTypesService, docTab } from '../../documents';
import { DefinitionsService } from '../../workflow';

export interface ExtraKey {
  /** Action name: the key becomes `doc.<type>:action.<name>`. */
  name: string;
  label: string;
  requiresFeature: string | null;
  requiresSetting?: string | null;
  sortOrder?: number;
}

export interface SystemTypeSpec {
  create: z.input<typeof DocTypeCreate>;
  moduleKey: string;
  /** Boolean flow setting that hides the whole tab when off (e.g. flow.indent.enabled). */
  tabSetting: string | null;
  extraKeys: ExtraKey[];
  workflow: z.input<typeof WorkflowDefinition>;
  workflowNote: string;
}

/**
 * Idempotent provisioning of one system document type (shared by agent A's indent / vendor_selection and agent B's
 * po): create-if-missing through the documents core (forms, static keys, default numbering), flow-setting gating of
 * the tab, extra procurement keys, and a default published workflow when the type has none. Never overwrites tenant
 * edits (forms, numbering, workflows). Callers bump permver after commit.
 */
@Injectable()
export class SystemTypeInstaller {
  constructor(private readonly types: DocTypesService, private readonly defs: DefinitionsService) {}

  async ensure(tx: Tx, tenantId: string, actorId: string | null, spec: SystemTypeSpec): Promise<{ id: string; created: boolean }> {
    const input = DocTypeCreate.parse(spec.create);
    let t = await this.types.find(tx, tenantId, input.key);
    let created = false;
    if (!t) {
      await this.types.create(tx, { tenantId, userId: actorId, perms: null }, input, { kind: 'system', moduleKey: spec.moduleKey });
      t = (await this.types.find(tx, tenantId, input.key))!;
      created = true;
    }
    if (t.kind !== 'system') return { id: t.id, created: false }; // a tenant's own custom type with that key: leave it alone
    const tab = docTab(t.key);
    await tx.updateTable('app.permission_def').set({ requires_setting: spec.tabSetting, requires_feature: spec.moduleKey })
      .where('tenant_id', '=', tenantId).where('key', '=', tab).execute();
    if (spec.extraKeys.length) {
      await tx.insertInto('app.permission_def').values(spec.extraKeys.map((k, i) => ({
        tenant_id: tenantId, key: `${tab}:action.${k.name}`, kind: 'action' as const, tab_key: tab, label: k.label, description: null, group_label: null,
        requires_feature: k.requiresFeature, requires_setting: k.requiresSetting ?? null, sort_order: k.sortOrder ?? 50 + i, source: 'form' as const, source_id: t!.id,
      }))).onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet(eb => ({
        label: eb.ref('excluded.label'), requires_feature: eb.ref('excluded.requires_feature'), requires_setting: eb.ref('excluded.requires_setting'),
      }))).execute();
    }
    const dt = { id: t.id, key: t.key, name: t.name, header_form_id: t.header_form_id, line_form_id: t.line_form_id };
    const def = await this.defs.ensureDef(tx, tenantId, dt, actorId, true);
    if (!def.current_version_id) {
      await this.defs.publishDefinition(tx, tenantId, dt, def, WorkflowDefinition.parse(spec.workflow), spec.workflowNote, actorId);
    }
    return { id: t.id, created };
  }
}
