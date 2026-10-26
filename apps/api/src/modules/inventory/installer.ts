import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WorkflowDefinition, type Effect } from '@procure/schema';
import { sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { EFFECT_REGISTRY, type EffectRegistry } from '../../core/ports';
import { DocTypesService } from '../documents';
import { ProcurementInstaller, SystemTypeInstaller, type InstallContext, type SystemTypeSpec } from '../procurement';
import { DefinitionsService } from '../workflow';
import { GRN_FEATURE, STORE_FEATURE } from './common';
import { GRN_SPEC, RTV_SPEC } from './grn/grn.types';
import { ISSUE_REQUEST_SPEC, STORE_ISSUE_SPEC, STORE_RETURN_SPEC } from './issue/issue.types';

/** PO statuses added by receipts (views for the permission registry). */
export const PO_RECEIPT_VIEWS = [
  { key: 'partially_received', label: 'Partially received', sort: 109 },
  { key: 'received', label: 'Received', sort: 110 },
];

/** Effects a spec's default workflow uses (the type is installed only once they are available to the tenant). */
function effectsOf(spec: SystemTypeSpec): string[] {
  const out = new Set<string>();
  const add = (list: unknown) => (Array.isArray(list) ? list : []).forEach(e => out.add((e as Effect).effect));
  const wf = spec.workflow as { stages?: { effects?: { onEnter?: unknown; onApprove?: unknown; onReject?: unknown } }[]; onComplete?: unknown; onSubmit?: unknown };
  for (const s of wf.stages ?? []) { add(s.effects?.onEnter); add(s.effects?.onApprove); add(s.effects?.onReject); }
  add(wf.onComplete);
  add(wf.onSubmit);
  return [...out];
}

/** Effects that move stock (registered by the stock module only when the plan has `store`). */
const STOCK_EFFECTS = new Set(['post_stock', 'block_stock', 'unblock_stock']);
/** Change note of the stock-less default workflows; the installer upgrades such a version (only while still current
 *  and unchanged by the tenant) to the full default once the plan gains `store`. */
export const NO_STOCK_NOTE_SUFFIX = ' (without stock: plan has no store module)';

/**
 * GRN / RTV on a plan with `grn` but without `store`: the same default chain minus every stock effect. Receipt
 * quantities are still tracked on the PO by the GRN hooks (received at submit, rejected_at_receipt when a stage
 * rejects — nothing ever enters stock, so every rejection re-opens the pending receipt); stages that only exist for
 * stock handling (GRN disposition, reached through block_stock + route_to) are dropped. RTV documents (debit notes)
 * are still approvable but move no stock.
 */
export function withoutStock(spec: SystemTypeSpec): SystemTypeSpec {
  type Stage = { key: string; effects?: Record<string, { effect: string; stage?: string }[] | undefined> } & Record<string, unknown>;
  const wf = JSON.parse(JSON.stringify(spec.workflow)) as { stages?: Stage[] } & Record<string, unknown>;
  const stockOnly = new Set<string>();
  for (const st of wf.stages ?? []) {
    for (const list of Object.values(st.effects ?? {})) {
      // a route_to next to a stock effect sends quantity to a stock-handling stage (e.g. quality → disposition)
      if (list?.some(e => STOCK_EFFECTS.has(e.effect))) list.filter(e => e.effect === 'route_to' && e.stage).forEach(e => stockOnly.add(e.stage!));
    }
  }
  const strip = (list?: { effect: string; stage?: string }[]) =>
    (list ?? []).filter(e => !STOCK_EFFECTS.has(e.effect) && !(e.effect === 'route_to' && e.stage && stockOnly.has(e.stage)));
  wf.stages = (wf.stages ?? []).filter(st => !stockOnly.has(st.key)).map(st => {
    if (!st.effects) return st;
    const effects = Object.fromEntries(Object.entries(st.effects).map(([k, v]) => [k, strip(v)]).filter(([, v]) => (v as unknown[]).length));
    const { effects: _drop, ...rest } = st;
    return Object.keys(effects).length ? { ...rest, effects } : rest;
  }) as Stage[];
  return { ...spec, workflow: wf as SystemTypeSpec['workflow'], workflowNote: `${spec.workflowNote}${NO_STOCK_NOTE_SUFFIX}` };
}

/**
 * Install steps (on the shared ProcurementInstaller, so tenant provisioning, the boot job and the seed run them):
 * GRN + RTV (feature `grn`), the PO receipt status views, issue request / store issue / store return (feature
 * `store`). Idempotent; a type whose default workflow needs effects the tenant cannot use yet is skipped (the boot
 * job retries on the next start) — except GRN / RTV on a plan without `store`, which get the stock-less variant
 * (`withoutStock`), upgraded to the full chain when `store` is added later (if the tenant has not changed it).
 */
@Injectable()
export class InventoryInstaller implements OnModuleInit {
  private readonly log = new Logger('InventoryInstaller');

  constructor(
    private readonly installer: ProcurementInstaller,
    private readonly types: SystemTypeInstaller,
    private readonly ent: EntitlementsService,
    @Inject(EFFECT_REGISTRY) private readonly effects: EffectRegistry,
    private readonly docTypes: DocTypesService,
    private readonly defs: DefinitionsService,
  ) {}

  onModuleInit() {
    this.installer.register({ key: 'grn_type', order: 600, run: (tx, ctx) => this.ensureType(tx, ctx, GRN_FEATURE, GRN_SPEC) });
    this.installer.register({ key: 'rtv_type', order: 610, run: (tx, ctx) => this.ensureType(tx, ctx, GRN_FEATURE, RTV_SPEC) });
    this.installer.register({ key: 'po_receipt_views', order: 620, run: (tx, ctx) => this.poViews(tx, ctx) });
    this.installer.register({ key: 'issue_request_type', order: 700, run: (tx, ctx) => this.ensureType(tx, ctx, STORE_FEATURE, ISSUE_REQUEST_SPEC) });
    this.installer.register({ key: 'store_issue_type', order: 710, run: (tx, ctx) => this.ensureType(tx, ctx, STORE_FEATURE, STORE_ISSUE_SPEC) });
    this.installer.register({ key: 'store_return_type', order: 720, run: (tx, ctx) => this.ensureType(tx, ctx, STORE_FEATURE, STORE_RETURN_SPEC) });
  }

  private async features(ctx: InstallContext): Promise<string[]> {
    if (ctx.features.length) return ctx.features;
    return (await this.ent.state(ctx.tenantId))?.features ?? [];
  }

  async ensureType(tx: Tx, ctx: InstallContext, feature: string, spec: SystemTypeSpec): Promise<void> {
    const features = await this.features(ctx);
    if (!features.includes(feature)) return;
    if (feature === GRN_FEATURE) {
      if (!features.includes(STORE_FEATURE)) spec = withoutStock(spec);
      else await this.upgradeFromNoStock(tx, ctx, spec);
    }
    const have = new Set<string>(this.effects.available(features));
    const missing = effectsOf(spec).filter(e => e !== 'route_to' && !have.has(e));
    if (missing.length) {
      this.log.warn(`skipping ${String(spec.create.key)} for tenant ${ctx.tenantId}: effects not available yet (${missing.join(', ')})`);
      return;
    }
    await this.types.ensure(tx, ctx.tenantId, ctx.actorId, spec);
  }

  /**
   * Plan gained `store`: a GRN/RTV whose current workflow is still the untouched stock-less default (version 1, our
   * change note, no pending draft) gets the full default chain published as a new version. Tenant-edited workflows
   * are never replaced (the admin adds the stock effects in the designer).
   */
  private async upgradeFromNoStock(tx: Tx, ctx: InstallContext, spec: SystemTypeSpec): Promise<void> {
    const t = await this.docTypes.find(tx, ctx.tenantId, String(spec.create.key));
    if (!t || t.kind !== 'system') return;
    const cur = await tx.selectFrom('app.workflow_def as d').innerJoin('app.workflow_version as v', 'v.id', 'd.current_version_id')
      .select(['v.version', 'v.change_note', 'd.draft']).where('d.tenant_id', '=', ctx.tenantId).where('d.doc_type_id', '=', t.id).executeTakeFirst();
    if (!cur || cur.version !== 1 || cur.draft || cur.change_note !== withoutStock(spec).workflowNote) return;
    const have = new Set<string>(this.effects.available(await this.features(ctx)));
    if (effectsOf(spec).some(e => e !== 'route_to' && !have.has(e))) return;
    const dt = { id: t.id, key: t.key, name: t.name, header_form_id: t.header_form_id, line_form_id: t.line_form_id };
    const def = await this.defs.ensureDef(tx, ctx.tenantId, dt, ctx.actorId, true);
    await this.defs.publishDefinition(tx, ctx.tenantId, dt, def, WorkflowDefinition.parse(spec.workflow), spec.workflowNote, ctx.actorId);
    this.log.log(`tenant ${ctx.tenantId}: ${t.key} workflow upgraded to the stock chain (store added to the plan)`);
  }

  /** `doc.po:view.partially_received` / `received` (status views of POs once receipts start). */
  async poViews(tx: Tx, ctx: InstallContext): Promise<void> {
    if (!(await this.features(ctx)).includes(GRN_FEATURE)) return;
    const po = await tx.selectFrom('app.doc_type').select(['id', 'kind', 'module_key']).where('tenant_id', '=', ctx.tenantId).where('key', '=', 'po').executeTakeFirst();
    if (!po || po.kind !== 'system') return;
    await tx.insertInto('app.permission_def').values(PO_RECEIPT_VIEWS.map(v => ({
      tenant_id: ctx.tenantId, key: `doc.po:view.${v.key}`, kind: 'view' as const, tab_key: 'doc.po', label: v.label, description: null, group_label: null,
      requires_feature: po.module_key, requires_setting: null, sort_order: v.sort, source: 'form' as const, source_id: po.id,
    }))).onConflict(oc => oc.columns(['tenant_id', 'key']).doNothing()).execute();
    // Roles (and user-level grants) that can see approved POs also see them once receipts start. Idempotent.
    for (const v of PO_RECEIPT_VIEWS) {
      const key = `doc.po:view.${v.key}`;
      await sql`
        insert into app.permission_grant (tenant_id, role_id, user_id, perm_key, effect)
        select g.tenant_id, g.role_id, g.user_id, ${key}, 'allow' from app.permission_grant g
        where g.tenant_id = ${ctx.tenantId} and g.perm_key = 'doc.po:view.approved' and g.effect = 'allow'
          and not exists (select 1 from app.permission_grant x where x.tenant_id = g.tenant_id and x.perm_key = ${key}
            and x.role_id is not distinct from g.role_id and x.user_id is not distinct from g.user_id)`.execute(tx);
    }
  }
}
