/**
 * QA Phase 3 — security: cross-tenant ids and keys on the Phase 3 routes (complements tenancy-isolation's generated
 * route list with a B-only document type and the workflow config routes), data scope for stage-key holders,
 * self-approval (incl. via SLA escalation), forged decisions on lines of another document, idempotency-key reuse,
 * field access (hidden/read-only line fields) across detail, lists, search, timeline and approver edits, forward
 * targets, and publish-time effect validation.
 *
 * Known bugs are `it.fails` with their id (docs/qa/phase-3-report.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { DocsPortRef, SlaService } from '../src/modules/workflow';
import { ALL_CAPEX_KEYS, createCapexType, docsApi, DocsFixture } from './documents-helpers';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { createRole } from './permissions-helpers';
import { act, publishWorkflow, wfTenant, WfTenant, wfUser } from './workflow-helpers';

type Row = { id: string; number: string | null; statusKey: string; version: number; values: Record<string, unknown>; lines: { id: string; lineNo: number; values: Record<string, unknown>; qty: Record<string, string> }[]; allowedActions: string[] };
type Session = Awaited<ReturnType<typeof wfUser>>;
const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed', 'waiting_hod', 'waiting_finance', 'waiting_director'].map(v => `doc.capex:view.${v}`);

interface Side { t: WfTenant; f: DocsFixture; approverRole: string; buyerRole: string }

async function side(c: Ctx, extraTypeKey?: string): Promise<Side> {
  const t = await wfTenant(c);
  const a = api(c, t.token);
  const uom = await mustOk(a.post('/masters/uom/records', { code: `U${uid(4)}`, name: 'Numbers', data: { decimals: '0' } }), 201);
  const items: string[] = [];
  for (const n of ['Laptop', 'Printer']) items.push((await mustOk(a.post('/masters/item/records', { name: n, data: { uom: uom.id } }), 201)).id);
  const f: DocsFixture = { tenantId: t.tenantId, code: t.code, token: t.token, adminId: t.adminId, pune: t.plantA.id, puneMain: t.storeA.id, chennai: t.plantB.id, uom: uom.id, items };
  await createCapexType(c, t.token);
  if (extraTypeKey) await createCapexType(c, t.token, extraTypeKey);
  const approverRole = (await createRole(c, t.token, 'Approver')).id;
  const buyerRole = (await createRole(c, t.token, 'Buyer')).id;
  await publishWorkflow(c, t.token, 'capex', {
    stages: [
      { key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId: approverRole }], actions: ['approve', 'reject', 'hold', 'send_back', 'forward'], editableLineFields: ['est_rate', 'remarks'],
        sla: { hours: 24, remindEveryHours: 8, escalateTo: { type: 'users', userIds: [t.adminId] } } },
      { key: 'finance', name: 'Finance review', when: 'total_amount > 100000', actors: [{ type: 'role', roleId: buyerRole }], actions: ['approve', 'reject', 'send_back'] },
      { key: 'director', name: 'Director approval', when: 'total_amount >= 500000', actors: [{ type: 'users', userIds: [t.adminId] }], actions: ['approve', 'reject', 'send_back'] },
    ],
  });
  return { t, f, approverRole, buyerRole };
}

describe('QA3 security', () => {
  let c: Ctx;
  let A: Side;
  let B: Side;
  let indenterA: Session;
  let hodA: Session; // Pune scope
  let indenterB: Session;

  beforeAll(async () => {
    c = await bootApp();
    c.app.get(DocsPortRef).use(null);
    A = await side(c);
    B = await side(c, 'bonly'); // a document type key that exists only in tenant B
    indenterA = await wfUser(c, A.t, [...ALL_CAPEX_KEYS(), ...VIEWS], { scopeNode: null });
    hodA = await wfUser(c, A.t, ['doc.capex:action.view', 'doc.capex:action.stage_hod', 'approvals:action.view', 'doc.capex:action.comment', ...VIEWS], { roleId: A.approverRole });
    await mustOk(api(c, A.t.token).put(`/roles/${A.approverRole}/scope`, { entries: [{ nodeId: A.f.pune }] }));
    indenterB = await wfUser(c, B.t, [...ALL_CAPEX_KEYS(), ...VIEWS], { scopeNode: null });
    await c.app.get(EntitlementsService).bumpPermissions(A.t.tenantId);
  }, 120_000);
  afterAll(async () => { await closeApp(c); });

  const body = (s: Side, lines: { qty: string; est_rate: string; remarks?: string }[] = [{ qty: '2', est_rate: '100' }], location = s.f.pune) => ({
    values: { location, purpose: 'QA security', doc_date: '2026-10-20' },
    lines: lines.map((l, i) => ({ values: { item: s.f.items[i % s.f.items.length], ...l } })),
  });
  async function submitted(s: Side, token: string, lines?: { qty: string; est_rate: string; remarks?: string }[], location?: string, type = 'capex'): Promise<Row> {
    const d = await mustOk(docsApi(c, token, type).create(body(s, lines, location)), 201);
    return mustOk(docsApi(c, token, type).submit(d.id, d.version), 200);
  }

  // ===================================================================================== cross-tenant
  describe('cross-tenant', () => {
    it("tenant A on B's ids and B-only keys: every Phase 3 route → 404, nothing of B leaks or changes", async () => {
      const bDoc = await submitted(B, indenterB.token);
      const bDraft = await mustOk<Row>(docsApi(c, indenterB.token).create(body(B)), 201);
      const bOnly = await mustOk<Row>(docsApi(c, B.t.token, 'bonly').create(body(B)), 201);
      const bComment = await mustOk(api(c, indenterB.token).post(`/docs/capex/${bDoc.id}/comments`, { body: 'B internal' }), 201);
      const bSeries = (await mustOk(api(c, B.t.token).get('/config/numbering?docType=bonly')))[0];
      const a = api(c, A.t.token); // A's tenant admin: holds every key in A
      const calls: [string, string, unknown?][] = [
        ['get', `/docs/capex/${bDoc.id}`], ['get', `/docs/capex/${bDoc.id}/timeline`], ['get', `/docs/capex/${bDoc.id}/comments`],
        ['post', `/docs/capex/${bDoc.id}/comments`, { body: 'hi' }], ['put', `/docs/capex/${bDoc.id}/comments/${bComment.id}`, { body: 'x' }],
        ['get', `/docs/capex/${bDoc.id}/attachments`], ['post', `/docs/capex/${bDraft.id}/submit`, { version: bDraft.version }],
        ['put', `/docs/capex/${bDraft.id}`, { ...body(A), version: bDraft.version }], ['delete', `/docs/capex/${bDraft.id}`],
        ['post', `/docs/capex/${bDoc.id}/cancel`, { reason: 'hijack' }], ['post', `/docs/capex/${bDoc.id}/copy`],
        ['post', `/docs/capex/${bDoc.id}/actions`, { action: 'decide', stageKey: 'hod', outcome: 'approve' }],
        ['post', `/docs/capex/${bDoc.id}/actions`, { action: 'send_back', stageKey: 'hod', toStage: '_draft', reason: 'hijack' }],
        ['get', '/docs/bonly'], ['get', '/docs/bonly/counts'], ['get', `/docs/bonly/${bOnly.id}`], ['post', '/docs/bonly', body(A)],
        ['put', '/config/doc-types/bonly', { name: 'Hijacked', version: 1 }], ['post', '/config/doc-types/bonly/deactivate'],
        ['get', '/config/workflows/bonly'], ['get', '/config/workflows/bonly/versions'], ['post', '/config/workflows/bonly/simulate', { values: {} }],
        ['put', '/config/workflows/bonly/draft', { definition: { stages: [] }, version: 1 }], ['post', '/config/workflows/bonly/publish', { version: 1 }],
        ['put', `/config/numbering/${bSeries.id}`, { docTypeKey: 'bonly', name: 'x', pattern: 'X-{SEQ:3}', version: bSeries.version }],
        ['get', `/config/numbering/${bSeries.id}/preview`],
      ];
      for (const [m, p, b] of calls) {
        const r = await (m === 'get' ? a.get(p) : m === 'post' ? a.post(p, b) : m === 'put' ? a.put(p, b) : a.del(p));
        expect(r.status, `${m.toUpperCase()} ${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(404);
        expect(JSON.stringify(r.body)).not.toContain('B internal');
      }
      // A's lists, inbox, counts and audit never include B's rows
      const lists = [await mustOk(a.get('/docs/capex?limit=200')), await mustOk(a.get('/docs/capex?view=item&limit=200')), await mustOk(a.get('/approvals?limit=200'))];
      for (const l of lists) expect(JSON.stringify(l)).not.toContain(bDoc.id);
      expect((await mustOk(a.get(`/audit?entityId=${bDoc.id}`))).data).toEqual([]);
      expect((await mustOk(a.get('/config/numbering?docType=bonly')))).toEqual([]);
      // B unchanged
      const bNow = await mustOk<Row>(docsApi(c, indenterB.token).get(bDoc.id));
      expect(bNow.version).toBe(bDoc.version);
      expect(bNow.statusKey).toBe('waiting_hod');
      expect((await mustOk(docsApi(c, indenterB.token).get(bDraft.id))).statusKey).toBe('draft');
    });

    it("B's line ids, users and files used inside A's own requests are refused and change nothing in B", async () => {
      const bDoc = await submitted(B, indenterB.token);
      const aDoc = await submitted(A, indenterA.token);
      const a = api(c, A.t.token);
      // decision on A's document naming B's line
      const forged = await act(c, hodA.token, 'capex', aDoc.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: bDoc.lines[0]!.id, approve: '2' }] });
      expect([400, 404, 409]).toContain(forged.status);
      // forward to B's user, mention B's user, attach B's file
      const fwd = await act(c, hodA.token, 'capex', aDoc.id, { action: 'forward', stageKey: 'hod', toUserId: indenterB.id, reason: 'have a look' });
      expect(fwd.status, JSON.stringify(fwd.body)).toBe(400);
      const mention = await a.post(`/docs/capex/${aDoc.id}/comments`, { body: `ping @[B](user:${indenterB.id})` });
      expect(mention.status).toBe(400);
      const bFile = await c.db.insertInto('app.file_object').values({
        tenant_id: B.t.tenantId, storage_key: `${B.t.tenantId}/qa/${uid(10)}.png`, filename: 'b.png', mime: 'image/png', size_bytes: 3, sha256: 'x', scan_status: 'clean',
      }).returning('id').executeTakeFirstOrThrow();
      const att = await a.post(`/docs/capex/${aDoc.id}/attachments`, { fileId: bFile.id });
      expect([400, 404]).toContain(att.status);
      const bNow = await mustOk<Row>(docsApi(c, indenterB.token).get(bDoc.id));
      expect(bNow.version).toBe(bDoc.version);
      expect(bNow.lines[0]!.qty.approved).toBe('0');
      expect((await c.db.selectFrom('app.file_object').select('attached_to').where('id', '=', bFile.id).executeTakeFirstOrThrow()).attached_to).toBeNull();
    });
  });

  // ===================================================================================== scope, self, forged
  describe('who can act', () => {
    it('stage-key holder outside the document location → 404 on detail, timeline and actions; not in the inbox or counts', async () => {
      const chennai = await submitted(A, indenterA.token, [{ qty: '1', est_rate: '10' }], A.f.chennai);
      const d = docsApi(c, hodA.token);
      expect((await d.get(chennai.id)).status).toBe(404);
      expect((await d.raw.get(`/docs/capex/${chennai.id}/timeline`)).status).toBe(404);
      const r = await act(c, hodA.token, 'capex', chennai.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
      expect(r.status, JSON.stringify(r.body)).toBe(404);
      const inbox = await mustOk(api(c, hodA.token).get('/approvals?limit=200'));
      expect(inbox.data.map((i: { documentId: string }) => i.documentId)).not.toContain(chennai.id);
      const listed = await mustOk(d.list('limit=200'));
      expect(listed.data.map((x: { id: string }) => x.id)).not.toContain(chennai.id);
      // control: a Pune document is actionable
      const pune = await submitted(A, indenterA.token, [{ qty: '1', est_rate: '10' }]);
      expect((await act(c, hodA.token, 'capex', pune.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(200);
    });

    it('a submitter who also holds the stage key cannot approve their own document (self-approval off), and it is not in their inbox', async () => {
      const both = await wfUser(c, A.t, [...ALL_CAPEX_KEYS(), ...VIEWS, 'doc.capex:action.stage_hod', 'approvals:action.view'], { roleId: undefined, scopeNode: null });
      await c.db.insertInto('app.user_role').values({ tenant_id: A.t.tenantId, user_id: both.id, role_id: A.approverRole }).execute();
      await c.app.get(EntitlementsService).bumpPermissions(A.t.tenantId);
      const own = await submitted(A, both.token, [{ qty: '3', est_rate: '10' }]);
      const r = await act(c, both.token, 'capex', own.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
      expect(r.status).toBe(403);
      const detail = await mustOk<Row>(docsApi(c, both.token).get(own.id));
      expect(detail.allowedActions).not.toContain('decide');
      expect((await mustOk(api(c, both.token).get('/approvals'))).data.map((i: { documentId: string }) => i.documentId)).not.toContain(own.id);
    });

    // QA3-BUG-004: SLA escalation assigns `escalateTo` via wf_assignment without excluding the submitter, and an
    // active assignment bypasses the self-approval rule in EngineService.act — so a submitter who is the escalation
    // target (the seed's Capex HOD stage escalates to the acme admin) approves their own document once it is overdue.
    // Forward refuses the submitter as target; escalation (and ifNoActor=assign_admins with a lone admin) does not.
    // Fixed: with `workflow.block_self_approval` (default on) EngineService.act refuses the submitter on every path (rule
    // or assignment) unless the stage allows self-approval. The escalation still assigns them (the stage is never
    // orphaned) with a clear 403; the setting off restores the old behaviour (an assignment is a grant).
    it('[QA3-BUG-004] an SLA escalation to the submitter does not let them approve their own document', async () => {
      const own = await submitted(A, A.t.token, [{ qty: '1', est_rate: '10' }]); // the tenant admin submits
      expect((await act(c, A.t.token, 'capex', own.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(403);
      await c.app.get(SlaService).run(new Date(Date.now() + 25 * 3600_000)); // past the 24 h SLA → escalate to the admin
      const asg = await c.db.selectFrom('app.wf_assignment as a').innerJoin('app.wf_instance as i', 'i.id', 'a.instance_id')
        .select(['a.user_id', 'a.reason']).where('i.document_id', '=', own.id).where('a.is_active', '=', true).execute();
      expect(asg.map(x => x.reason)).toContain('escalation');
      const r = await act(c, A.t.token, 'capex', own.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' });
      expect(r.status, 'submitter approved own document through the escalation assignment').toBe(403);
      expect(r.body.title).toMatch(/you submitted this document/i);
      expect((await mustOk(api(c, A.t.token).get('/approvals?limit=200'))).data.map((i: { documentId: string }) => i.documentId)).not.toContain(own.id);
      expect((await mustOk<Row>(docsApi(c, A.t.token).get(own.id))).allowedActions).not.toContain('decide');
      // the tenant may turn segregation of duties on assignments off: the escalation assignment is then a grant again
      await mustOk(api(c, A.t.token).put('/config/settings', { 'workflow.block_self_approval': false }));
      try {
        expect((await mustOk<Row>(docsApi(c, A.t.token).get(own.id))).allowedActions).toContain('decide');
        await mustOk(act(c, A.t.token, 'capex', own.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
        // …but a submitter matching only by rule (no assignment) is still refused (stage allowSelfApproval governs that)
        const own2 = await submitted(A, A.t.token, [{ qty: '1', est_rate: '10' }]);
        expect((await act(c, A.t.token, 'capex', own2.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(403);
      } finally {
        await mustOk(api(c, A.t.token).put('/config/settings', { 'workflow.block_self_approval': true }));
      }
    });

    it('forged decisions: a line of another document in the batch refuses the whole action; neither document changes', async () => {
      const d1 = await submitted(A, indenterA.token, [{ qty: '4', est_rate: '10' }, { qty: '2', est_rate: '10' }]);
      const d2 = await submitted(A, indenterA.token, [{ qty: '4', est_rate: '10' }]);
      const r = await act(c, hodA.token, 'capex', d1.id, { action: 'decide', stageKey: 'hod', decisions: [
        { lineId: d1.lines[0]!.id, approve: '4' }, { lineId: d2.lines[0]!.id, approve: '4' },
      ] });
      expect([400, 404, 409]).toContain(r.status);
      for (const id of [d1.id, d2.id]) {
        const now = await mustOk<Row>(docsApi(c, A.t.token).get(id));
        expect(now.statusKey).toBe('waiting_hod');
        expect(now.lines.every(l => l.qty.approved === '0')).toBe(true);
      }
      // the same line twice, a deleted line, unhold of another document's line
      expect((await act(c, hodA.token, 'capex', d1.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: d1.lines[0]!.id, approve: '4' }, { lineId: d1.lines[0]!.id, approve: '4' }] })).status).toBe(400);
      expect((await act(c, hodA.token, 'capex', d1.id, { action: 'unhold', stageKey: 'hod', lineIds: [d2.lines[0]!.id] })).status).toBe(409);
      // type in the URL must match the document
      await createCapexType(c, A.t.token, 'other_qa').catch(() => undefined);
      expect((await act(c, A.t.token, 'other_qa', d1.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).toBe(404);
      // editable line values on another document's line
      const edit = await act(c, hodA.token, 'capex', d1.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: d2.lines[0]!.id, approve: '4', values: { remarks: 'forged' } }] });
      expect([400, 404, 409]).toContain(edit.status);
      expect((await mustOk<Row>(docsApi(c, A.t.token).get(d2.id))).lines[0]!.values.remarks ?? null).toBeNull();
    });

    // QA3-BUG-005: the Idempotency-Key replay is checked BEFORE the stage authorisation (EngineService.act), so any
    // in-scope user who presents a key someone else used on the document gets 200 + the DocumentRow with the
    // approver's allowedActions computed for them — the request is treated as "their" successful action.
    it('[QA3-BUG-005] reusing an approver\'s Idempotency-Key does not turn an unauthorised request into a 200', async () => {
      const d = await submitted(A, indenterA.token, [{ qty: '2', est_rate: '10' }]);
      const key = `k-${uid(10)}`;
      await mustOk(act(c, hodA.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }, { 'Idempotency-Key': key }));
      // the indenter holds no stage key: a fresh request is 403…
      const fresh = await act(c, indenterA.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', outcome: 'reject', comment: 'no' });
      expect([403, 409]).toContain(fresh.status);
      // …and so must be the same request carrying the approver's key
      const replay = await act(c, indenterA.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', outcome: 'reject', comment: 'no' }, { 'Idempotency-Key': key });
      expect(replay.status).toBe(403);
    });
  });

  // ===================================================================================== field access
  describe('field access on the capex line form (est_rate hidden, remarks read-only)', () => {
    let restricted: Session;
    let doc: Row;
    beforeAll(async () => {
      const role = await createRole(c, A.t.token, 'Restricted capex');
      await mustOk(api(c, A.t.token).put(`/roles/${role.id}/permissions/tabs/doc.capex`, {
        actions: ['doc.capex:action.view', 'doc.capex:action.add', 'doc.capex:action.edit', 'doc.capex:action.submit', 'doc.capex:action.stage_hod'],
        views: VIEWS,
        fieldAccess: [{ formKey: 'capex_line', fieldKey: 'est_rate', mode: 'hidden' }, { formKey: 'capex_line', fieldKey: 'remarks', mode: 'readonly' }],
      }));
      await mustOk(api(c, A.t.token).put(`/roles/${role.id}/permissions/tabs/approvals`, { actions: ['approvals:action.view'], views: [] }));
      await mustOk(api(c, A.t.token).put(`/roles/${role.id}/scope`, { entries: [{ allNodes: true }] }));
      restricted = await wfUser(c, A.t, [], { roleId: role.id });
      // a stage actor rule by role: make the restricted user an Approver too (so they can act at hod)
      await c.db.insertInto('app.user_role').values({ tenant_id: A.t.tenantId, user_id: restricted.id, role_id: A.approverRole }).execute();
      await c.app.get(EntitlementsService).bumpPermissions(A.t.tenantId);
      // admin raises a document with a distinctive est_rate; edits the draft once so the timeline has a diff
      const d = await mustOk<Row>(docsApi(c, A.t.token).create(body(A, [{ qty: '3', est_rate: '4321.57', remarks: 'quoted' }])), 201);
      const ed = await mustOk<Row>(docsApi(c, A.t.token).update(d.id, { ...body(A, [{ qty: '3', est_rate: '4321.58', remarks: 'quoted' }]), version: d.version }));
      doc = await mustOk(docsApi(c, A.t.token).submit(d.id, ed.version));
    });

    it('hidden in detail, document list columns, item list and ad-hoc columns; writing it is refused', async () => {
      const d = docsApi(c, restricted.token);
      const detail = await mustOk<Row>(d.get(doc.id));
      expect(detail.lines[0]!.values).not.toHaveProperty('est_rate');
      expect(JSON.stringify(detail)).not.toContain('4321.5');
      const item = await mustOk(d.list('view=item&limit=200&columns=est_rate,remarks'));
      expect(JSON.stringify(item)).not.toContain('4321.5');
      const docList = await mustOk(d.list('limit=200'));
      expect(JSON.stringify(docList)).not.toContain('4321.5');
      expect((await d.list('view=item&f.est_rate=4321.58')).status).toBe(400);
      expect((await d.list('view=item&sort=est_rate')).status).toBe(400);
      const own = await mustOk<Row>(d.create(body(A, [{ qty: '1', est_rate: '0' }]).lines.map(() => 0).length ? { values: body(A).values, lines: [{ values: { item: A.f.items[0], qty: '1' } }] } : {}), 201);
      const w = await d.update(own.id, { version: own.version, values: own.values, lines: [{ id: own.lines[0]!.id, values: { ...own.lines[0]!.values, est_rate: '99' } }] });
      expect(w.status).toBe(403);
      expect(w.body.code).toBe('FIELD_READ_ONLY');
    });

    // QA3-BUG-006: list search `q` matches `custom::text ILIKE` on header and line JSON, including hidden fields
    // (and JSON key names), so a user can binary-search a hidden value: q=4321.58 finds the line, q=4321.59 doesn't.
    it('[QA3-BUG-006] list search q is not an oracle for hidden field values', async () => {
      const d = docsApi(c, restricted.token);
      const hit = await mustOk(d.list('view=item&limit=200&q=4321.58'));
      const miss = await mustOk(d.list('view=item&limit=200&q=4321.59'));
      expect(hit.data.length, 'searching the exact hidden value finds the line').toBe(miss.data.length);
      const keyName = await mustOk(d.list('view=item&limit=200&q=est_rate'));
      expect(keyName.data.length, 'the hidden field\'s key name matches every line').toBe(0);
      // the amount derived from the hidden rate (12964.74) is not an oracle either; a visible value still matches
      expect((await mustOk(d.list('view=item&limit=200&q=12964.74'))).data.length).toBe(0);
      expect((await mustOk(d.list('limit=200&q=12964.74'))).data.length).toBe(0);
      expect((await mustOk(d.list('view=item&limit=200&q=quoted'))).data.map((r: { documentId: string }) => r.documentId)).toContain(doc.id);
      // the admin (no field access limits) still finds it by the rate
      expect((await mustOk(docsApi(c, A.t.token).list('view=item&limit=200&q=4321.58'))).data.map((r: { documentId: string }) => r.documentId)).toContain(doc.id);
      // sorting by a hidden / derived-from-hidden field is refused
      expect((await d.list('sort=-total_amount')).status).toBe(400);
    });

    // QA3-BUG-007: the timeline "Edited" entry carries `changes` built from the raw audit before/after (all header
    // values and full line values), without the caller's field access → hidden values are disclosed to every viewer.
    it('[QA3-BUG-007] the timeline does not disclose hidden field values in edit diffs', async () => {
      const tl = await mustOk(api(c, restricted.token).get(`/docs/capex/${doc.id}/timeline`));
      const edited = tl.filter((e: { kind: string }) => e.kind === 'updated');
      expect(edited.length).toBeGreaterThan(0);
      expect(JSON.stringify(tl)).not.toContain('4321.5');
      expect(JSON.stringify(tl), 'derived amount (qty × hidden rate) is hidden too').not.toContain('12964.7');
      // the admin still sees the change
      const full = await mustOk(api(c, A.t.token).get(`/docs/capex/${doc.id}/timeline`));
      expect(JSON.stringify(full.filter((e: { kind: string }) => e.kind === 'updated'))).toContain('4321.58');
    });

    // QA3-BUG-008: approver line edits during a decision (Stage.editableLineFields) go through
    // DocumentsService.applyLineEdits with `perms: null`, so the approver's field access is not applied: a user for
    // whom `remarks` is read-only (and `est_rate` hidden) can change them while deciding.
    it('[QA3-BUG-008] editable line fields at a stage still honour the approver\'s field access (read-only/hidden → 403)', async () => {
      const d = await mustOk<Row>(docsApi(c, A.t.token).create(body(A, [{ qty: '2', est_rate: '50', remarks: 'orig' }])), 201);
      const s = await mustOk<Row>(docsApi(c, A.t.token).submit(d.id, d.version));
      const r = await act(c, restricted.token, 'capex', s.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: s.lines[0]!.id, approve: '2', values: { remarks: 'changed by RO user', est_rate: '1' } }] });
      const after = await mustOk<Row>(docsApi(c, A.t.token).get(s.id));
      expect(after.lines[0]!.values.remarks, 'read-only field changed').toBe('orig');
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('FIELD_READ_ONLY');
      // only the hidden field → still refused; an approver without restrictions may edit (audited under their name)
      const hidden = await act(c, restricted.token, 'capex', s.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: s.lines[0]!.id, approve: '2', values: { est_rate: '1' } }] });
      expect(hidden.status).toBe(403);
      await mustOk(act(c, hodA.token, 'capex', s.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: s.lines[0]!.id, approve: '2', values: { remarks: 'by HOD' } }] }));
      expect((await mustOk<Row>(docsApi(c, A.t.token).get(s.id))).lines[0]!.values.remarks).toBe('by HOD');
      const audit = await c.db.selectFrom('app.audit_log').select('actor_id').where('entity_id', '=', s.id).where('action', '=', 'update').orderBy('id', 'desc').executeTakeFirstOrThrow();
      expect(audit.actor_id).toBe(hodA.id);
    });

    it('[QA3-OBS-1] a formula computed from a hidden field (amount = qty × est_rate, total_amount = SUM(lines.amount)) is hidden too', async () => {
      // Fixed: DocStore.hiddenFields hides formulas that depend (transitively) on a hidden field on every read path.
      const detail = await mustOk<Row>(docsApi(c, restricted.token).get(doc.id));
      expect(detail.lines[0]!.values).not.toHaveProperty('amount');
      expect(detail.values).not.toHaveProperty('total_amount');
      expect(detail.lines[0]!.values.remarks).toBe('quoted');
      const list = await mustOk(docsApi(c, restricted.token).list('limit=200'));
      expect(list.data.find((r: { id: string }) => r.id === doc.id).totalAmount).toBeNull();
      expect(JSON.stringify(await mustOk(docsApi(c, restricted.token).list('view=item&limit=200&columns=amount')))).not.toContain('12964.7');
      // the admin still sees it, and it is still computed server-side
      expect((await mustOk<Row>(docsApi(c, A.t.token).get(doc.id))).lines[0]!.values.amount).toBe('12964.74');
    });
  });

  // ===================================================================================== forward + publish
  describe('forward targets and publish validation', () => {
    it('forward: target must see the document type and location; then acts on behalf (onBehalfOf recorded)', async () => {
      const d = await submitted(A, indenterA.token, [{ qty: '2', est_rate: '10' }]);
      const noView = await wfUser(c, A.t, ['approvals:action.view'], { scopeNode: null });
      const chennaiOnly = await wfUser(c, A.t, ['doc.capex:action.view', ...VIEWS], { scopeNode: A.f.chennai });
      const ok = await wfUser(c, A.t, ['doc.capex:action.view', 'approvals:action.view', ...VIEWS], { scopeNode: A.f.pune });
      for (const u of [noView, chennaiOnly]) {
        const r = await act(c, hodA.token, 'capex', d.id, { action: 'forward', stageKey: 'hod', toUserId: u.id, reason: 'please' });
        expect(r.status, JSON.stringify(r.body)).toBe(400);
      }
      expect((await act(c, hodA.token, 'capex', d.id, { action: 'forward', stageKey: 'hod', toUserId: indenterA.id, reason: 'self?' })).status).toBe(400);
      await mustOk(act(c, hodA.token, 'capex', d.id, { action: 'forward', stageKey: 'hod', toUserId: ok.id, reason: 'please decide' }));
      expect((await mustOk(api(c, ok.token).get('/approvals'))).data.find((i: { documentId: string }) => i.documentId === d.id)).toMatchObject({ assignedBecause: 'forward' });
      await mustOk(act(c, ok.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
      const w = await c.db.selectFrom('app.wf_action').select(['actor_id', 'on_behalf_of']).where('document_id', '=', d.id).where('action', '=', 'decide').executeTakeFirstOrThrow();
      expect(w).toEqual({ actor_id: ok.id, on_behalf_of: hodA.id });
      // the assignment ends with the stage
      expect((await act(c, ok.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' })).status).not.toBe(200);
    });

    it('publishing with an unavailable effect or a misplaced route_to reports issues and does not publish', async () => {
      const a = api(c, A.t.token);
      const before = await mustOk(a.get('/config/workflows/capex'));
      for (const [effects, code] of [
        [{ onApprove: [{ effect: 'post_stock' }] }, 'EFFECT_UNAVAILABLE'],
        [{ onEnter: [{ effect: 'block_stock' }] }, 'EFFECT_UNAVAILABLE'],
        [{ onApprove: [{ effect: 'route_to', stage: 'hod' }] }, 'BAD_ROUTE'],
        [{ onReject: [{ effect: 'route_to', stage: 'nowhere' }] }, 'BAD_ROUTE'],
      ] as const) {
        const def = { ...before.published, stages: before.published.stages.map((s: { key: string }, i: number) => (i === 1 ? { ...s, effects } : s)) };
        const cur = await mustOk(a.get('/config/workflows/capex'));
        const saved = await mustOk(a.put('/config/workflows/capex/draft', { definition: def, version: cur.version }));
        expect(saved.draftIssues.map((x: { code: string }) => x.code), JSON.stringify(effects)).toContain(code);
        const pub = await a.post('/config/workflows/capex/publish', { version: saved.version });
        expect(pub.status, JSON.stringify(pub.body)).toBeGreaterThanOrEqual(400);
      }
      await mustOk(a.del('/config/workflows/capex/draft'));
      expect((await mustOk(a.get('/config/workflows/capex'))).publishedVersion).toBe(before.publishedVersion);
    });
  });
});
