/**
 * Demo seed — Form & master engine part (Phase 2). Idempotent; called from demo.ts after tenants exist.
 *
 * - Upserts the `standard` bundle into platform.global_template (the installer also inserts it on first use).
 * - acme + globex: system forms/masters + the `standard` bundle through TemplateInstaller (same code as provisioning).
 * - acme sample data through the real services (validation, refs, formulas, audit): masters Item Category and
 *   Item Sub-category (lookup → category), Item form fields category / sub_category (filterBy category) /
 *   pack_qty / std_rate / std_pack_value = std_rate * pack_qty, and 5 sample items.
 */
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FormDefinition, MasterCreate } from '@procure/schema';
import { Kysely, sql } from 'kysely';
import { CoreModule } from '../core/core.module';
import type { DB } from '../core/db-types';
import { DbService, Tx } from '../core/db.service';
import { EntitlementsService } from '../core/entitlements.service';
import { FilesModule } from '../modules/files';
import {
  Actor, FormsModule, FormsService, MastersService, RecordsService, STANDARD_BUNDLE, STANDARD_TEMPLATE_ROW, TemplateInstaller,
} from '../modules/forms';

@Module({ imports: [CoreModule, FilesModule, FormsModule] })
class SeedFormsModule {}

const CATEGORIES = [['A', 'Raw Materials'], ['B', 'Packaging'], ['C', 'Consumables']] as const;
const SUBCATEGORIES = [['D', 'Steel', 'A'], ['E', 'Copper', 'A'], ['F', 'Aluminium', 'A'], ['H', 'Cartons', 'B']] as const;
const ITEMS = [
  { code: 'ITM-00001', name: 'MS Plate 6 mm', uom: 'KG', category: 'A', sub: 'D', pack_qty: '100', std_rate: '62.50', hsn: '7208' },
  { code: 'ITM-00002', name: 'Copper Wire 2.5 sq mm', uom: 'MTR', category: 'A', sub: 'E', pack_qty: '90', std_rate: '38.75', hsn: '7408' },
  { code: 'ITM-00003', name: 'Aluminium Sheet 2 mm', uom: 'KG', category: 'A', sub: 'F', pack_qty: '50', std_rate: '245', hsn: '7606' },
  { code: 'ITM-00004', name: 'Corrugated Carton 5-ply', uom: 'NOS', category: 'B', sub: 'H', pack_qty: '25', std_rate: '18.40', hsn: '4819' },
  { code: 'ITM-00005', name: 'Cotton Waste', uom: 'KG', category: 'C', sub: null, pack_qty: '10', std_rate: '55', hsn: '5202' },
];

export async function seedFormsAndMasters(platformDb: Kysely<DB>, tenantCodes: string[]): Promise<void> {
  // ---- global template row (content refreshed on every run)
  await platformDb.insertInto('platform.global_template')
    .values({ ...STANDARD_TEMPLATE_ROW, content: JSON.stringify(STANDARD_BUNDLE) })
    .onConflict(oc => oc.columns(['kind', 'key']).doUpdateSet({ content: JSON.stringify(STANDARD_BUNDLE), name: STANDARD_TEMPLATE_ROW.name, description: STANDARD_TEMPLATE_ROW.description, is_active: true }))
    .execute();

  const app = await NestFactory.createApplicationContext(SeedFormsModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    const installer = app.get(TemplateInstaller);
    const tenants = await platformDb.selectFrom('platform.tenant').select(['id', 'code']).where('code', 'in', tenantCodes).execute();
    for (const t of tenants) {
      await db.tenantTx(t.id, async tx => {
        await installer.installSystem(tx);
        await installer.applyBundle(tx, STANDARD_BUNDLE);
        if (t.code === 'acme') await acmeSampleData(tx, t.id, app.get(FormsService), app.get(MastersService), app.get(RecordsService));
      });
      await app.get(EntitlementsService).bumpPermissions(t.id);
    }
  } finally {
    await app.close();
  }
}

async function acmeSampleData(tx: Tx, tenantId: string, forms: FormsService, masters: MastersService, records: RecordsService) {
  const actor: Actor = { tenantId, userId: null, perms: null };
  const ensureMaster = async (input: unknown) => {
    const parsed = MasterCreate.parse(input);
    return (await masters.find(tx, tenantId, parsed.key)) ?? (await masters.create(tx, actor, parsed), await masters.load(tx, tenantId, parsed.key));
  };
  const ensureRecord = async (masterKey: string, code: string, name: string, data: Record<string, unknown>) => {
    const m = await masters.load(tx, tenantId, masterKey);
    const found = await tx.selectFrom('app.master_record').select('id').where('tenant_id', '=', tenantId).where('master_id', '=', m.id)
      .where('is_deleted', '=', false).where(sql<boolean>`code = ${code}::citext`).executeTakeFirst();
    return found?.id ?? (await records.save(tx, actor, m, { code, name, data }, null)).id;
  };

  await ensureMaster({
    key: 'item_category', name: 'Item Category', pluralName: 'Item Categories', description: 'Top-level grouping of items',
    settings: { defaultSort: 'code' }, definition: { fields: [{ key: 'details', type: 'section', label: 'Details' }] },
  });
  await ensureMaster({
    key: 'item_subcategory', name: 'Item Sub-category', pluralName: 'Item Sub-categories', description: 'Second level, within a category',
    settings: { defaultSort: 'code', listColumns: ['category'] },
    definition: { fields: [{ key: 'category', type: 'lookup', label: 'Category', source: { kind: 'master', masterKey: 'item_category' }, required: true }] },
  });
  const cat: Record<string, string> = {};
  for (const [code, name] of CATEGORIES) cat[code] = await ensureRecord('item_category', code, name, {});
  const sub: Record<string, string> = {};
  for (const [code, name, parent] of SUBCATEGORIES) sub[code] = await ensureRecord('item_subcategory', code, name, { category: cat[parent] });

  // Item form: add the demo fields once (a new published version; system fields untouched).
  const itemForm = await forms.load(tx, tenantId, 'item', true);
  const current = await forms.current(tx, tenantId, itemForm);
  if (!current.definition.fields.some(f => f.key === 'category')) {
    const def = FormDefinition.parse({
      fields: [
        ...current.definition.fields.filter(f => !f.removed),
        { key: 'classification', type: 'section', label: 'Classification' },
        { key: 'category', type: 'lookup', label: 'Category', source: { kind: 'master', masterKey: 'item_category' }, width: 6 },
        {
          key: 'sub_category', type: 'lookup', label: 'Sub-category', source: { kind: 'master', masterKey: 'item_subcategory' }, width: 6,
          filterBy: [{ field: 'category', targetField: 'category' }],
        },
        { key: 'costing', type: 'section', label: 'Standard cost' },
        { key: 'pack_qty', type: 'decimal', label: 'Pack quantity', precision: 3, min: 0, width: 4 },
        { key: 'std_rate', type: 'currency', label: 'Standard rate', min: 0, width: 4 },
        { key: 'std_pack_value', type: 'formula', label: 'Standard pack value', expr: 'std_rate * pack_qty', precision: 2, width: 4 },
      ],
      validations: current.definition.validations,
    });
    await forms.publishDefinition(tx, actor, itemForm, def, 'Demo: classification and standard cost');
  }

  const uoms = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id')
    .select(['r.id', 'r.code']).where('r.tenant_id', '=', tenantId).where('d.key', '=', 'uom').where('r.is_deleted', '=', false).execute();
  const uom = Object.fromEntries(uoms.map(u => [u.code.toUpperCase(), u.id]));
  for (const it of ITEMS) {
    await ensureRecord('item', it.code, it.name, {
      uom: uom[it.uom], hsn_code: it.hsn, category: cat[it.category], ...(it.sub ? { sub_category: sub[it.sub] } : {}),
      pack_qty: it.pack_qty, std_rate: it.std_rate, track_batch: it.category === 'A', track_expiry: false,
    });
  }
}
