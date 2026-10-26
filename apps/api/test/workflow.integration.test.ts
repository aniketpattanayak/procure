/**
 * Workflow × documents integration on the REAL documents module (DOCUMENTS_PORT, /config/doc-types, /docs API):
 * the brief's 5-line scenario with statuses and document- + item-wise buckets checked at every step, amount routing,
 * send back to draft + resubmit, document/line cancel while in approval, and the actions endpoint's DocumentRow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { DocsPortRef, SlaService } from '../src/modules/workflow';
import { ALL_CAPEX_KEYS, capexBody, createCapexType, docsApi, DocsFixture } from './documents-helpers';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { createRole } from './permissions-helpers';
import { act, instanceOf, publishWorkflow, wfTenant, wfUser } from './workflow-helpers';

type Row = { id: string; statusKey: string; lines: { id: string; lineNo: number; statusKey: string; qty: Record<string, string>; stages: Record<string, { pending: string; held: string }> }[]; workflow: { stages: { key: string; status: string; canAct: boolean }[] } | null; allowedActions: string[]; version: number };

describe('workflow on the real documents module', () => {
  let c: Ctx;
  let f: DocsFixture;
  let approverRole: string;
  let buyerRole: string;
  let indenter: Awaited<ReturnType<typeof wfUser>>;
  let hod: Awaited<ReturnType<typeof wfUser>>;
  let finance: Awaited<ReturnType<typeof wfUser>>;
  const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed', 'waiting_hod', 'waiting_finance', 'waiting_director'].map(v => `doc.capex:view.${v}`);

  beforeAll(async () => {
    c = await bootApp();
    c.app.get(DocsPortRef).use(null); // the real DOCUMENTS_PORT
    const t = await wfTenant(c);
    const a = api(c, t.token);
    const uom = await mustOk(a.post('/masters/uom/records', { code: `U${uid(4)}`, name: 'Numbers', data: { decimals: '0' } }), 201);
    const items = [];
    for (const n of ['Laptop', 'Printer', 'Desk', 'Chair', 'Monitor']) items.push((await mustOk(a.post('/masters/item/records', { name: n, data: { uom: uom.id } }), 201)).id);
    f = { tenantId: t.tenantId, code: t.code, token: t.token, adminId: t.adminId, pune: t.plantA.id, puneMain: t.storeA.id, chennai: t.plantB.id, uom: uom.id, items };
    await createCapexType(c, t.token);
    approverRole = (await createRole(c, t.token, 'Approver')).id;
    buyerRole = (await createRole(c, t.token, 'Buyer')).id;
    await publishWorkflow(c, t.token, 'capex', {
      stages: [
        { key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId: approverRole }], sla: { hours: 24, remindEveryHours: 8, escalateTo: { type: 'users', userIds: [t.adminId] } } },
        { key: 'finance', name: 'Finance review', when: 'total_amount > 100000', actors: [{ type: 'role', roleId: buyerRole }], actions: ['approve', 'reject', 'send_back'] },
        { key: 'director', name: 'Director approval', when: 'total_amount >= 500000', actors: [{ type: 'users', userIds: [t.adminId] }] },
      ],
    });
    indenter = await wfUser(c, t, [...ALL_CAPEX_KEYS(), ...VIEWS]);
    hod = await wfUser(c, t, ['doc.capex:action.view', 'doc.capex:action.stage_hod', 'approvals:action.view', ...VIEWS]);
    finance = await wfUser(c, t, ['doc.capex:action.view', 'doc.capex:action.stage_finance', 'approvals:action.view', ...VIEWS], { scopeNode: null });
    await c.db.insertInto('app.user_role').values([
      { tenant_id: t.tenantId, user_id: hod.id, role_id: approverRole }, { tenant_id: t.tenantId, user_id: finance.id, role_id: buyerRole },
    ]).execute();
    await c.app.get(EntitlementsService).bumpPermissions(t.tenantId);
  });
  afterAll(async () => { await closeApp(c); });

  const docs = (token = indenter.token) => docsApi(c, token);
  async function submit(lines: { qty: string; est_rate: string }[]): Promise<Row> {
    const d = await mustOk(docs().create(capexBody(f, { lines: lines.map((l, i) => ({ ...l, item: f.items[i % f.items.length] })) })), 201);
    return mustOk(docs().submit(d.id, d.version), 200);
  }
  const get = async (id: string): Promise<Row> => mustOk(docs(f.token).get(id));
  const itemRows = async (id: string) => (await mustOk(docs(f.token).list('view=item&limit=200'))).data.filter((r: { documentId: string }) => r.documentId === id);

  it('brief scenario: approve 1–2, hold 3, reject 4, approve 200 of 300 on 5 in one action; unhold 3 and approve', async () => {
    const doc = await submit([{ qty: '100', est_rate: '100' }, { qty: '100', est_rate: '100' }, { qty: '100', est_rate: '100' }, { qty: '100', est_rate: '100' }, { qty: '300', est_rate: '100' }]);
    expect(doc.statusKey).toBe('waiting_hod');
    expect(doc.lines.every(l => l.statusKey === 'waiting_hod' && l.stages.hod?.pending === l.qty.requested)).toBe(true);
    const [l1, l2, l3, l4, l5] = doc.lines.map(l => l.id) as [string, string, string, string, string];

    const r = await act(c, hod.token, 'capex', doc.id, { action: 'decide', stageKey: 'hod', decisions: [
      { lineId: l1, approve: '100' }, { lineId: l2, approve: '100' }, { lineId: l3, hold: '100', reason: 'Check budget' },
      { lineId: l4, reject: '100', reason: 'Duplicate' }, { lineId: l5, approve: '200', reject: '100', reason: 'Only 200 needed' },
    ] }, { 'If-Match': String(doc.version), 'Idempotency-Key': `scn-${doc.id}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    let d = await get(doc.id);
    expect(d.statusKey).toBe('on_hold');
    const byId = (row: Row) => Object.fromEntries(row.lines.map(l => [l.id, l]));
    let L = byId(d);
    expect([L[l1]!.statusKey, L[l2]!.statusKey, L[l3]!.statusKey, L[l4]!.statusKey, L[l5]!.statusKey]).toEqual(['approved', 'approved', 'on_hold', 'rejected', 'partially_approved']);
    expect(L[l3]!.qty).toMatchObject({ requested: '100', held: '100', approved: '0', pendingApproval: '100' });
    expect(L[l3]!.stages).toEqual({ hod: { pending: '0', held: '100' } });
    expect(L[l5]!.qty).toMatchObject({ requested: '300', approved: '200', rejected: '100', pendingApproval: '0', pendingOrder: '200' });
    let items = await itemRows(doc.id);
    expect(items.map((i: { lineNo: number; statusKey: string; qty: { approved: string; held: string; rejected: string } }) => [i.lineNo, i.statusKey, i.qty.approved, i.qty.held, i.qty.rejected]).sort())
      .toEqual([[1, 'approved', '100', '0', '0'], [2, 'approved', '100', '0', '0'], [3, 'on_hold', '0', '100', '0'], [4, 'rejected', '0', '0', '100'], [5, 'partially_approved', '200', '0', '100']]);
    // replay with the same Idempotency-Key: original result, no second action
    const replay = await act(c, hod.token, 'capex', doc.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l1, approve: '100' }] }, { 'Idempotency-Key': `scn-${doc.id}` });
    expect(replay.status).toBe(200);
    expect(replay.body.version).toBe(r.body.version);

    await mustOk(act(c, hod.token, 'capex', doc.id, { action: 'unhold', stageKey: 'hod', lineIds: [l3], comment: 'Budget ok' }));
    d = await get(doc.id);
    expect(d.statusKey).toBe('waiting_hod');
    expect(byId(d)[l3]).toMatchObject({ statusKey: 'waiting_hod', stages: { hod: { pending: '100', held: '0' } } });
    expect(byId(d)[l3]!.qty.held).toBe('0');

    const last = await mustOk(act(c, hod.token, 'capex', doc.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l3, approve: '100' }] }));
    expect(last.statusKey).toBe('partially_approved');
    d = await get(doc.id);
    L = byId(d);
    expect(L[l3]!.statusKey).toBe('approved');
    expect(d.workflow!.stages[0]).toMatchObject({ key: 'hod', status: 'done', canAct: false });
    items = await itemRows(doc.id);
    expect(items.reduce((s: number, i: { qty: { approved: string } }) => s + Number(i.qty.approved), 0)).toBe(500);
    expect((await instanceOf(c, doc.id))!.status).toBe('completed');
    const tl = await mustOk(docs(f.token).raw.get(`/docs/capex/${doc.id}/timeline`));
    expect(tl.some((e: { kind: string }) => e.kind === 'workflow')).toBe(true);
  });

  it('amount routing on real totals: ≤ 1 lakh skips Finance; > 1 lakh adds Finance; ≥ 5 lakh adds Director', async () => {
    const small = await submit([{ qty: '10', est_rate: '10000' }]); // 1,00,000 exactly → no finance
    await mustOk(act(c, hod.token, 'capex', small.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    expect((await get(small.id)).statusKey).toBe('approved');
    const mid = await submit([{ qty: '10', est_rate: '15000' }]);
    await mustOk(act(c, hod.token, 'capex', mid.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    expect((await get(mid.id)).statusKey).toBe('waiting_finance');
    expect((await mustOk(api(c, finance.token).get('/approvals'))).data.map((i: { documentId: string }) => i.documentId)).toContain(mid.id);
    await mustOk(act(c, finance.token, 'capex', mid.id, { action: 'decide', stageKey: 'finance', outcome: 'approve' }));
    expect((await get(mid.id)).statusKey).toBe('approved');
    const big = await submit([{ qty: '10', est_rate: '50000' }]);
    await mustOk(act(c, hod.token, 'capex', big.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    await mustOk(act(c, finance.token, 'capex', big.id, { action: 'decide', stageKey: 'finance', outcome: 'approve' }));
    const atDirector = await get(big.id);
    expect(atDirector.statusKey).toBe('waiting_director');
    expect((await act(c, hod.token, 'capex', big.id, { action: 'decide', stageKey: 'director', outcome: 'approve' })).status).toBe(403);
    await mustOk(act(c, f.token, 'capex', big.id, { action: 'decide', stageKey: 'director', outcome: 'approve' }));
    expect((await get(big.id)).statusKey).toBe('approved');
  });

  it('send back to draft → edit → resubmit; cancel lines and the document while in approval', async () => {
    const doc = await submit([{ qty: '5', est_rate: '100' }, { qty: '3', est_rate: '100' }]);
    const back = await mustOk(act(c, hod.token, 'capex', doc.id, { action: 'send_back', stageKey: 'hod', toStage: '_draft', reason: 'Add a quote' }));
    expect(back.statusKey).toBe('draft');
    let d = await get(doc.id);
    expect(d.lines[0]!.qty).toMatchObject({ requested: '5', cancelled: '5' });
    const ed = await mustOk(docs().update(doc.id, { ...capexBody(f, { lines: [{ qty: '4', est_rate: '100', item: f.items[0] }, { qty: '3', est_rate: '100', item: f.items[1] }] }), version: d.version }));
    const re = await mustOk(docs().submit(doc.id, ed.version));
    expect(re.statusKey).toBe('waiting_hod');
    // cancel line 2 while pending at hod → workflow drops it
    d = await get(doc.id);
    const line2 = d.lines.find(l => l.lineNo === 2)!;
    await mustOk(docs().raw.post(`/docs/capex/${doc.id}/cancel`, { reason: 'Not needed', lineIds: [line2.id] }));
    d = await get(doc.id);
    expect(d.lines.find(l => l.lineNo === 2)!.stages).toEqual({});
    // hold line 1, then cancel the whole document → instance cancelled, held released
    const line1 = d.lines.find(l => l.lineNo === 1)!;
    await mustOk(act(c, hod.token, 'capex', doc.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: line1.id, hold: line1.stages.hod!.pending, reason: 'wait' }] }));
    await mustOk(docs().raw.post(`/docs/capex/${doc.id}/cancel`, { reason: 'Project dropped' }));
    d = await get(doc.id);
    expect(d.statusKey).toBe('cancelled');
    expect((await instanceOf(c, doc.id))!.status).toBe('cancelled');
    expect(d.lines.find(l => l.lineNo === 1)!.qty.held).toBe('0');
    expect((await act(c, hod.token, 'capex', doc.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(409);
  });

  // Keep last: republishes the capex workflow.
  it('a stage removed by a newer version keeps its (retired) keys while a v1 document waits there; keys go once it completes', async () => {
    const doc = await submit([{ qty: '10', est_rate: '15000' }]);
    await mustOk(act(c, hod.token, 'capex', doc.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    expect((await get(doc.id)).statusKey).toBe('waiting_finance');
    const defs = () => c.db.selectFrom('app.permission_def').select(['key', 'label']).where('tenant_id', '=', f.tenantId).where('key', 'like', 'doc.capex:%finance').orderBy('key').execute();
    const grants = () => c.db.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', f.tenantId).where('perm_key', 'like', 'doc.capex:%finance').execute();
    const nGrants = (await grants()).length;
    expect(nGrants).toBeGreaterThan(0);

    const admin = api(c, f.token);
    const cur = await mustOk(admin.get('/config/workflows/capex'));
    await publishWorkflow(c, f.token, 'capex', { ...cur.published, stages: cur.published.stages.filter((s: { key: string }) => s.key !== 'finance') });
    expect(await defs()).toEqual([
      { key: 'doc.capex:action.stage_finance', label: 'Act on Finance review (retired)' },
      { key: 'doc.capex:view.waiting_finance', label: 'Waiting for Finance review (retired)' },
    ]);
    expect((await grants()).length).toBe(nGrants);
    // a new document runs on v2 (no finance stage)
    const fresh = await submit([{ qty: '10', est_rate: '15000' }]);
    await mustOk(act(c, hod.token, 'capex', fresh.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    expect((await get(fresh.id)).statusKey).toBe('approved');
    // the daily job keeps keys that are still referenced
    expect((await c.app.get(SlaService).cleanupRetired()).remaining).toBeGreaterThan(0);
    expect((await defs()).length).toBe(2);
    // the Buyer can still act on the v1 document; completing the stage removes the retired keys + grants
    expect((await mustOk(api(c, finance.token).get('/approvals'))).data.map((i: { documentId: string }) => i.documentId)).toContain(doc.id);
    const r = await mustOk(act(c, finance.token, 'capex', doc.id, { action: 'decide', stageKey: 'finance', outcome: 'approve' }));
    expect(r.statusKey).toBe('approved');
    expect(await defs()).toEqual([]);
    expect(await grants()).toEqual([]);
    expect(await c.app.get(SlaService).cleanupRetired()).toMatchObject({ remaining: 0 });
  });
});
