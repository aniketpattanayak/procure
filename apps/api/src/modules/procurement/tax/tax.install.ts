import { Injectable } from '@nestjs/common';
import { FormDefinition, MasterCreate } from '@procure/schema';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { FormsService, MastersService, RecordsService } from '../../forms';
import type { InstallContext } from '../installer/install-steps';

export const TAX_MASTER = 'tax_code';

/** Seeded GST slabs (tenant-editable records of the system master `tax_code`). */
export const GST_CODES = [
  { code: 'GST0', name: 'GST 0% (exempt / nil rated)', rate: '0' },
  { code: 'GST5', name: 'GST 5%', rate: '5' },
  { code: 'GST12', name: 'GST 12%', rate: '12' },
  { code: 'GST18', name: 'GST 18%', rate: '18' },
  { code: 'GST28', name: 'GST 28%', rate: '28' },
];

const TAX_MASTER_DEF = {
  fields: [
    { key: 'rate_pct', type: 'decimal', label: 'GST rate %', required: true, min: 0, max: 100, precision: 4, width: 4, system: true },
    { key: 'cess_pct', type: 'decimal', label: 'Cess %', min: 0, max: 100, precision: 4, default: 0, width: 4, system: true },
  ],
};

/**
 * Install step 150 (agent B): system master `tax_code` (+ GST0/5/12/18/28), item system field `tax_code`, and the
 * location form's `state_code` custom field when the tenant has a location form. Idempotent; never overwrites edits.
 */
@Injectable()
export class TaxInstallStep {
  constructor(private readonly masters: MastersService, private readonly records: RecordsService, private readonly forms: FormsService) {}

  async run(tx: Tx, ctx: InstallContext): Promise<void> {
    const actor = { tenantId: ctx.tenantId, userId: ctx.actorId, perms: null };
    let master = await this.masters.find(tx, ctx.tenantId, TAX_MASTER);
    if (!master) {
      await this.masters.create(tx, actor, MasterCreate.parse({
        key: TAX_MASTER, name: 'Tax Code', pluralName: 'Tax Codes', description: 'GST rates applied on purchase order lines',
        settings: { defaultSort: 'code', listColumns: ['rate_pct', 'cess_pct'] }, definition: TAX_MASTER_DEF,
      }), { isSystem: true });
      master = (await this.masters.find(tx, ctx.tenantId, TAX_MASTER))!;
      for (const g of GST_CODES) {
        await this.records.save(tx, actor, master, { code: g.code, name: g.name, data: { rate_pct: g.rate, cess_pct: '0' } }, null);
      }
    }
    await this.addField(tx, actor, 'item', { key: 'tax_code', type: 'lookup', label: 'Tax code (GST)', source: { kind: 'master', masterKey: TAX_MASTER }, display: ['code', 'name'], width: 4, system: true }, 'item');
    await this.addField(tx, actor, 'location', { key: 'state_code', type: 'text', label: 'GST state code', help: 'Two-digit GST state code, e.g. 27', minLength: 2, maxLength: 2, width: 4 });
  }

  /** Appends `field` to the form `formKey` (new published version) when the form exists and lacks that key. */
  private async addField(tx: Tx, actor: { tenantId: string; userId: string | null; perms: null }, formKey: string, field: Record<string, unknown>, selfMasterKey?: string) {
    const form = await tx.selectFrom('app.form_def').select('id').where('tenant_id', '=', actor.tenantId).where('key', '=', formKey).executeTakeFirst();
    if (!form) return;
    const row = await this.forms.loadById(tx, actor.tenantId, form.id);
    if (!row.current_version_id) return;
    const cur = await this.forms.version(tx, actor.tenantId, row.current_version_id);
    const def = cur.definition as FormDefinition;
    if (def.fields.some(f => f.key === field.key)) return;
    const next = FormDefinition.parse({ ...def, fields: [...def.fields, field] });
    await this.forms.publishDefinition(tx, actor, row, next, `Procurement: ${String(field.key)}`, selfMasterKey);
  }
}

/** Nearest location (self or ancestor) with a custom `state_code`. */
export async function shipToState(tx: Tx, tenantId: string, locationId: string): Promise<string | null> {
  const r = await sql<{ state: string | null }>`
    select a.custom->>'state_code' as state from app.location_node n
    join app.location_node a on a.tenant_id = n.tenant_id and a.path @> n.path
    where n.tenant_id = ${tenantId} and n.id = ${locationId} and coalesce(a.custom->>'state_code', '') <> ''
    order by nlevel(a.path) desc limit 1`.execute(tx);
  return r.rows[0]?.state ?? null;
}
