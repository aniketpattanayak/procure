import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QtyLedgerDriftCheck } from '../src/modules/integrity';
import { bootApp, closeApp, Ctx } from './helpers';
import { createCapexType, docsTenant, DocsFixture, submittedCapex } from './documents-helpers';

describe('nightly quantity-ledger drift check', () => {
  let c: Ctx;
  let f: DocsFixture;
  beforeAll(async () => {
    c = await bootApp();
    f = await docsTenant(c);
    await createCapexType(c, f.token);
    await submittedCapex(c, f);
  });
  afterAll(async () => { await closeApp(c); });

  it('finds no drift when line_qty_summary matches Σ line_event', async () => {
    expect(await c.app.get(QtyLedgerDriftCheck).checkTenant(f.tenantId)).toEqual([]);
  });

  it('reports a tampered bucket, emits qty_ledger.drift_detected and notifies tenant admins (never repairs)', async () => {
    const line = await c.db.selectFrom('app.line_qty_summary').select(['line_id', 'requested']).where('tenant_id', '=', f.tenantId).executeTakeFirstOrThrow();
    await c.db.updateTable('app.line_qty_summary').set({ requested: '999' } as never).where('line_id', '=', line.line_id).execute();
    const job = c.app.get(QtyLedgerDriftCheck);
    const res = await job.runAll();
    expect(res.drifted).toBeGreaterThanOrEqual(1);
    const rows = await job.checkTenant(f.tenantId);
    expect(rows).toEqual([expect.objectContaining({ lineId: line.line_id, bucket: 'requested', stored: '999' })]);
    const n = await c.db.selectFrom('app.notification').select(['kind', 'user_id']).where('tenant_id', '=', f.tenantId).where('kind', '=', 'qty_ledger_drift').execute();
    expect(n.map(x => x.user_id)).toContain(f.adminId);
    const ev = await c.db.selectFrom('app.outbox_event').select('event_type').where('tenant_id', '=', f.tenantId).where('event_type', '=', 'qty_ledger.drift_detected').execute();
    expect(ev.length).toBeGreaterThanOrEqual(1);
    const after = await c.db.selectFrom('app.line_qty_summary').select('requested').where('line_id', '=', line.line_id).executeTakeFirstOrThrow();
    expect(Number(after.requested)).toBe(999);
  });
});
