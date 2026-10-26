/**
 * GRN on a plan with `grn` but without `store`: GRN / RTV install with the stock-less default chain, receipts are
 * still tracked on the PO, and the chain is upgraded to the stock chain when `store` is added (if untouched).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { EntitlementsService } from '../src/core/entitlements.service';
import { GRN_SPEC, InventoryInstaller, NO_STOCK_NOTE_SUFFIX, RTV_SPEC, withoutStock } from '../src/modules/inventory';
import { bootApp, closeApp, Ctx } from './helpers';
import { approvedPo, decideGrn, docStatus, GRN_FEATURES, grnTenant, GrnFixture, lineQty, submittedGrn } from './grn-helpers';

const NO_STORE = GRN_FEATURES.filter(f => f !== 'store');

describe('GRN without the store module', () => {
  let c: Ctx;
  let f: GrnFixture;
  const workflow = async (key: string) => {
    const r = await c.db.selectFrom('app.doc_type as t').innerJoin('app.workflow_def as d', 'd.doc_type_id', 't.id').innerJoin('app.workflow_version as v', 'v.id', 'd.current_version_id')
      .select(['t.kind', 'v.version', 'v.change_note', 'v.definition']).where('t.tenant_id', '=', f.tenantId).where('t.key', '=', key).executeTakeFirstOrThrow();
    const def = r.definition as { stages: { key: string; effects?: Record<string, { effect: string }[]> }[] };
    return { ...r, stages: def.stages.map(s => s.key), effects: def.stages.flatMap(s => Object.values(s.effects ?? {}).flat().map(e => e.effect)) };
  };

  beforeAll(async () => {
    c = await bootApp();
    f = await grnTenant(c, NO_STORE);
  });
  afterAll(async () => closeApp(c));

  it('withoutStock drops stock effects and the stock-only disposition stage', () => {
    const g = withoutStock(GRN_SPEC).workflow as { stages: { key: string; effects?: unknown }[] };
    expect(g.stages.map(s => s.key)).toEqual(['gate', 'store', 'quality']);
    expect(JSON.stringify(g)).not.toMatch(/post_stock|block_stock|route_to|return_to_vendor/);
    expect(JSON.stringify(withoutStock(RTV_SPEC).workflow)).not.toMatch(/post_stock/);
    expect(JSON.stringify(GRN_SPEC.workflow)).toMatch(/post_stock/); // the spec itself is untouched
  });

  it('installs GRN and RTV as system types with the stock-less chain', async () => {
    const grn = await workflow('grn');
    expect(grn).toMatchObject({ kind: 'system', version: 1, change_note: `${GRN_SPEC.workflowNote}${NO_STOCK_NOTE_SUFFIX}` });
    expect(grn.stages).toEqual(['gate', 'store', 'quality']);
    expect(grn.effects).toEqual([]);
    const rtv = await workflow('rtv');
    expect(rtv.kind).toBe('system');
    expect(rtv.effects).toEqual([]);
    expect(await c.db.selectFrom('app.stock_movement').select('id').where('tenant_id', '=', f.tenantId).execute()).toEqual([]);
  });

  it('tracks receipts on the PO: received at submit, rejections re-open the pending receipt, PO becomes received', async () => {
    const po = await approvedPo(c, f, ['10']);
    const poLine = po.lines[0]!.id;
    const grn = await submittedGrn(c, f, po, [[0, '10']]);
    expect((await lineQty(c, poLine)).received).toBe(10);
    const gl = grn.lines[0]!.id;
    await decideGrn(c, f.token, grn.id, 'gate', [[gl, '8', '2']]);
    expect(await lineQty(c, poLine)).toMatchObject({ received: 10, rejectedAtReceipt: 2 });
    expect(await docStatus(c, po.id)).toBe('partially_received');
    await decideGrn(c, f.token, grn.id, 'store', [[gl, '8']]);
    expect(await c.db.selectFrom('app.stock_movement').select('id').where('tenant_id', '=', f.tenantId).execute()).toEqual([]);
    const grn2 = await submittedGrn(c, f, po, [[0, '2']]);
    expect((await lineQty(c, poLine)).received).toBe(12);
    expect(grn2.statusKey).not.toBe('draft');
    expect(await docStatus(c, po.id)).toBe('received');
  });

  it('upgrades the untouched stock-less chain when the plan gains store (idempotent)', async () => {
    const inst = c.app.get(InventoryInstaller);
    // Super Admin turns `store` on for the tenant (feature override), then the installer runs (boot job / provisioning).
    await c.db.insertInto('platform.tenant_override').values({ tenant_id: f.tenantId, kind: 'feature', key: 'store', value: JSON.stringify(true) } as never).execute();
    await c.app.get(EntitlementsService).invalidate(f.tenantId);
    const ctx = { tenantId: f.tenantId, actorId: null, features: [...NO_STORE, 'store'] };
    await c.app.get(DbService).tenantTx(f.tenantId, tx => inst.ensureType(tx, ctx, 'grn', GRN_SPEC));
    await c.app.get(DbService).tenantTx(f.tenantId, tx => inst.ensureType(tx, ctx, 'grn', GRN_SPEC));
    const grn = await workflow('grn');
    expect(grn).toMatchObject({ version: 2, change_note: GRN_SPEC.workflowNote });
    expect(grn.stages).toEqual(['gate', 'store', 'quality', 'disposition']);
    expect(grn.effects).toContain('post_stock');
  });
});
