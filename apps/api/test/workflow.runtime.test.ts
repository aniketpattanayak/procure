/**
 * Workflow runtime (Phase 3): the brief's 5-line scenario, amount routing, permission denials, quorum, unhold,
 * send back, forward, effects, idempotency and concurrency — through the HTTP action endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRole } from './permissions-helpers';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { api, mustOk } from './forms-helpers';
import {
  act, createDocType, docStatus, DocType, instanceOf, lineStatesOf, makeDoc, publishWorkflow, stageStates, submitDoc, summary, useFakeDocs,
  WfTenant, wfTenant, wfUser,
} from './workflow-helpers';

describe('workflow runtime', () => {
  let c: Ctx;
  let t: WfTenant;
  let dt: DocType;
  let approverRole: string;
  let buyerRole: string;
  let hod: Awaited<ReturnType<typeof wfUser>>;
  let finance: Awaited<ReturnType<typeof wfUser>>;
  let indenter: Awaited<ReturnType<typeof wfUser>>;
  const capex = () => ({
    granularity: 'line',
    stages: [
      { key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId: approverRole }], sla: { hours: 24, remindEveryHours: 8, escalateTo: { type: 'users', userIds: [t.adminId] } } },
      { key: 'finance', name: 'Finance review', when: 'total_amount > 100000', actors: [{ type: 'role', roleId: buyerRole }], actions: ['approve', 'reject', 'send_back'] },
      { key: 'director', name: 'Director approval', when: 'total_amount >= 500000', actors: [{ type: 'users', userIds: [t.adminId] }] },
    ],
  });

  beforeAll(async () => {
    c = await bootApp();
    useFakeDocs(c);
    t = await wfTenant(c);
    dt = await createDocType(c, t);
    approverRole = (await createRole(c, t.token, 'Approver')).id;
    buyerRole = (await createRole(c, t.token, 'Buyer')).id;
    await publishWorkflow(c, t.token, dt.key, capex());
    const k = (s: string) => `doc.${dt.key}:${s}`;
    hod = await wfUser(c, t, [k('action.view'), k('action.stage_hod'), k('view.waiting_hod'), 'approvals:action.view'], { roleId: approverRole });
    await c.http.put(`/api/v1/roles/${approverRole}/scope`).set({ Authorization: `Bearer ${t.token}` }).send({ entries: [{ nodeId: t.plantA.id }] });
    finance = await wfUser(c, t, [k('action.view'), k('action.stage_finance'), 'approvals:action.view'], { roleId: buyerRole });
    await c.http.put(`/api/v1/roles/${buyerRole}/scope`).set({ Authorization: `Bearer ${t.token}` }).send({ entries: [{ allNodes: true }] });
    indenter = await wfUser(c, t, [k('action.view'), k('action.add'), k('action.submit')]);
  });
  afterAll(async () => { await closeApp(c); });

  it('runs the brief scenario on a 5-line document with correct buckets and statuses at every step', async () => {
    const doc = await makeDoc(c, t, dt, { createdBy: indenter.id, lines: [{ qty: '100', rate: '100' }, { qty: '100', rate: '100' }, { qty: '100', rate: '100' }, { qty: '100', rate: '100' }, { qty: '300', rate: '100' }] });
    await submitDoc(c, t, doc, indenter.id);
    expect(await docStatus(c, doc.id)).toBe('waiting_hod');
    const st = await stageStates(c, doc.id);
    expect(st.hod.status).toBe('active');
    expect(st.finance.status).toBe('skipped');
    expect(st.finance.skip_reason).toBe('condition_false');
    expect(st.director.status).toBe('skipped');
    const [l1, l2, l3, l4, l5] = doc.lineIds as [string, string, string, string, string];

    const res = await act(c, hod.token, dt.key, doc.id, {
      action: 'decide', stageKey: 'hod', decisions: [
        { lineId: l1, approve: '100' }, { lineId: l2, approve: '100' }, { lineId: l3, hold: '100', reason: 'Check stock' },
        { lineId: l4, reject: '100', reason: 'Not needed' }, { lineId: l5, approve: '200', reject: '100', reason: 'Reduce' },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.statusKey).toBe('on_hold');
    expect(await summary(c, l1)).toMatchObject({ requested: 100, approved: 100, held: 0, rejected: 0 });
    expect(await summary(c, l3)).toMatchObject({ requested: 100, approved: 0, held: 100 });
    expect(await summary(c, l4)).toMatchObject({ approved: 0, rejected: 100 });
    expect(await summary(c, l5)).toMatchObject({ requested: 300, approved: 200, rejected: 100 });
    const lines = Object.fromEntries((res.body.lines as { id: string; statusKey: string; qty: { pendingApproval: string } }[]).map(l => [l.id, l]));
    expect(lines[l1]!.statusKey).toBe('approved');
    expect(lines[l3]!.statusKey).toBe('on_hold');
    expect(lines[l3]!.qty.pendingApproval).toBe('100');
    expect(lines[l4]!.statusKey).toBe('rejected');
    expect(lines[l5]!.statusKey).toBe('partially_approved');
    expect(res.body.workflow.stages[0]).toMatchObject({ key: 'hod', status: 'active', canAct: true });

    const un = await act(c, hod.token, dt.key, doc.id, { action: 'unhold', stageKey: 'hod', lineIds: [l3] });
    expect(un.status, JSON.stringify(un.body)).toBe(200);
    expect(un.body.statusKey).toBe('waiting_hod');
    expect(await summary(c, l3)).toMatchObject({ held: 0, approved: 0 });

    const fin = await act(c, hod.token, dt.key, doc.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l3, approve: '100' }] });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body.statusKey).toBe('partially_approved');
    expect(await summary(c, l3)).toMatchObject({ approved: 100, held: 0 });
    expect((await instanceOf(c, doc.id))!.status).toBe('completed');
    // item-wise buckets equal the ledger
    const ev = await c.db.selectFrom('app.line_event').select(['line_id', 'event_type', 'qty']).where('document_id', '=', doc.id).execute();
    for (const id of doc.lineIds) {
      const s = await summary(c, id);
      const sum = (ty: string) => ev.filter(e => e.line_id === id && e.event_type === ty).reduce((a, e) => a + Number(e.qty), 0);
      expect(s.approved).toBe(sum('approved'));
      expect(s.rejected).toBe(sum('rejected'));
      expect(s.held).toBe(sum('held') - sum('unheld'));
    }
    const actions = await c.db.selectFrom('app.wf_action').select(['action', 'decisions']).where('document_id', '=', doc.id).orderBy('at').execute();
    expect(actions.map(a => a.action)).toEqual(['submit', 'decide', 'unhold', 'decide', 'complete']);
  });

  it('routes by amount: ≤ 1 lakh skips Finance; ≥ 5 lakh adds Director', async () => {
    const mid = await makeDoc(c, t, dt, { createdBy: indenter.id, lines: [{ qty: '10', rate: '15000' }] });
    await submitDoc(c, t, mid, indenter.id);
    let st = await stageStates(c, mid.id);
    expect([st.hod.status, st.finance.status, st.director.status]).toEqual(['active', 'pending', 'skipped']);
    await mustOk(act(c, hod.token, dt.key, mid.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    expect(await docStatus(c, mid.id)).toBe('waiting_finance');
    expect(await lineStatesOf(c, mid.id)).toEqual({ [mid.lineIds[0]!]: { finance: { p: 10, h: 0 } } });
    await mustOk(act(c, finance.token, dt.key, mid.id, { action: 'decide', stageKey: 'finance', outcome: 'approve' }));
    expect(await docStatus(c, mid.id)).toBe('approved');

    const big = await makeDoc(c, t, dt, { createdBy: indenter.id, lines: [{ qty: '10', rate: '60000' }] });
    await submitDoc(c, t, big, indenter.id);
    st = await stageStates(c, big.id);
    expect([st.hod.status, st.finance.status, st.director.status]).toEqual(['active', 'pending', 'pending']);
    await mustOk(act(c, hod.token, dt.key, big.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    await mustOk(act(c, finance.token, dt.key, big.id, { action: 'decide', stageKey: 'finance', outcome: 'approve' }));
    expect(await docStatus(c, big.id)).toBe('waiting_director');
    const admin = api(c, t.token);
    await mustOk(admin.post(`/docs/${dt.key}/${big.id}/actions`, { action: 'decide', stageKey: 'director', outcome: 'approve' }));
    expect(await docStatus(c, big.id)).toBe('approved');
    expect(await summary(c, big.lineIds[0]!)).toMatchObject({ approved: 10 });
  });

  it('denies: no stage key → 403, out of scope → 404, not the actor → 403, submitter self-approval → 403', async () => {
    const doc = await makeDoc(c, t, dt, { createdBy: hod.id, lines: [{ qty: '5', rate: '10' }] });
    await submitDoc(c, t, doc, hod.id);
    const k = (s: string) => `doc.${dt.key}:${s}`;
    const noKey = await wfUser(c, t, [k('action.view')]);
    expect((await act(c, noKey.token, dt.key, doc.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(403);
    // has the stage key but scope = Plant B (document is at Plant A) → 404 before any other check
    const otherScope = await wfUser(c, t, [k('action.view'), k('action.stage_hod')], { scopeNode: t.plantB.id });
    expect((await act(c, otherScope.token, dt.key, doc.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(404);
    // stage key + scope but not in the Approver role
    const notActor = await wfUser(c, t, [k('action.view'), k('action.stage_hod')]);
    const r = await act(c, notActor.token, dt.key, doc.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
    expect(r.status).toBe(403);
    // the HOD submitted it himself
    const self = await act(c, hod.token, dt.key, doc.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
    expect(self.status).toBe(403);
    expect(self.body.title).toMatch(/submitted/);
    // unknown document id / wrong type → 404
    expect((await act(c, hod.token, dt.key, crypto.randomUUID(), { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(404);
    expect(await docStatus(c, doc.id)).toBe('waiting_hod');
    void uid;
  });
});
