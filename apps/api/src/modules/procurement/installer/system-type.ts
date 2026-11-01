import { Injectable } from '@nestjs/common';
import { DocTypeCreate, FormDefinition, WorkflowDefinition } from '@procure/schema';
import type { z } from 'zod';
import type { Tx } from '../../../core/db.service';
import { DocTypesService, docTab } from '../../documents';
import { FormsService } from '../../forms';
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
  /**
   * When set, after the type is found/created, publish a new version of the line form that
   * ensures these fields are present and up-to-date (by key). Existing fields not in this list
   * are left as-is. Use this to add new installer-defined fields (e.g. item_category) to
   * already-provisioned tenants without wiping their customisations.
   */
  lineFieldsToEnsure?: FormDefinition['fields'];
}

/**
 * Idempotent provisioning of one system document type (shared by agent A's indent / vendor_selection and agent B's
 * po): create-if-missing through the documents core (forms, static keys, default numbering), flow-setting gating of
 * the tab, extra procurement keys, and a default published workflow when the type has none. Never overwrites tenant
 * edits (forms, numbering, workflows). Callers bump permver after commit.
 */
@Injectable()
export class SystemTypeInstaller {
  constructor(private readonly types: DocTypesService, private readonly defs: DefinitionsService, private readonly forms: FormsService) {}

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

    // Ensure line form fields are up-to-date for existing types (e.g. after installer adds new fields).
    if (!created && t.line_form_id && spec.lineFieldsToEnsure?.length) {
      await this.ensureLineFields(tx, tenantId, actorId, t.line_form_id, spec.lineFieldsToEnsure);
    }

    const dt = { id: t.id, key: t.key, name: t.name, header_form_id: t.header_form_id, line_form_id: t.line_form_id };
    const def = await this.defs.ensureDef(tx, tenantId, dt, actorId, true);
    if (!def.current_version_id) {
      await this.defs.publishDefinition(tx, tenantId, dt, def, WorkflowDefinition.parse(spec.workflow), spec.workflowNote, actorId);
    }
    return { id: t.id, created };
  }

  /**
   * Merge installer-defined fields into an existing line form version.
   * - Fields already present (by key) are updated in-place (preserving position) with the new definition.
   * - Fields not yet present are inserted before the first non-system custom field so they appear near the start.
   * - Fields not in `wantedFields` are left untouched.
   * Publishes a new version only when something actually changed.
   */
  private async ensureLineFields(
    tx: Tx, tenantId: string, actorId: string | null,
    lineFormId: string, wantedFields: FormDefinition['fields'],
  ): Promise<void> {
    const formRow = await this.forms.loadById(tx, tenantId, lineFormId);
    const actor = { tenantId, userId: actorId, perms: null };
    const curDef: FormDefinition = formRow.current_version_id
      ? await this.forms.version(tx, tenantId, formRow.current_version_id).then(v => v.definition as FormDefinition)
      : { version: 1, fields: [], validations: [] };

    const existingByKey = new Map(curDef.fields.map((f, i) => [f.key, { field: f, index: i }]));
    let changed = false;
    const updatedFields = [...curDef.fields];

    for (const wanted of wantedFields) {
      const existing = existingByKey.get(wanted.key);
      if (existing) {
        // Update the existing field definition (e.g. add filterBy to item).
        const cur = JSON.stringify(existing.field);
        const next = JSON.stringify(wanted);
        if (cur !== next) {
          updatedFields[existing.index] = wanted as FormDefinition['fields'][number];
          changed = true;
        }
      } else {
        // Insert missing field before the first non-system tenant field (index 0 = after system fields).
        // Find the position: after the last field that appears before this key in wantedFields order.
        const wantedKeys = wantedFields.map(f => f.key);
        const wantedPos = wantedKeys.indexOf(wanted.key);
        const prevWantedKey = wantedPos > 0 ? wantedKeys[wantedPos - 1] : null;
        const insertAfterIdx = prevWantedKey ? (existingByKey.get(prevWantedKey)?.index ?? -1) : -1;
        updatedFields.splice(insertAfterIdx + 1, 0, wanted as FormDefinition['fields'][number]);
        // Rebuild the map since indices shifted.
        existingByKey.clear();
        updatedFields.forEach((f, i) => existingByKey.set(f.key, { field: f, index: i }));
        changed = true;
      }
    }

    if (!changed) return;
    const newDef: FormDefinition = { ...curDef, fields: updatedFields };
    await this.forms.publishDefinition(tx, actor, formRow, newDef, 'System update: add category filter fields', undefined, undefined);
  }
}
