/**
 * Workflow engine rules (contract §Workflow): routing, actor resolution, decision arithmetic, quorum 'all', unhold,
 * send back (stage / draft + resubmit on a newer version), forward, completion, effects, idempotency, If-Match,
 * concurrency. Each test uses its own document type so definitions don't interfere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRole } from './permissions-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { api, mustOk } from './forms-helpers';
import {
  act, createDocType, docStatus, DocType, inTenant, instanceOf, lineStatesOf, makeDoc, publishWorkflow, stageStates, submitDoc, summary,
  useFakeDocs, WfTenant, wfTenant, wfUser,
} from './workflow-helpers';
import { WORKFLOW_PORT, WorkflowPort } from '../src/core/ports';

describe('workflow engine', () => {
  let c: Ctx;
  let t: WfTenant;
  let submitter: Awaited<ReturnType<typeof wfUser>>;

  beforeAll(async () => {
    c = await bootApp();
    useFakeDocs(c);
    t = await wfTenant(c);
  });
  afterAll(async () => { await closeApp(c); });

  /** New doc type + published workflow + a submitter with the type's basic keys. */
  async function setup(def: unknown): Promise<DocType> {
    const dt = await createDocType(c, t);
    await publishWorkflow(c, t.token, dt.key, def);
    submitter = await wfUser(c, t, [`doc.${dt.key}:action.view`, `doc.${dt.key}:action.submit`]);
    return dt;
  }
  const keys = (dt: DocType, ...stages: string[]) => [`doc.${dt.key}:action.view`, ...stages.map(s => `doc.${dt.key}:action.stage_${s}`), 'approvals:action.view'];
  const admin = () => api(c, t.token);

  // ------------------------------------------------------------------------------------------- routing

  it('auto-approves when no stage is runnable (no workflow, disabled stage, false condition)', async () => {
    const plain = await createDocType(c, t);
    const d0 = await makeDoc(c, t, plain, { lines: [{ qty: '3' }] });
    await submitDoc(c, t, d0, t.adminId);
    expect(await docStatus(c, d0.id)).toBe('approved');
    expect((await instanceOf(c, d0.id))!.status).toBe('completed');
    const acts = await c.db.selectFrom('app.wf_action').select('action').where('document_id', '=', d0.id).execute();
    expect(acts.map(a => a.action)).toEqual(expect.arrayContaining(['submit', 'auto_approve', 'complete']));

    const dt = await setup({ stages: [{ key: 'a', name: 'A', enabled: false }, { key: 'b', name: 'B', when: 'total_amount > 999999' }] });
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '2', rate: '5' }] });
    await submitDoc(c, t, d, submitter.id);
    const st = await stageStates(c, d.id);
    expect(st.a).toMatchObject({ status: 'disabled', skip_reason: 'stage_disabled' });
    expect(st.b).toMatchObject({ status: 'skipped', skip_reason: 'condition_false' });
    expect(await summary(c, d.lineIds[0]!)).toMatchObject({ approved: 2 });
  });

  it('parallel group: both stages must approve; join releases the minimum cleared qty; a reject removes qty from the sibling', async () => {
    const dt = await setup({ stages: [
      { key: 'qa', name: 'QA', parallelGroup: 'p1' }, { key: 'safety', name: 'Safety', parallelGroup: 'p1' }, { key: 'final', name: 'Final' },
    ] });
    const u = await wfUser(c, t, keys(dt, 'qa', 'safety', 'final'));
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '100' }, { qty: '50' }] });
    await submitDoc(c, t, d, submitter.id);
    const [l1, l2] = d.lineIds as [string, string];
    expect(await lineStatesOf(c, d.id)).toEqual({ [l1]: { qa: { p: 100, h: 0 }, safety: { p: 100, h: 0 } }, [l2]: { qa: { p: 50, h: 0 }, safety: { p: 50, h: 0 } } });
    // QA approves l1 fully; nothing moves until Safety decides
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'qa', decisions: [{ lineId: l1, approve: '100' }] }));
    expect((await lineStatesOf(c, d.id))[l1]).toEqual({ safety: { p: 100, h: 0 } });
    // Safety rejects 30 of l1 and approves 70 → 70 moves to final; QA's cleared qty shrinks with it
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'safety', decisions: [{ lineId: l1, approve: '70', reject: '30', reason: 'Unsafe' }] }));
    expect((await lineStatesOf(c, d.id))[l1]).toEqual({ final: { p: 70, h: 0 } });
    expect(await summary(c, l1)).toMatchObject({ rejected: 30, approved: 0 });
    // l2: Safety rejects 20 first → QA's pending shrinks to 30
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'safety', decisions: [{ lineId: l2, approve: '30', reject: '20', reason: 'x' }] }));
    expect((await lineStatesOf(c, d.id))[l2]).toEqual({ qa: { p: 30, h: 0 } });
    // QA holds 10, approves 20 → 20 joins
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'qa', decisions: [{ lineId: l2, approve: '20', hold: '10', reason: 'later' }] }));
    expect((await lineStatesOf(c, d.id))[l2]).toEqual({ qa: { p: 0, h: 10 }, final: { p: 20, h: 0 } });
    expect(await summary(c, l2)).toMatchObject({ held: 10, rejected: 20 });
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'unhold', stageKey: 'qa', lineIds: [l2] }));
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'qa', decisions: [{ lineId: l2, approve: '10' }] }));
    expect((await lineStatesOf(c, d.id))[l2]).toEqual({ final: { p: 30, h: 0 } });
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'final', outcome: 'approve' }));
    expect(await summary(c, l1)).toMatchObject({ approved: 70, rejected: 30, held: 0 });
    expect(await summary(c, l2)).toMatchObject({ approved: 30, rejected: 20, held: 0 });
    expect(await docStatus(c, d.id)).toBe('partially_approved');
    const st = await stageStates(c, d.id);
    expect([st.qa.status, st.safety.status, st.final.status]).toEqual(['done', 'done', 'done']);
  });

  // ------------------------------------------------------------------------------------------- actors

  it('resolves actors: users list, reporting manager, header user field, permission + scope; self-approval when allowed', async () => {
    const role = await createRole(c, t.token, 'Role R');
    const dt = await createDocType(c, t);
    const k = (s: string) => `doc.${dt.key}:action.stage_${s}`;
    const named = await wfUser(c, t, [`doc.${dt.key}:action.view`]);
    const mgr = await wfUser(c, t, [`doc.${dt.key}:action.view`]);
    const picked = await wfUser(c, t, [`doc.${dt.key}:action.view`]);
    const anyone = await wfUser(c, t, [`doc.${dt.key}:action.view`]);
    const sub = await wfUser(c, t, [`doc.${dt.key}:action.view`, `doc.${dt.key}:action.submit`], { managerId: mgr.id });
    await publishWorkflow(c, t.token, dt.key, { stages: [
      { key: 'named', name: 'Named', actors: [{ type: 'users', userIds: [named.id] }] },
      { key: 'mgr', name: 'Manager', actors: [{ type: 'reporting_manager' }] },
      { key: 'picked', name: 'Picked', actors: [{ type: 'field', field: 'approver' }] },
      { key: 'open', name: 'Open', actors: [] },
      { key: 'selfok', name: 'Self OK', actors: [{ type: 'role', roleId: role.id }], allowSelfApproval: true },
    ] });
    // grant the stage keys to everyone through one role
    const grant = await createRole(c, t.token, 'Stage keys');
    await mustOk(admin().put(`/roles/${grant.id}/permissions/tabs/doc.${dt.key}`, { actions: ['named', 'mgr', 'picked', 'open', 'selfok'].map(k), views: [] }));
    await mustOk(admin().put(`/roles/${grant.id}/scope`, { entries: [{ allNodes: true }] }));
    for (const u of [named, mgr, picked, anyone, sub]) await c.db.insertInto('app.user_role').values({ tenant_id: t.tenantId, user_id: u.id, role_id: grant.id }).execute();
    await c.db.insertInto('app.user_role').values({ tenant_id: t.tenantId, user_id: sub.id, role_id: role.id }).execute();
    await c.app.get((await import('../src/core/entitlements.service')).EntitlementsService).bumpPermissions(t.tenantId);

    const d = await makeDoc(c, t, dt, { createdBy: sub.id, values: { purpose: 'x', approver: picked.id }, lines: [{ qty: '1' }] });
    await submitDoc(c, t, d, sub.id);
    const go = async (who: { token: string }, stage: string, expected = 200) => {
      const r = await act(c, who.token, dt.key, d.id, { action: 'decide', stageKey: stage, outcome: 'approve' });
      expect(r.status, `${stage}: ${JSON.stringify(r.body)}`).toBe(expected);
    };
    await go(anyone, 'named', 403);
    await go(named, 'named');
    await go(picked, 'mgr', 403);
    await go(mgr, 'mgr');
    await go(mgr, 'picked', 403);
    await go(picked, 'picked');
    await go(anyone, 'open');
    await go(sub, 'selfok');
    expect(await docStatus(c, d.id)).toBe('approved');
  });

  it('ifNoActor: skip (logged) or assign tenant admins via wf_assignment', async () => {
    const empty = await createRole(c, t.token, 'Nobody');
    const dt = await setup({ stages: [
      { key: 'ghost', name: 'Ghost', actors: [{ type: 'role', roleId: empty.id }], ifNoActor: 'skip' },
      { key: 'fallback', name: 'Fallback', actors: [{ type: 'role', roleId: empty.id }], ifNoActor: 'assign_admins' },
    ] });
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '4' }] });
    await submitDoc(c, t, d, submitter.id);
    const st = await stageStates(c, d.id);
    expect(st.ghost).toMatchObject({ status: 'skipped', skip_reason: 'no_actor' });
    expect(st.fallback.status).toBe('active');
    const asg = await c.db.selectFrom('app.wf_assignment').select(['user_id', 'reason']).where('instance_id', '=', (await instanceOf(c, d.id))!.id).execute();
    expect(asg).toEqual([{ user_id: t.adminId, reason: 'escalation' }]);
    const r = await mustOk(admin().post(`/docs/${dt.key}/${d.id}/actions`, { action: 'decide', stageKey: 'fallback', outcome: 'approve' }));
    expect(r.statusKey).toBe('approved');
    const kinds = await c.db.selectFrom('app.wf_action').select('action').where('document_id', '=', d.id).execute();
    expect(kinds.map(k => k.action)).toContain('auto_skip');
  });

  // ------------------------------------------------------------------------------------------- decisions

  it('decision arithmetic: sums must match pending exactly (decimal), reasons required, editable line fields', async () => {
    const dt = await setup({ stages: [{ key: 's1', name: 'S1', editableLineFields: ['est_rate'] }, { key: 's2', name: 'S2', requireReasonOn: [] }] });
    const u = await wfUser(c, t, keys(dt, 's1', 's2'));
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '0.3' }, { qty: '10' }] });
    await submitDoc(c, t, d, submitter.id);
    const [l1, l2] = d.lineIds as [string, string];
    // 0.1 + 0.2 = 0.3 exactly
    let r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's1', decisions: [{ lineId: l1, approve: '0.1', reject: '0.2' }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REASON_REQUIRED');
    r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's1', decisions: [{ lineId: l1, approve: '0.1', reject: '0.19' , reason: 'x' }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('QTY_CHANGED');
    r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's1', decisions: [{ lineId: l2, hold: '10' }] });
    expect(r.body.code).toBe('REASON_REQUIRED');
    r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's1', decisions: [{ lineId: l2, approve: '10', values: { remarks: 'no' } }] });
    expect(r.status).toBe(400);
    r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's1', decisions: [{ lineId: l1, approve: '0.1', reject: '0.2', reason: 'Too many' }, { lineId: l2, approve: '7.5', hold: '2.5', reason: 'Wait', values: { est_rate: '99.5' } }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const line2 = await c.db.selectFrom('app.document_line').select('custom').where('id', '=', l2).executeTakeFirstOrThrow();
    expect((line2.custom as Record<string, unknown>).est_rate).toBe('99.5');
    expect(await lineStatesOf(c, d.id)).toEqual({ [l1]: { s2: { p: 0.1, h: 0 } }, [l2]: { s1: { p: 0, h: 2.5 }, s2: { p: 7.5, h: 0 } } });
    expect(await summary(c, l1)).toMatchObject({ rejected: 0.2, approved: 0 });
    // stage s2 needs no reasons
    r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's2', decisions: [{ lineId: l2, approve: '5', reject: '2.5' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // duplicate line, line not pending, document granularity outcome+decisions mix
    r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's2', decisions: [{ lineId: l1, approve: '0.1' }, { lineId: l1, approve: '0.1' }] });
    expect(r.status).toBe(400);
    r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's2', decisions: [{ lineId: l2, approve: '1' }] });
    expect(r.body.code).toBe('QTY_CHANGED');
    r = await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's2', outcome: 'approve', decisions: [{ lineId: l1, approve: '0.1' }] });
    expect(r.status).toBe(400);
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 's2', outcome: 'approve' }));
    expect(await summary(c, l1)).toMatchObject({ approved: 0.1, rejected: 0.2 });
    expect(await summary(c, l2)).toMatchObject({ approved: 5, rejected: 2.5, held: 2.5 });
    // actions not configured at the stage
    const dt2 = await setup({ stages: [{ key: 'only', name: 'Only', actions: ['approve'] }] });
    const u2 = await wfUser(c, t, keys(dt2, 'only'));
    const d2 = await makeDoc(c, t, dt2, { lines: [{ qty: '1' }] });
    await submitDoc(c, t, d2, submitter.id);
    for (const body of [
      { action: 'decide', stageKey: 'only', outcome: 'reject', comment: 'no' },
      { action: 'send_back', stageKey: 'only', toStage: '_draft', reason: 'redo' },
      { action: 'forward', stageKey: 'only', toUserId: t.adminId, reason: 'look' },
    ]) expect((await act(c, u2.token, dt2.key, d2.id, body)).body.code).toBe('ACTION_NOT_ALLOWED');
    expect((await act(c, u2.token, dt2.key, d2.id, { action: 'decide', stageKey: 'nope', outcome: 'approve' })).status).toBe(404);
  });

  it("document granularity applies one outcome to every line; quorum 'all' merges (min approve, any reject)", async () => {
    const dtDoc = await setup({ granularity: 'document', stages: [{ key: 'one', name: 'One' }] });
    const u = await wfUser(c, t, keys(dtDoc, 'one'));
    const d = await makeDoc(c, t, dtDoc, { lines: [{ qty: '1' }, { qty: '2' }] });
    await submitDoc(c, t, d, submitter.id);
    const bad = await act(c, u.token, dtDoc.key, d.id, { action: 'decide', stageKey: 'one', decisions: [{ lineId: d.lineIds[0], approve: '1' }] });
    expect(bad.status).toBe(400);
    const view = await inTenant(c, t, tx => c.app.get<WorkflowPort>(WORKFLOW_PORT).runtimeView(tx, d.id, { userId: u.id, permissions: keys(dtDoc, 'one') }));
    expect(view).toMatchObject({ granularity: 'document', editableLineFields: { one: [] }, requireReasonOn: { one: ['reject', 'hold', 'send_back', 'partial'] } });
    await mustOk(act(c, u.token, dtDoc.key, d.id, { action: 'decide', stageKey: 'one', outcome: 'reject', comment: 'Budget' }));
    expect(await docStatus(c, d.id)).toBe('rejected');

    const board = await createRole(c, t.token, 'Board');
    const dt = await setup({ stages: [{ key: 'board', name: 'Board', quorum: 'all', actors: [{ type: 'role', roleId: board.id }] }] });
    const m1 = await wfUser(c, t, keys(dt, 'board'));
    const m2 = await wfUser(c, t, keys(dt, 'board'));
    for (const m of [m1, m2]) await c.db.insertInto('app.user_role').values({ tenant_id: t.tenantId, user_id: m.id, role_id: board.id }).execute();
    const q = await makeDoc(c, t, dt, { lines: [{ qty: '10' }, { qty: '6' }] });
    await submitDoc(c, t, q, submitter.id);
    const [a, b] = q.lineIds as [string, string];
    // a vote must cover every pending line
    expect((await act(c, m1.token, dt.key, q.id, { action: 'decide', stageKey: 'board', decisions: [{ lineId: a, approve: '10' }] })).status).toBe(200);
    expect(await lineStatesOf(c, q.id)).toEqual({ [a]: { board: { p: 10, h: 0 } }, [b]: { board: { p: 6, h: 0 } } });
    await mustOk(act(c, m1.token, dt.key, q.id, { action: 'decide', stageKey: 'board', decisions: [{ lineId: a, approve: '10' }, { lineId: b, approve: '6' }] }));
    expect(await docStatus(c, q.id)).toBe('waiting_board');
    await mustOk(act(c, m2.token, dt.key, q.id, { action: 'decide', stageKey: 'board', decisions: [{ lineId: a, approve: '8', reject: '2', reason: 'less' }, { lineId: b, approve: '6' }] }));
    expect(await summary(c, a)).toMatchObject({ approved: 8, rejected: 2 });
    expect(await summary(c, b)).toMatchObject({ approved: 6 });
    expect(await docStatus(c, q.id)).toBe('partially_approved');
  });

  // ------------------------------------------------------------------------------------------- send back / forward

  it('send back to an earlier stage moves later qty back; to draft cancels; resubmit runs on the newer version while an old doc finishes on its old version', async () => {
    const def1 = { stages: [{ key: 'one', name: 'One' }, { key: 'two', name: 'Two' }] };
    const dt = await setup(def1);
    const u = await wfUser(c, t, keys(dt, 'one', 'two'));
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '10' }] });
    const old = await makeDoc(c, t, dt, { lines: [{ qty: '1' }] });
    await submitDoc(c, t, d, submitter.id);
    await submitDoc(c, t, old, submitter.id);
    const l = d.lineIds[0]!;
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'one', decisions: [{ lineId: l, approve: '6', hold: '4', reason: 'h' }] }));
    expect(await lineStatesOf(c, d.id)).toEqual({ [l]: { one: { p: 0, h: 4 }, two: { p: 6, h: 0 } } });
    const bad = await act(c, u.token, dt.key, d.id, { action: 'send_back', stageKey: 'one', toStage: 'two', reason: 'nope' });
    expect(bad.body.code).toBe('BAD_SEND_BACK');
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'send_back', stageKey: 'two', toStage: 'one', reason: 'Recheck' }));
    expect(await lineStatesOf(c, d.id)).toEqual({ [l]: { one: { p: 6, h: 4 } } });
    expect((await stageStates(c, d.id)).two.status).toBe('pending');
    // to draft: everything left is cancelled in the ledger, held released, instance cancelled
    const r = await mustOk(act(c, u.token, dt.key, d.id, { action: 'send_back', stageKey: 'one', toStage: '_draft', reason: 'Rework please' }));
    expect(r.statusKey).toBe('draft');
    expect(await summary(c, l)).toMatchObject({ requested: 10, cancelled: 10, held: 0 });
    expect((await instanceOf(c, d.id))!.status).toBe('cancelled');
    // publish v2 with a third stage; resubmit → new instance on v2, old document stays on v1
    await publishWorkflow(c, t.token, dt.key, { stages: [...def1.stages, { key: 'three', name: 'Three' }] });
    await submitDoc(c, t, d, submitter.id);
    const inst = await instanceOf(c, d.id);
    const v = await c.db.selectFrom('app.workflow_version').select('version').where('id', '=', inst!.workflow_version_id).executeTakeFirstOrThrow();
    expect(v.version).toBe(2);
    expect(await summary(c, l)).toMatchObject({ requested: 20, cancelled: 10 });
    const u3 = await wfUser(c, t, keys(dt, 'one', 'two', 'three'));
    for (const s of ['one', 'two', 'three']) await mustOk(act(c, u3.token, dt.key, d.id, { action: 'decide', stageKey: s, outcome: 'approve' }));
    expect(await docStatus(c, d.id)).toBe('approved');
    for (const s of ['one', 'two']) await mustOk(act(c, u.token, dt.key, old.id, { action: 'decide', stageKey: s, outcome: 'approve' }));
    expect(await docStatus(c, old.id)).toBe('approved');
    const oldStages = await stageStates(c, old.id);
    expect(Object.keys(oldStages).sort()).toEqual(['one', 'two']);
  });

  it('forward assigns another user who may then act (and gets an approval_pending notification)', async () => {
    const dt = await setup({ stages: [{ key: 'rev', name: 'Review', actions: ['approve', 'reject', 'forward'], requireReasonOn: ['forward'] }] });
    const u = await wfUser(c, t, keys(dt, 'rev'));
    const helper = await wfUser(c, t, [`doc.${dt.key}:action.view`, 'approvals:action.view']);
    const blind = await wfUser(c, t, [`doc.${dt.key}:action.view`], { scopeNode: t.plantB.id });
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '2' }] });
    await submitDoc(c, t, d, submitter.id);
    expect((await act(c, helper.token, dt.key, d.id, { action: 'decide', stageKey: 'rev', outcome: 'approve' })).status).toBe(403);
    expect((await act(c, u.token, dt.key, d.id, { action: 'forward', stageKey: 'rev', toUserId: blind.id, reason: 'pls' })).body.code).toBe('BAD_FORWARD');
    expect((await act(c, u.token, dt.key, d.id, { action: 'forward', stageKey: 'rev', toUserId: u.id, reason: 'pls' })).body.code).toBe('BAD_FORWARD');
    expect((await act(c, u.token, dt.key, d.id, { action: 'forward', stageKey: 'rev', toUserId: submitter.id, reason: 'pls' })).body.code).toBe('BAD_FORWARD');
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'forward', stageKey: 'rev', toUserId: helper.id, reason: 'Second opinion' }));
    const n = await c.db.selectFrom('app.notification').select(['kind', 'link']).where('user_id', '=', helper.id).execute();
    expect(n).toEqual([{ kind: 'approval_pending', link: `/docs/${dt.key}/${d.id}` }]);
    const inbox = await mustOk(api(c, helper.token).get('/approvals'));
    expect(inbox.data).toEqual([expect.objectContaining({ documentId: d.id, stageKey: 'rev', assignedBecause: 'forward' })]);
    const r = await mustOk(act(c, helper.token, dt.key, d.id, { action: 'decide', stageKey: 'rev', outcome: 'approve' }));
    expect(r.statusKey).toBe('approved');
    const fwd = await c.db.selectFrom('app.wf_action').select(['action', 'actor_id', 'on_behalf_of', 'target_user_id']).where('document_id', '=', d.id).where('action', 'in', ['forward', 'decide']).orderBy('at').execute();
    expect(fwd).toEqual([
      { action: 'forward', actor_id: u.id, on_behalf_of: null, target_user_id: helper.id },
      { action: 'decide', actor_id: helper.id, on_behalf_of: u.id, target_user_id: null },
    ]);
    // submitter got document_decided
    expect((await c.db.selectFrom('app.notification').select('kind').where('user_id', '=', submitter.id).execute()).map(x => x.kind)).toContain('document_decided');
  });

  // ------------------------------------------------------------------------------------------- effects

  it('runs effects in the action transaction: lock/unlock, notify, emit, close_document, route_to', async () => {
    const dt = await setup({
      onSubmit: [{ effect: 'emit', event: 'capex.submitted' }],
      onComplete: [{ effect: 'notify', to: [{ type: 'submitter' }], message: 'All done' }, { effect: 'close_document' }],
      stages: [
        { key: 'qa', name: 'QA', effects: { onEnter: [{ effect: 'unlock_editing' }], onApprove: [{ effect: 'lock_editing' }, { effect: 'emit', event: 'qa.approved' }], onReject: [{ effect: 'route_to', stage: 'dispose' }, { effect: 'notify', to: [{ type: 'stage_actors', stage: 'dispose' }] }] } },
        { key: 'dispose', name: 'Disposition', when: 'false' },
      ],
    });
    const u = await wfUser(c, t, keys(dt, 'qa', 'dispose'));
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '10' }] });
    await submitDoc(c, t, d, submitter.id);
    const doc = () => c.db.selectFrom('app.document').select(['is_locked', 'closed_at']).where('id', '=', d.id).executeTakeFirstOrThrow();
    expect((await doc()).is_locked).toBe(false); // onEnter unlock
    const ev = async () => (await c.db.selectFrom('app.outbox_event').select('event_type').where('aggregate_id', '=', d.id).orderBy('id').execute()).map(e => e.event_type);
    expect(await ev()).toEqual(expect.arrayContaining(['capex.submitted', 'workflow.stage_entered']));
    const l = d.lineIds[0]!;
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'qa', decisions: [{ lineId: l, approve: '7', reject: '3', reason: 'Damaged' }] }));
    expect((await doc()).is_locked).toBe(true);
    expect(await ev()).toEqual(expect.arrayContaining(['qa.approved', 'workflow.decided']));
    // the rejected 3 went to the disposition stage instead of the ledger
    expect(await lineStatesOf(c, d.id)).toEqual({ [l]: { dispose: { p: 3, h: 0 } } });
    expect(await summary(c, l)).toMatchObject({ approved: 7, rejected: 0 });
    expect((await c.db.selectFrom('app.notification').select('kind').where('user_id', '=', u.id).where('kind', '=', 'workflow_notify').execute()).length).toBe(1);
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'dispose', outcome: 'reject', comment: 'Scrap' }));
    expect(await summary(c, l)).toMatchObject({ approved: 7, rejected: 3 });
    expect((await doc()).closed_at).not.toBeNull();
    expect(await ev()).toEqual(expect.arrayContaining(['workflow.completed']));
    expect((await c.db.selectFrom('app.notification').select('title').where('user_id', '=', submitter.id).where('kind', '=', 'workflow_notify').execute())[0]?.title).toBe('All done');
  });

  it('a stage reached only through route_to (condition false) never takes later onward approvals; a normal target still does', async () => {
    const dt = await setup({
      stages: [
        { key: 'qa', name: 'QA', effects: { onReject: [{ effect: 'route_to', stage: 'dispose' }] } },
        { key: 'dispose', name: 'Disposition', when: 'false' },
      ],
    });
    const u = await wfUser(c, t, keys(dt, 'qa', 'dispose'));
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '10' }, { qty: '5' }] });
    await submitDoc(c, t, d, submitter.id);
    const [l1, l2] = d.lineIds as [string, string];
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'qa', decisions: [{ lineId: l1, approve: '7', reject: '3', reason: 'Damaged' }] }));
    expect((await stageStates(c, d.id)).dispose).toMatchObject({ status: 'active', skip_reason: 'route_only' });
    // A later QA approval of the other line leaves the workflow as approved instead of entering disposition.
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'qa', decisions: [{ lineId: l2, approve: '5' }] }));
    expect(await summary(c, l2)).toMatchObject({ approved: 5 });
    expect(await lineStatesOf(c, d.id)).toEqual({ [l1]: { dispose: { p: 3, h: 0 } } });
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'dispose', decisions: [{ lineId: l1, approve: '0', reject: '3', reason: 'Scrap' }] }));
    expect(await summary(c, l1)).toMatchObject({ approved: 7, rejected: 3 });

    // Backward compatibility: a route target that runs normally keeps receiving onward quantity.
    const dt2 = await setup({
      stages: [
        { key: 'qa', name: 'QA', effects: { onReject: [{ effect: 'route_to', stage: 'fin' }] } },
        { key: 'fin', name: 'Finance' },
      ],
    });
    const u2 = await wfUser(c, t, keys(dt2, 'qa', 'fin'));
    const d2 = await makeDoc(c, t, dt2, { lines: [{ qty: '4' }, { qty: '6' }] });
    await submitDoc(c, t, d2, submitter.id);
    const [m1, m2] = d2.lineIds as [string, string];
    await mustOk(act(c, u2.token, dt2.key, d2.id, { action: 'decide', stageKey: 'qa', decisions: [{ lineId: m1, approve: '3', reject: '1', reason: 'x' }] }));
    await mustOk(act(c, u2.token, dt2.key, d2.id, { action: 'decide', stageKey: 'qa', decisions: [{ lineId: m2, approve: '6' }] }));
    expect(await lineStatesOf(c, d2.id)).toEqual({ [m1]: { fin: { p: 4, h: 0 } }, [m2]: { fin: { p: 6, h: 0 } } });
    expect((await stageStates(c, d2.id)).fin!.skip_reason).toBeNull();
  });

  // ------------------------------------------------------------------------------------------- idempotency & concurrency

  it('Idempotency-Key returns the original result without a second action; If-Match detects stale versions', async () => {
    const dt = await setup({ stages: [{ key: 's', name: 'S' }, { key: 's2', name: 'S2' }] });
    const u = await wfUser(c, t, keys(dt, 's', 's2'));
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '5' }] });
    await submitDoc(c, t, d, submitter.id);
    const body = { action: 'decide', stageKey: 's', decisions: [{ lineId: d.lineIds[0], approve: '2', hold: '3', reason: 'r' }] };
    const r1 = await act(c, u.token, dt.key, d.id, body, { 'Idempotency-Key': 'k-1' });
    expect(r1.status).toBe(200);
    const r2 = await act(c, u.token, dt.key, d.id, body, { 'Idempotency-Key': 'k-1' });
    expect(r2.status).toBe(200);
    expect(r2.body.version).toBe(r1.body.version);
    expect((await c.db.selectFrom('app.wf_action').select('id').where('document_id', '=', d.id).where('action', '=', 'decide').execute()).length).toBe(1);
    expect(await summary(c, d.lineIds[0]!)).toMatchObject({ held: 3 });
    const stale = await act(c, u.token, dt.key, d.id, { action: 'unhold', stageKey: 's', lineIds: d.lineIds }, { 'If-Match': String(r1.body.version - 1) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const ok = await act(c, u.token, dt.key, d.id, { action: 'unhold', stageKey: 's', lineIds: d.lineIds }, { 'If-Match': String(r1.body.version) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.version).toBeGreaterThan(r1.body.version);
    // same key on another document → conflict
    const d2 = await makeDoc(c, t, dt, { lines: [{ qty: '1' }] });
    await submitDoc(c, t, d2, submitter.id);
    expect((await act(c, u.token, dt.key, d2.id, { action: 'decide', stageKey: 's', outcome: 'approve' }, { 'Idempotency-Key': 'k-1' })).status).toBe(409);
  });

  it('concurrency: two actors deciding the same pending qty → exactly one succeeds; 20 parallel line decisions all succeed', async () => {
    const dt = await setup({ stages: [{ key: 's', name: 'S' }] });
    const a = await wfUser(c, t, keys(dt, 's'));
    const b = await wfUser(c, t, keys(dt, 's'));
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '9' }] });
    await submitDoc(c, t, d, submitter.id);
    const body = { action: 'decide', stageKey: 's', decisions: [{ lineId: d.lineIds[0], approve: '9' }] };
    const [x, y] = await Promise.all([act(c, a.token, dt.key, d.id, body), act(c, b.token, dt.key, d.id, body)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(await summary(c, d.lineIds[0]!)).toMatchObject({ approved: 9 });

    const many = await makeDoc(c, t, dt, { lines: Array.from({ length: 20 }, (_, i) => ({ qty: String(i + 1) })) });
    await submitDoc(c, t, many, submitter.id);
    const res = await Promise.all(many.lineIds.map((lineId, i) => act(c, (i % 2 ? a : b).token, dt.key, many.id, { action: 'decide', stageKey: 's', decisions: [{ lineId, approve: String(i + 1) }] })));
    expect(res.map(r => r.status)).toEqual(Array(20).fill(200));
    const total = (await Promise.all(many.lineIds.map(id => summary(c, id)))).reduce((s, x) => s + x.approved, 0);
    expect(total).toBe(210);
    expect(await docStatus(c, many.id)).toBe('approved');
  });

  it('WorkflowPort: runtimeView (canAct, actors, overdue), lineStages, statusKeys, linesCancelled, cancel', async () => {
    const dt = await setup({ stages: [{ key: 'x', name: 'X', statusLabel: 'Waiting for X-ray', sla: { hours: 1 } }, { key: 'y', name: 'Y' }] });
    const u = await wfUser(c, t, keys(dt, 'x', 'y'));
    const d = await makeDoc(c, t, dt, { lines: [{ qty: '3' }, { qty: '4' }] });
    await submitDoc(c, t, d, submitter.id);
    const port = c.app.get<WorkflowPort>(WORKFLOW_PORT);
    await inTenant(c, t, async tx => {
      expect(await port.statusKeys(tx, dt.id)).toEqual([{ key: 'waiting_x', label: 'Waiting for X-ray' }, { key: 'waiting_y', label: 'Waiting for Y' }]);
      expect(await port.lineStages(tx, d.id)).toEqual({ [d.lineIds[0]!]: { x: { pending: '3', held: '0' } }, [d.lineIds[1]!]: { x: { pending: '4', held: '0' } } });
      const perms = keys(dt, 'x', 'y');
      const v = await port.runtimeView(tx, d.id, { userId: u.id, permissions: perms });
      expect(v!.stages[0]).toMatchObject({ key: 'x', status: 'active', canAct: true, overdue: false });
      expect(v!.stages[0]!.actors.length).toBeGreaterThan(0);
      expect(v!.stages[1]).toMatchObject({ key: 'y', status: 'pending', canAct: false });
      expect(v!.stageActions.x).toEqual(['approve', 'reject', 'hold', 'send_back']);
      expect(v!.granularity).toBe('line');
      expect(v!.editableLineFields).toEqual({ x: [], y: [] });
      expect(v!.requireReasonOn).toEqual({ x: ['reject', 'hold', 'send_back', 'partial'], y: ['reject', 'hold', 'send_back', 'partial'] });
      const none = await port.runtimeView(tx, d.id, { userId: submitter.id, permissions: [] });
      expect(none!.stages[0]!.canAct).toBe(false);
    });
    // cancel line 1 (documents writes `cancelled`, then calls linesCancelled)
    await inTenant(c, t, async tx => {
      await c.app.get((await import('../src/modules/workflow')).DocsPortRef).get().recordQuantities(tx, d.id, [{ lineId: d.lineIds[0]!, type: 'cancelled', qty: '3' }], null);
      await port.linesCancelled(tx, d.id, [d.lineIds[0]!]);
    });
    expect(await lineStatesOf(c, d.id)).toEqual({ [d.lineIds[1]!]: { x: { p: 4, h: 0 } } });
    await mustOk(act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'x', decisions: [{ lineId: d.lineIds[1], hold: '4', reason: 'r' }] }));
    await inTenant(c, t, async tx => {
      await c.app.get((await import('../src/modules/workflow')).DocsPortRef).get().recordQuantities(tx, d.id, [{ lineId: d.lineIds[1]!, type: 'unheld', qty: '4' }, { lineId: d.lineIds[1]!, type: 'cancelled', qty: '4' }], null);
      await port.cancel(tx, d.id, 'Not needed', t.adminId);
    });
    expect((await instanceOf(c, d.id))!.status).toBe('cancelled');
    expect(await summary(c, d.lineIds[1]!)).toMatchObject({ held: 0, cancelled: 4 });
    expect(await lineStatesOf(c, d.id)).toEqual({});
    await inTenant(c, t, async tx => {
      const v = await port.runtimeView(tx, d.id, { userId: u.id, permissions: [] });
      expect(v!.status).toBe('cancelled');
      expect(await port.lineStages(tx, d.id)).toEqual({});
      await port.cancel(tx, d.id, 'again', null); // no running instance: no-op
      await port.linesCancelled(tx, d.id, [d.lineIds[0]!]);
    });
    expect((await act(c, u.token, dt.key, d.id, { action: 'decide', stageKey: 'x', outcome: 'approve' })).body.code).toBe('WORKFLOW_NOT_RUNNING');
  });
});
