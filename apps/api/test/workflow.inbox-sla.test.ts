/**
 * Approvals inbox (rule-based ∪ assignments, scope, actor rules, self-exclusion, filters, pagination, counts,
 * overdue) and the SLA job (reminders, one-time escalation, idempotent when run twice concurrently) with a fake clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, closeApp, Ctx } from './helpers';
import { api, mustOk } from './forms-helpers';
import { createRole } from './permissions-helpers';
import {
  act, createDocType, DocType, instanceOf, makeDoc, publishWorkflow, sla, stageStates, submitDoc, useFakeDocs, WfTenant, wfTenant, wfUser,
} from './workflow-helpers';

const H = 3600_000;

describe('approvals inbox and SLA', () => {
  let c: Ctx;
  let t: WfTenant;
  let dt: DocType;
  let approverRole: string;
  let hodA: Awaited<ReturnType<typeof wfUser>>;
  let hodB: Awaited<ReturnType<typeof wfUser>>;
  let escalation: Awaited<ReturnType<typeof wfUser>>;
  let sub: Awaited<ReturnType<typeof wfUser>>;
  let mgr: Awaited<ReturnType<typeof wfUser>>;

  beforeAll(async () => {
    c = await bootApp();
    useFakeDocs(c);
    t = await wfTenant(c);
    dt = await createDocType(c, t);
    approverRole = (await createRole(c, t.token, 'Approver')).id;
    const k = (s: string) => `doc.${dt.key}:${s}`;
    escalation = await wfUser(c, t, [k('action.view'), 'approvals:action.view']);
    await publishWorkflow(c, t.token, dt.key, { stages: [
      { key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId: approverRole }], sla: { hours: 24, remindEveryHours: 8, escalateTo: { type: 'users', userIds: [escalation.id] } } },
      { key: 'mgr', name: 'Manager', actors: [{ type: 'reporting_manager' }, { type: 'field', field: 'approver' }] },
    ] });
    const keysA = [k('action.view'), k('action.stage_hod'), k('action.stage_mgr'), 'approvals:action.view'];
    hodA = await wfUser(c, t, keysA, { scopeNode: t.plantA.id });
    hodB = await wfUser(c, t, keysA, { scopeNode: t.plantB.id });
    for (const u of [hodA, hodB]) await c.db.insertInto('app.user_role').values({ tenant_id: t.tenantId, user_id: u.id, role_id: approverRole }).execute();
    mgr = await wfUser(c, t, [k('action.view'), k('action.stage_mgr'), 'approvals:action.view'], { scopeNode: null });
    sub = await wfUser(c, t, [k('action.view'), k('action.submit'), k('action.stage_hod'), 'approvals:action.view'], { managerId: mgr.id });
    await c.db.insertInto('app.user_role').values({ tenant_id: t.tenantId, user_id: sub.id, role_id: approverRole }).execute();
    await c.app.get((await import('../src/core/entitlements.service')).EntitlementsService).bumpPermissions(t.tenantId);
  });
  afterAll(async () => { await closeApp(c); });

  const inbox = async (token: string, q = '') => mustOk(api(c, token).get(`/approvals${q}`));

  it('lists documents at stages the caller can act on, by scope and actor rules, never the own submission', async () => {
    const a1 = await makeDoc(c, t, dt, { createdBy: sub.id, locationId: t.plantA.id, lines: [{ qty: '1' }, { qty: '2' }] });
    const a2 = await makeDoc(c, t, dt, { createdBy: sub.id, locationId: t.storeA.id, lines: [{ qty: '1' }] });
    const b1 = await makeDoc(c, t, dt, { createdBy: sub.id, locationId: t.plantB.id, lines: [{ qty: '1' }] });
    for (const d of [a1, a2, b1]) await submitDoc(c, t, d, sub.id);
    const ia = await inbox(hodA.token);
    expect(ia.data.map((i: { documentId: string }) => i.documentId).sort()).toEqual([a1.id, a2.id].sort());
    expect(ia.data.find((i: { documentId: string }) => i.documentId === a1.id)).toMatchObject({
      docTypeKey: dt.key, stageKey: 'hod', stageName: 'HOD approval', statusLabel: 'Waiting for HOD approval', location: 'Plant A',
      pendingLines: 2, heldLines: 0, overdue: false, assignedBecause: 'rule', submittedBy: expect.any(String),
    });
    expect((await inbox(hodB.token)).data.map((i: { documentId: string }) => i.documentId)).toEqual([b1.id]);
    expect((await inbox(sub.token)).data).toEqual([]); // own submissions excluded
    expect((await inbox(mgr.token)).data).toEqual([]); // not at the mgr stage yet

    // reporting manager rule + header field rule at the mgr stage
    await mustOk(act(c, hodA.token, dt.key, a1.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    const picked = await wfUser(c, t, [`doc.${dt.key}:action.view`, `doc.${dt.key}:action.stage_mgr`, 'approvals:action.view'], { scopeNode: null });
    const f = await makeDoc(c, t, dt, { createdBy: hodB.id, locationId: t.plantB.id, values: { approver: picked.id }, lines: [{ qty: '1' }] });
    await submitDoc(c, t, f, hodB.id);
    const hodAll = await wfUser(c, t, [`doc.${dt.key}:action.view`, `doc.${dt.key}:action.stage_hod`], { scopeNode: null });
    await c.db.insertInto('app.user_role').values({ tenant_id: t.tenantId, user_id: hodAll.id, role_id: approverRole }).execute();
    await mustOk(act(c, hodAll.token, dt.key, f.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    expect((await inbox(mgr.token)).data.map((i: { documentId: string }) => i.documentId)).toEqual([a1.id]);
    expect((await inbox(picked.token)).data.map((i: { documentId: string }) => i.documentId)).toEqual([f.id]);
    // hodA still has stage_mgr but is neither the manager nor the picked user
    expect((await inbox(hodA.token, '?stage=mgr')).data).toEqual([]);

    // filters, pagination, counts
    const a3 = await makeDoc(c, t, dt, { createdBy: sub.id, locationId: t.storeA.id, lines: [{ qty: '3' }] });
    await submitDoc(c, t, a3, sub.id);
    const p1 = await inbox(hodA.token, `?docType=${dt.key}&stage=hod&limit=1`);
    expect(p1.data.length).toBe(1);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await inbox(hodA.token, `?docType=${dt.key}&stage=hod&limit=1&cursor=${encodeURIComponent(p1.nextCursor)}`);
    expect(p2.data.length).toBe(1);
    expect(p2.data[0].documentId).not.toBe(p1.data[0].documentId);
    expect((await inbox(hodA.token, '?docType=other_type')).data).toEqual([]);
    const counts = await mustOk(api(c, hodA.token).get('/approvals/counts'));
    expect(counts).toMatchObject({ total: 2, overdue: 0, byType: [{ docTypeKey: dt.key, stageKey: 'hod', stageName: 'HOD approval', count: 2, overdue: 0 }] });
    expect((await api(c, escalation.token).get('/approvals/counts')).body.total).toBe(0);
    const noKey = await wfUser(c, t, [`doc.${dt.key}:action.view`]);
    expect((await api(c, noKey.token).get('/approvals')).status).toBe(403);
    expect((await api(c, hodA.token).get('/approvals?cursor=garbage')).status).toBe(400);
  });

  it('SLA: reminders every N hours, one escalation at due time (assignment + inbox), idempotent under concurrent runs', async () => {
    const d = await makeDoc(c, t, dt, { createdBy: sub.id, locationId: t.plantB.id, lines: [{ qty: '1' }] });
    await submitDoc(c, t, d, sub.id);
    const entered = new Date((await stageStates(c, d.id)).hod.entered_at as Date).getTime();
    expect(new Date((await stageStates(c, d.id)).hod.due_at as Date).getTime()).toBe(entered + 24 * H);
    const actions = async (kind: string) => (await c.db.selectFrom('app.wf_action').select('id').where('document_id', '=', d.id).where('action', '=', kind).execute()).length;
    const notes = async (userId: string, kind: string) => (await c.db.selectFrom('app.notification').select('id').where('user_id', '=', userId).where('kind', '=', kind).where('link', 'like', `%${d.id}`).execute()).length;

    expect(await sla(c).runTenant(t.tenantId, new Date(entered + 7 * H))).toBe(0);
    await sla(c).runTenant(t.tenantId, new Date(entered + 9 * H));
    expect(await actions('remind')).toBe(1);
    expect(await notes(hodB.id, 'approval_reminder')).toBe(1);
    let st = (await stageStates(c, d.id)).hod;
    expect(st.reminders_sent).toBe(1);
    expect(new Date(st.next_reminder_at as Date).getTime()).toBe(entered + 16 * H);
    await sla(c).runTenant(t.tenantId, new Date(entered + 9 * H)); // same instant again: nothing due
    expect(await actions('remind')).toBe(1);

    // overdue in the inbox before escalation
    const before = await inbox(hodB.token, '?overdue=true');
    expect(before.data).toEqual([]);
    await c.db.updateTable('app.wf_stage_state').set({ due_at: new Date(Date.now() - H) }).where('instance_id', '=', (await instanceOf(c, d.id))!.id).execute();
    const od = await inbox(hodB.token, '?overdue=true');
    expect(od.data.map((i: { documentId: string; overdue: boolean }) => [i.documentId, i.overdue])).toEqual([[d.id, true]]);
    expect((await mustOk(api(c, hodB.token).get('/approvals/counts'))).overdue).toBeGreaterThanOrEqual(1);
    await c.db.updateTable('app.wf_stage_state').set({ due_at: new Date(entered + 24 * H) }).where('instance_id', '=', (await instanceOf(c, d.id))!.id).execute();

    // two concurrent runs at +25h → exactly one escalation and one reminder
    const at = new Date(entered + 25 * H);
    await Promise.all([sla(c).runTenant(t.tenantId, at), sla(c).runTenant(t.tenantId, at), sla(c).run(at)]);
    expect(await actions('escalate')).toBe(1);
    expect(await actions('remind')).toBe(2);
    st = (await stageStates(c, d.id)).hod;
    expect(st.escalated_at).not.toBeNull();
    expect(new Date(st.next_reminder_at as Date).getTime()).toBe(entered + 32 * H);
    expect(await notes(escalation.id, 'approval_escalated')).toBe(1);
    const asg = await c.db.selectFrom('app.wf_assignment').select(['user_id', 'reason']).where('instance_id', '=', (await instanceOf(c, d.id))!.id).execute();
    expect(asg).toEqual([{ user_id: escalation.id, reason: 'escalation' }]);
    const ei = await inbox(escalation.token);
    expect(ei.data).toEqual(expect.arrayContaining([expect.objectContaining({ documentId: d.id, assignedBecause: 'escalation' })]));
    expect(ei.data.every((i: { assignedBecause: string }) => i.assignedBecause === 'escalation')).toBe(true);
    const ev = await c.db.selectFrom('app.outbox_event').select('event_type').where('aggregate_id', '=', d.id).execute();
    expect(ev.map(e => e.event_type)).toEqual(expect.arrayContaining(['workflow.sla_reminder', 'workflow.sla_escalated']));
    // much later: escalation never repeats
    await sla(c).runTenant(t.tenantId, new Date(entered + 100 * H));
    expect(await actions('escalate')).toBe(1);
    // the escalation assignee may act
    const r = await mustOk(act(c, escalation.token, dt.key, d.id, { action: 'decide', stageKey: 'hod', outcome: 'reject', comment: 'Too late' }));
    expect(r.statusKey).toBe('rejected');
    expect((await stageStates(c, d.id)).hod.status).toBe('done');
    const reminders = await actions('remind');
    await sla(c).runTenant(t.tenantId, new Date(entered + 200 * H));
    expect(await actions('remind')).toBe(reminders); // stage done: no more reminders
  });
});
