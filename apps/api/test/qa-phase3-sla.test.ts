/**
 * QA Phase 3 — SLA through the real queue: a stage with a tiny SLA (0.01 h = 36 s, reminder every 0.005 h = 18 s,
 * escalate to a named user), the API's inline workers, and the `workflow-sla` job triggered through BullMQ (as the
 * repeatable would every minute). Checks: reminder + escalation notifications, timeline sentences, wf_assignment
 * (escalation) → the escalation target can act, inbox `overdue` flag + counts, outbox events, and that a second job run
 * does not escalate twice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { QueueService } from '../src/core/queue.service';
import { DocsPortRef } from '../src/modules/workflow';
import { ALL_CAPEX_KEYS, createCapexType, docsApi, DocsFixture } from './documents-helpers';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, startWorkers, uid } from './helpers';
import { createRole } from './permissions-helpers';
import { act, publishWorkflow, wfTenant, wfUser } from './workflow-helpers';

const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed', 'waiting_hod'].map(v => `doc.capex:view.${v}`);

describe('QA3 SLA via the queue', () => {
  let c: Ctx;
  let f: DocsFixture;

  beforeAll(async () => {
    c = await bootApp();
    c.app.get(DocsPortRef).use(null);
    await startWorkers(c);
  }, 60_000);
  afterAll(async () => { await closeApp(c); });

  it('0.01 h SLA: reminder after 18 s, escalation after 36 s via the workflow-sla job → notifications, timeline, inbox overdue, assignment', async () => {
    const t = await wfTenant(c);
    const a = api(c, t.token);
    const uom = await mustOk(a.post('/masters/uom/records', { code: `U${uid(4)}`, name: 'Numbers', data: { decimals: '0' } }), 201);
    const item = await mustOk(a.post('/masters/item/records', { name: 'Laptop', data: { uom: uom.id } }), 201);
    f = { tenantId: t.tenantId, code: t.code, token: t.token, adminId: t.adminId, pune: t.plantA.id, puneMain: t.storeA.id, chennai: t.plantB.id, uom: uom.id, items: [item.id] };
    await createCapexType(c, t.token);
    const approverRole = (await createRole(c, t.token, 'Approver')).id;
    // escalation target: created before publish (needs its id), stage views granted after publish
    const escalation = await wfUser(c, t, ['doc.capex:action.view', 'approvals:action.view', ...VIEWS.filter(v => !v.endsWith('waiting_hod'))], { scopeNode: null });
    await publishWorkflow(c, t.token, 'capex', { stages: [
      { key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId: approverRole }], sla: { hours: 0.01, remindEveryHours: 0.005, escalateTo: { type: 'users', userIds: [escalation.id] } } },
    ] });
    await mustOk(a.put(`/roles/${escalation.roleId}/permissions/tabs/doc.capex`, { actions: ['doc.capex:action.view'], views: VIEWS }));
    const indenter = await wfUser(c, t, [...ALL_CAPEX_KEYS(), ...VIEWS], { scopeNode: null });
    const hod = await wfUser(c, t, ['doc.capex:action.view', 'doc.capex:action.stage_hod', 'approvals:action.view', ...VIEWS], { roleId: approverRole });
    await mustOk(a.put(`/roles/${approverRole}/scope`, { entries: [{ allNodes: true }] }));
    await c.app.get(EntitlementsService).bumpPermissions(t.tenantId);

    const d = docsApi(c, indenter.token);
    const draft = await mustOk(d.create({ values: { location: f.pune, purpose: 'SLA', doc_date: '2026-10-20' }, lines: [{ values: { item: item.id, qty: '2', est_rate: '10' } }] }), 201);
    const doc = await mustOk(d.submit(draft.id, draft.version));
    const st = await c.db.selectFrom('app.wf_stage_state as s').innerJoin('app.wf_instance as i', 'i.id', 's.instance_id')
      .select(['s.entered_at', 's.due_at', 's.next_reminder_at']).where('i.document_id', '=', doc.id).executeTakeFirstOrThrow();
    expect(st.due_at!.getTime() - st.entered_at!.getTime()).toBe(36_000);
    expect(st.next_reminder_at!.getTime() - st.entered_at!.getTime()).toBe(18_000);
    let inbox = await mustOk(api(c, hod.token).get('/approvals'));
    expect(inbox.data.find((i: { documentId: string }) => i.documentId === doc.id)).toMatchObject({ overdue: false });

    const q = c.app.get(QueueService);
    const runJob = async () => {
      await q.enqueue('workflow', 'workflow-sla', {}, { jobId: `qa-sla-${uid(8)}` });
      const until = Date.now() + 15_000;
      for (;;) {
        const n = await q.queue('workflow').getJobCounts('waiting', 'active');
        if (!(n.waiting ?? 0) && !(n.active ?? 0)) return;
        if (Date.now() > until) throw new Error('workflow queue not drained');
        await new Promise(r => setTimeout(r, 100));
      }
    };
    const kinds = async (userId: string) => (await c.db.selectFrom('app.notification').select(['kind', 'link']).where('user_id', '=', userId).execute());

    await new Promise(r => setTimeout(r, 19_000));
    await runJob();
    expect((await kinds(hod.id)).map(n => n.kind)).toContain('approval_reminder');
    expect((await kinds(escalation.id)).map(n => n.kind)).not.toContain('approval_escalated');

    await new Promise(r => setTimeout(r, 18_000));
    await runJob();
    await runJob(); // a second run must not escalate again
    const esc = (await kinds(escalation.id)).filter(n => n.kind === 'approval_escalated');
    expect(esc.length).toBe(1);
    expect(esc[0]!.link).toBe(`/docs/capex/${doc.id}`);
    expect((await kinds(hod.id)).map(n => n.kind)).toContain('approval_escalated');
    const actions = await c.db.selectFrom('app.wf_action').select('action').where('document_id', '=', doc.id).execute();
    expect(actions.filter(x => x.action === 'escalate').length).toBe(1);
    expect(actions.filter(x => x.action === 'remind').length).toBeGreaterThanOrEqual(2);

    const tl = await mustOk(api(c, t.token).get(`/docs/capex/${doc.id}/timeline`));
    const titles = tl.map((e: { title: string }) => e.title);
    expect(titles).toContain('Escalated at HOD approval');
    expect(titles).toContain('Reminder sent at HOD approval');

    inbox = await mustOk(api(c, hod.token).get('/approvals'));
    expect(inbox.data.find((i: { documentId: string }) => i.documentId === doc.id)).toMatchObject({ overdue: true });
    expect((await mustOk(api(c, hod.token).get('/approvals?overdue=true'))).data.map((i: { documentId: string }) => i.documentId)).toContain(doc.id);
    expect((await mustOk(api(c, hod.token).get('/approvals/counts'))).overdue).toBeGreaterThanOrEqual(1);
    const escInbox = await mustOk(api(c, escalation.token).get('/approvals'));
    expect(escInbox.data.find((i: { documentId: string }) => i.documentId === doc.id)).toMatchObject({ assignedBecause: 'escalation', overdue: true });
    const detail = await mustOk(d.get(doc.id));
    expect(detail.workflow.stages[0]).toMatchObject({ key: 'hod', overdue: true });
    expect((await mustOk(d.list('limit=50'))).data.find((r: { id: string }) => r.id === doc.id)).toMatchObject({ overdue: true });
    const out = await c.db.selectFrom('app.outbox_event').select('event_type').where('tenant_id', '=', t.tenantId).where('event_type', 'like', 'workflow.sla%').execute();
    expect(out.map(o => o.event_type).sort()).toEqual(expect.arrayContaining(['workflow.sla_escalated', 'workflow.sla_reminder']));

    // the escalation target (no stage key, assignment only) can decide
    await mustOk(act(c, escalation.token, 'capex', doc.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
    expect((await mustOk(d.get(doc.id))).statusKey).toBe('approved');
  }, 90_000);
});

// QA3-BUG-013 (FIXED by the lead: main.ts now runs app.init() before startWorkers(), and registerRepeat adds late
// repeats immediately). Original finding: src/main.ts called QueueService.startWorkers() BEFORE the Nest app is initialised (createApp() does not
// call app.init(); listen() does). Modules register processors and repeatables in onModuleInit, i.e. after
// startWorkers() already ran: processors still start (registerProcessor starts late workers) but the repeatable jobs
// (outbox-relay every 2 s, workflow-sla every minute, audit-verify nightly, retired-key cleanup) are never added. With
// RUN_WORKERS=inline (the default outside production, and infra/docker-compose.yml's api service) SLA reminders and
// escalations never fire, the outbox is never relayed, and the nightly audit check never runs. (worker.ts is fine.)
describe('QA3 API process boot (main.ts order)', () => {
  it('[QA3-BUG-013] (fixed) booting like main.ts registers the repeatable jobs (workflow-sla, outbox-relay, audit-verify)', async () => {
    const { createApp } = await import('../src/bootstrap');
    const app = await createApp();
    try {
      const q = app.get(QueueService);
      // start from a clean slate: earlier suites (same Redis db) may have left repeatables registered after init
      for (const n of ['workflow', 'outbox', 'audit']) for (const r of await q.queue(n).getRepeatableJobs()) await q.queue(n).removeRepeatableByKey(r.key);
      await q.startWorkers(); // main.ts order: before init/listen
      await app.init();
      const names = new Set<string>();
      for (const n of ['workflow', 'outbox', 'audit']) for (const r of await q.queue(n).getRepeatableJobs()) names.add(r.name);
      expect([...names].sort()).toEqual(expect.arrayContaining(['audit-verify', 'outbox-relay', 'workflow-sla']));
    } finally {
      await app.close();
    }
  }, 60_000);
});
