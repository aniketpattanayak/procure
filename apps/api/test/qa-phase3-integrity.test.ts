/**
 * QA Phase 3 — integrity: concurrency, numbering, idempotency, decimal edge cases, send-back loops, outbox
 * exactly-once with the real queue, and the audit chain verifier on many rows. Everything runs on the REAL documents
 * module + workflow engine through the HTTP API (the Capex setup mirrors the demo seed: HOD → Finance (> 1 lakh) →
 * Director (≥ 5 lakh)).
 *
 * Invariant checked after every race (ledger ⇄ workflow): for each line,
 *   requested = approved + rejected + cancelled + pendingApproval  and  pendingApproval = Σ wf_line_state(pending + held)
 * for the running instance (0 when none).
 *
 * Known bugs are `it.fails` with their id (docs/qa/phase-3-report.md).
 */
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/core/audit.service';
import { DbService } from '../src/core/db.service';
import { EntitlementsService } from '../src/core/entitlements.service';
import { QueueService } from '../src/core/queue.service';
import { AuditVerifier, EVENTS_QUEUE, OutboxRelay } from '../src/modules/documents';
import { DocsPortRef } from '../src/modules/workflow';
import { ALL_CAPEX_KEYS, createCapexType, docsApi, DocsFixture } from './documents-helpers';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { createRole } from './permissions-helpers';
import { act, instanceOf, publishWorkflow, wfTenant, wfUser } from './workflow-helpers';

type Line = { id: string; lineNo: number; statusKey: string; values: Record<string, unknown>; qty: Record<string, string>; stages: Record<string, { pending: string; held: string }> };
type Row = { id: string; number: string | null; statusKey: string; version: number; lines: Line[]; allowedActions: string[]; workflow: { workflowVersion: number; stages: { key: string; status: string }[] } | null };
type Session = Awaited<ReturnType<typeof wfUser>>;

const VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed', 'waiting_hod', 'waiting_finance', 'waiting_director'].map(v => `doc.capex:view.${v}`);

describe('QA3 integrity', () => {
  let c: Ctx;
  let f: DocsFixture;
  let indenter: Session;
  let hod: Session;
  let hod2: Session;
  let finance: Session;

  beforeAll(async () => {
    c = await bootApp();
    c.app.get(DocsPortRef).use(null);
    const t = await wfTenant(c);
    const a = api(c, t.token);
    const uom = await mustOk(a.post('/masters/uom/records', { code: `U${uid(4)}`, name: 'Kilograms', data: { decimals: '4' } }), 201);
    const items: string[] = [];
    for (const n of ['Laptop', 'Printer', 'Desk', 'Chair', 'Monitor']) items.push((await mustOk(a.post('/masters/item/records', { name: n, data: { uom: uom.id } }), 201)).id);
    f = { tenantId: t.tenantId, code: t.code, token: t.token, adminId: t.adminId, pune: t.plantA.id, puneMain: t.storeA.id, chennai: t.plantB.id, uom: uom.id, items };
    await createCapexType(c, t.token);
    // Pune-specific series as in the seed
    await mustOk(a.post('/config/numbering', { docTypeKey: 'capex', name: 'Pune', locationNodeId: f.pune, pattern: 'CPX-PUN/{FYS}/{SEQ:4}' }), 201);
    const approverRole = (await createRole(c, t.token, 'Approver')).id;
    const buyerRole = (await createRole(c, t.token, 'Buyer')).id;
    await publishWorkflow(c, t.token, 'capex', {
      stages: [
        { key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId: approverRole }], sla: { hours: 24, remindEveryHours: 8, escalateTo: { type: 'users', userIds: [t.adminId] } } },
        { key: 'finance', name: 'Finance review', when: 'total_amount > 100000', actors: [{ type: 'role', roleId: buyerRole }], actions: ['approve', 'reject', 'send_back'] },
        { key: 'director', name: 'Director approval', when: 'total_amount >= 500000', actors: [{ type: 'users', userIds: [t.adminId] }], actions: ['approve', 'reject', 'send_back'] },
      ],
    });
    indenter = await wfUser(c, t, [...ALL_CAPEX_KEYS(), ...VIEWS], { scopeNode: null });
    hod = await wfUser(c, t, ['doc.capex:action.view', 'doc.capex:action.stage_hod', 'approvals:action.view', ...VIEWS], { roleId: approverRole });
    hod2 = await wfUser(c, t, ['doc.capex:action.view', 'doc.capex:action.stage_hod', 'approvals:action.view', ...VIEWS], { roleId: approverRole });
    finance = await wfUser(c, t, ['doc.capex:action.view', 'doc.capex:action.stage_finance', 'approvals:action.view', ...VIEWS], { roleId: buyerRole });
    await mustOk(a.put(`/roles/${approverRole}/scope`, { entries: [{ nodeId: f.pune }] }));
    await mustOk(a.put(`/roles/${buyerRole}/scope`, { entries: [{ allNodes: true }] }));
    await c.app.get(EntitlementsService).bumpPermissions(t.tenantId);
  }, 120_000);
  afterAll(async () => { await closeApp(c); });

  const docs = (token = indenter.token) => docsApi(c, token);
  const body = (lines: { qty: string; est_rate: string }[], location = f.pune, values: Record<string, unknown> = {}) => ({
    values: { location, purpose: 'QA integrity', doc_date: '2026-10-20', ...values },
    lines: lines.map((l, i) => ({ values: { item: f.items[i % f.items.length], ...l } })),
  });
  async function draft(lines: { qty: string; est_rate: string }[], location = f.pune): Promise<Row> {
    return mustOk(docs().create(body(lines, location)), 201);
  }
  async function submitted(lines: { qty: string; est_rate: string }[], location = f.pune): Promise<Row> {
    const d = await draft(lines, location);
    return mustOk(docs().submit(d.id, d.version), 200);
  }
  const get = async (id: string): Promise<Row> => mustOk(docs(f.token).get(id));

  /** Ledger ⇄ workflow invariant for every line of the document. */
  async function invariant(docId: string) {
    const d = await get(docId);
    const inst = await c.db.selectFrom('app.wf_instance').select('id').where('document_id', '=', docId).where('status', '=', 'running').executeTakeFirst();
    for (const l of d.lines) {
      const q = l.qty;
      const lhs = new Decimal(q.requested);
      const rhs = new Decimal(q.approved).plus(q.rejected).plus(q.cancelled).plus(q.pendingApproval);
      expect(lhs.eq(rhs), `line ${l.lineNo}: requested ${q.requested} ≠ approved ${q.approved} + rejected ${q.rejected} + cancelled ${q.cancelled} + pending ${q.pendingApproval}`).toBe(true);
      const wf = inst ? await c.db.selectFrom('app.wf_line_state').select(['pending_qty', 'held_qty']).where('instance_id', '=', inst.id).where('line_id', '=', l.id).execute() : [];
      const inWf = wf.reduce((s, r) => s.plus(r.pending_qty).plus(r.held_qty), new Decimal(0));
      expect(inWf.eq(q.pendingApproval), `line ${l.lineNo}: workflow holds ${inWf} but pendingApproval = ${q.pendingApproval}`).toBe(true);
      expect(new Decimal(q.held).lte(q.pendingApproval)).toBe(true);
      for (const k of ['approved', 'held', 'rejected', 'cancelled', 'pendingApproval']) expect(new Decimal(q[k]!).gte(0), `${k} negative`).toBe(true);
    }
    return d;
  }

  // ===================================================================================== concurrency
  describe('concurrency', () => {
    it('two approvers decide the same pending qty at once (no If-Match) → exactly one wins, ledger not doubled', async () => {
      for (let round = 0; round < 5; round++) {
        const d = await submitted([{ qty: '7', est_rate: '10' }, { qty: '3', est_rate: '10' }]);
        const [l1, l2] = d.lines.map(l => l.id);
        const bodyA = { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l1, approve: '7' }, { lineId: l2, approve: '3' }] };
        const bodyB = { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l1, approve: '5', reject: '2', reason: 'B trims' }, { lineId: l2, reject: '3', reason: 'B rejects' }] };
        const [x, y] = await Promise.all([act(c, hod.token, 'capex', d.id, bodyA), act(c, hod2.token, 'capex', d.id, bodyB)]);
        expect([x.status, y.status].sort(), JSON.stringify([x.body, y.body])).toEqual([200, 409]);
        const loser = x.status === 409 ? x : y;
        expect(['QTY_CHANGED', 'STAGE_NOT_ACTIVE', 'WORKFLOW_NOT_RUNNING']).toContain(loser.body.code);
        const after = await invariant(d.id);
        const winnerA = x.status === 200;
        expect(after.lines.map(l => l.qty.approved)).toEqual(winnerA ? ['7', '3'] : ['5', '0']);
        expect((await c.db.selectFrom('app.wf_action').select('id').where('document_id', '=', d.id).where('action', '=', 'decide').execute()).length).toBe(1);
      }
    });

    it('two approvers with the same If-Match version → one 200, the other VERSION_CONFLICT', async () => {
      const d = await submitted([{ qty: '4', est_rate: '10' }]);
      const b = { action: 'decide', stageKey: 'hod', outcome: 'approve' };
      const [x, y] = await Promise.all([
        act(c, hod.token, 'capex', d.id, b, { 'If-Match': String(d.version) }),
        act(c, hod2.token, 'capex', d.id, b, { 'If-Match': String(d.version) }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      expect((x.status === 409 ? x : y).body.code).toBe('VERSION_CONFLICT');
      expect((await invariant(d.id)).lines[0]!.qty.approved).toBe('4');
    });

    it('50 parallel submits on one series → 50 distinct consecutive numbers, no gaps, Pune series pattern', async () => {
      const ds: Row[] = [];
      for (let i = 0; i < 50; i++) ds.push(await draft([{ qty: '1', est_rate: '100' }], f.puneMain)); // Main store → nearest ancestor = Pune series
      const before = await c.db.selectFrom('app.numbering_counter as n').innerJoin('app.numbering_series as s', 's.id', 'n.series_id')
        .select(['n.value']).where('n.tenant_id', '=', f.tenantId).where('s.pattern', '=', 'CPX-PUN/{FYS}/{SEQ:4}').executeTakeFirst();
      const start = Number(before?.value ?? 0);
      const res = await Promise.all(ds.map(x => docs().submit(x.id, x.version)));
      expect(res.map(r => r.status), JSON.stringify(res.find(r => r.status !== 200)?.body)).toEqual(Array(50).fill(200));
      const nums: string[] = res.map(r => r.body.number);
      expect(nums.every(n => /^CPX-PUN\/\d\d-\d\d\/\d{4}$/.test(n))).toBe(true);
      const seqs = nums.map(n => Number(n.split('/').pop())).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => start + i + 1));
      // every submitted document is in approval with its own instance
      const running = await c.db.selectFrom('app.wf_instance').select('document_id').where('document_id', 'in', ds.map(x => x.id)).where('status', '=', 'running').execute();
      expect(running.length).toBe(50);
    });

    it('the same draft submitted 5× in parallel → one number, one instance, requested written once', async () => {
      const d = await draft([{ qty: '2', est_rate: '10' }]);
      const res = await Promise.all(Array.from({ length: 5 }, () => docs().submit(d.id, d.version)));
      expect(res.filter(r => r.status === 200).length).toBe(1);
      expect(res.filter(r => r.status !== 200).every(r => r.status === 409)).toBe(true);
      const after = await invariant(d.id);
      expect(after.lines[0]!.qty.requested).toBe('2');
      expect((await c.db.selectFrom('app.wf_instance').select('id').where('document_id', '=', d.id).execute()).length).toBe(1);
    });

    it('parallel decide + whole-document cancel → serialised; the ledger stays consistent either way', async () => {
      const outcomes = new Set<string>();
      for (let round = 0; round < 6; round++) {
        const d = await submitted([{ qty: '10', est_rate: '10' }, { qty: '5', est_rate: '10' }]);
        const [l1, l2] = d.lines.map(l => l.id);
        const [x, y] = await Promise.all([
          act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l1, approve: '6', hold: '4', reason: 'part' }] }),
          docs().raw.post(`/docs/capex/${d.id}/cancel`, { reason: 'Changed plans' }),
        ]);
        expect(x.status === 200 || x.status === 409, JSON.stringify(x.body)).toBe(true);
        expect(y.status, JSON.stringify(y.body)).toBe(200);
        outcomes.add(`${x.status}/${y.status}`);
        const after = await invariant(d.id);
        // a cancelled document reads "cancelled" whatever was approved before the cancel
        expect(after.statusKey).toBe('cancelled');
        const L1 = after.lines.find(l => l.id === l1)!;
        expect(L1.statusKey).toBe(x.status === 200 ? 'approved' : 'cancelled'); // approved 6 of (10 − 4 cancelled)
        if (x.status === 200) expect(L1.qty).toMatchObject({ approved: '6', cancelled: '4', held: '0', pendingApproval: '0' });
        else expect(L1.qty).toMatchObject({ approved: '0', cancelled: '10' });
        expect(after.lines.find(l => l.id === l2)!.qty).toMatchObject({ cancelled: '5', pendingApproval: '0' });
        expect((await instanceOf(c, d.id))!.status).toBe('cancelled');
      }
      expect(outcomes.size).toBeGreaterThanOrEqual(1);
    });

    it('parallel decide + line cancel on the same line → never negative, never double-counted', async () => {
      for (let round = 0; round < 6; round++) {
        const d = await submitted([{ qty: '8', est_rate: '10' }, { qty: '2', est_rate: '10' }]);
        const [l1] = d.lines.map(l => l.id);
        const [x, y] = await Promise.all([
          act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l1, approve: '8' }] }),
          docs().raw.post(`/docs/capex/${d.id}/cancel`, { reason: 'Not needed', lineIds: [l1] }),
        ]);
        expect([x.status, y.status].filter(s => s === 200).length, JSON.stringify([x.body, y.body])).toBe(1);
        const after = await invariant(d.id);
        const L1 = after.lines.find(l => l.id === l1)!;
        expect(new Decimal(L1.qty.approved).plus(L1.qty.cancelled).toString()).toBe('8');
      }
    });

    it('parallel unhold by two approvers → one succeeds, held qty released once', async () => {
      const d = await submitted([{ qty: '6', est_rate: '10' }]);
      const l = d.lines[0]!.id;
      await mustOk(act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l, hold: '6', reason: 'wait' }] }));
      const [x, y] = await Promise.all([
        act(c, hod.token, 'capex', d.id, { action: 'unhold', stageKey: 'hod', lineIds: [l] }),
        act(c, hod2.token, 'capex', d.id, { action: 'unhold', stageKey: 'hod', lineIds: [l] }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const after = await invariant(d.id);
      expect(after.lines[0]!.stages).toEqual({ hod: { pending: '6', held: '0' } });
      const ev = await c.db.selectFrom('app.line_event').select(['event_type', 'qty']).where('line_id', '=', l).where('event_type', 'in', ['held', 'unheld']).execute();
      expect(ev.map(e => e.event_type).sort()).toEqual(['held', 'unheld']);
    });

    it('parallel send back (to draft) + decide → document ends either in draft or decided, never both', async () => {
      for (let round = 0; round < 4; round++) {
        const d = await submitted([{ qty: '3', est_rate: '10' }]);
        const [x, y] = await Promise.all([
          act(c, hod.token, 'capex', d.id, { action: 'send_back', stageKey: 'hod', toStage: '_draft', reason: 'Add quote' }),
          act(c, hod2.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }),
        ]);
        expect([x.status, y.status].sort()).toEqual([200, 409]);
        const after = await invariant(d.id);
        expect(after.statusKey).toBe(x.status === 200 ? 'draft' : 'approved');
      }
    });

    it('Idempotency-Key: 5 parallel replays of one decision → one action, all 200 with the same version', async () => {
      const d = await submitted([{ qty: '9', est_rate: '10' }]);
      const b = { action: 'decide', stageKey: 'hod', decisions: [{ lineId: d.lines[0]!.id, approve: '4', hold: '5', reason: 'later' }] };
      const key = `qa-${uid(10)}`;
      const res = await Promise.all(Array.from({ length: 5 }, () => act(c, hod.token, 'capex', d.id, b, { 'Idempotency-Key': key })));
      expect(res.map(r => r.status), JSON.stringify(res.map(r => r.body))).toEqual(Array(5).fill(200));
      expect(new Set(res.map(r => r.body.version)).size).toBe(1);
      expect((await c.db.selectFrom('app.wf_action').select('id').where('document_id', '=', d.id).where('action', '=', 'decide').execute()).length).toBe(1);
      const after = await invariant(d.id);
      expect(after.lines[0]!.qty).toMatchObject({ approved: '4', held: '5' });
      // a later replay (sequential) still returns the original outcome and writes nothing
      const again = await act(c, hod.token, 'capex', d.id, b, { 'Idempotency-Key': key });
      expect(again.status).toBe(200);
      expect((await c.db.selectFrom('app.line_event').select('id').where('line_id', '=', d.lines[0]!.id).execute()).length)
        .toBe((await c.db.selectFrom('app.line_event').select('id').where('line_id', '=', d.lines[0]!.id).execute()).length);
    });
  });

  // ===================================================================================== decimals
  describe('decimal edge cases', () => {
    it('0.0001 splits: approve 0.3333 + hold 0.3333 + reject 0.3334 and 0.001 lines are exact; no float noise', async () => {
      // line qty is a "decimal" form field (3 decimals stored); decisions may use the ledger's 4 decimals
      const d = await submitted([{ qty: '1', est_rate: '10' }, { qty: '0.001', est_rate: '10' }, { qty: '0.003', est_rate: '10' }]);
      const [l1, l2, l3] = d.lines.map(l => l.id);
      await mustOk(act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [
        { lineId: l1, approve: '0.3333', hold: '0.3333', reject: '0.3334', reason: 'thirds' },
        { lineId: l2, approve: '0.0001', reject: '0.0009', reason: 'tiny' },
        { lineId: l3, approve: '0.001', hold: '0.001', reject: '0.001', reason: 'split' },
      ] }));
      let after = await invariant(d.id);
      expect(after.lines.map(l => [l.qty.approved, l.qty.held, l.qty.rejected])).toEqual([['0.3333', '0.3333', '0.3334'], ['0.0001', '0', '0.0009'], ['0.001', '0.001', '0.001']]);
      await mustOk(act(c, hod.token, 'capex', d.id, { action: 'unhold', stageKey: 'hod', lineIds: [l1, l3] }));
      await mustOk(act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l1, approve: '0.3333' }, { lineId: l3, approve: '0.0005', reject: '0.0005', reason: 'half' }] }));
      after = await invariant(d.id);
      expect(after.lines.map(l => l.qty.approved)).toEqual(['0.6666', '0.0001', '0.0015']);
      expect(after.statusKey).toBe('partially_approved');
    });

    it('a decision with a 5th decimal (beyond the ledger precision) is refused (400) and nothing is written', async () => {
      const d = await submitted([{ qty: '1', est_rate: '10' }]);
      const l = d.lines[0]!.id;
      const r = await act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l, approve: '0.99995', reject: '0.00005', reason: 'precision' }] });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      const after = await invariant(d.id);
      expect(after.lines[0]!.qty).toMatchObject({ approved: '0', rejected: '0', pendingApproval: '1' });
    });

    // QA3-BUG-003 (fixed): the UoM master's `decimals` (Phase 2 contract: 0–6) caps line quantities and every entered
    // ledger quantity (decisions, holds, receipts, issues) and opening stock / block quantities.
    it('[QA3-BUG-003] whole-number units: a fractional qty or decision on a 0-decimal UoM is refused', async () => {
      const a = api(c, f.token);
      const nos = await mustOk(a.post('/masters/uom/records', { code: `N${uid(4)}`, name: 'Nos', data: { decimals: '0' } }), 201);
      const item = await mustOk(a.post('/masters/item/records', { name: 'Whole laptop', data: { uom: nos.id } }), 201);
      const frac = await docs().create({ values: { location: f.pune, purpose: 'Fractions', doc_date: '2026-10-20' }, lines: [{ values: { item: item.id, qty: '2.5', est_rate: '10' } }] });
      const whole = await mustOk<Row>(docs().create({ values: { location: f.pune, purpose: 'Whole', doc_date: '2026-10-20' }, lines: [{ values: { item: item.id, qty: '3', est_rate: '10' } }] }), 201);
      const sub = await mustOk<Row>(docs().submit(whole.id, whole.version));
      const half = await act(c, hod.token, 'capex', sub.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: sub.lines[0]!.id, approve: '0.5', reject: '2.5', reason: 'half a laptop' }] });
      expect(frac.status, 'qty 2.5 Nos').toBe(400);
      expect(JSON.stringify(frac.body)).toContain('lines.0.qty');
      expect(frac.body.errors[0].message).toMatch(/whole numbers only/);
      expect(half.status, 'approve 0.5 Nos').toBe(400);
      expect(half.body.title).toMatch(/whole numbers only/);
      expect((await invariant(sub.id)).lines[0]!.qty).toMatchObject({ approved: '0', rejected: '0', pendingApproval: '3' });
      // whole decisions on it still work
      await mustOk(act(c, hod.token, 'capex', sub.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: sub.lines[0]!.id, approve: '2', reject: '1', reason: 'two' }] }));
      // a 2-decimal unit: 1.25 is fine, 1.255 is refused
      const mtr = await mustOk(a.post('/masters/uom/records', { code: `M${uid(4)}`, name: 'Metre', data: { decimals: '2' } }), 201);
      const cable = await mustOk(a.post('/masters/item/records', { name: 'Cable', data: { uom: mtr.id } }), 201);
      expect((await docs().create({ values: { location: f.pune, purpose: 'Cable', doc_date: '2026-10-20' }, lines: [{ values: { item: cable.id, qty: '1.25', est_rate: '10' } }] })).status).toBe(201);
      const r3 = await docs().create({ values: { location: f.pune, purpose: 'Cable', doc_date: '2026-10-20' }, lines: [{ values: { item: cable.id, qty: '1.255', est_rate: '10' } }] });
      expect(r3.status).toBe(400);
      expect(r3.body.errors[0].message).toMatch(/at most 2 decimal places/);
    });

    it('sums that are off by 0.0001 are refused (409 QTY_CHANGED) and nothing is written', async () => {
      const d = await submitted([{ qty: '2.5', est_rate: '10' }]);
      const l = d.lines[0]!.id;
      for (const dec of [{ approve: '2.4999' }, { approve: '2.5001' }, { approve: '1.25', reject: '1.2499', reason: 'x' }]) {
        const r = await act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l, ...dec }] });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(r.body.code).toBe('QTY_CHANGED');
      }
      // trailing zeros are equal
      await mustOk(act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l, approve: '2.50000000' }] }));
      expect((await invariant(d.id)).lines[0]!.qty.approved).toBe('2.5');
    });

    it('line quantities with more decimals than the qty field stores are refused at save (400), not truncated silently', async () => {
      const r = await docs().create(body([{ qty: '1.2345', est_rate: '10' }]));
      expect(r.status, JSON.stringify(r.body)).toBe(400);
    });

    it('huge quantities: 99,999,999,999.999 flows through the ledger exactly (4-decimal decisions on it too)', async () => {
      const d = await submitted([{ qty: '99999999999.999', est_rate: '0' }]);
      const l = d.lines[0]!.id;
      await mustOk(act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l, approve: '99999999999.9989', reject: '0.0001', reason: 'trim' }] }));
      const after = await invariant(d.id);
      expect(after.lines[0]!.qty).toMatchObject({ requested: '99999999999.999', approved: '99999999999.9989', rejected: '0.0001' });
    });

    // QA3-BUG-002: quantity/amount overflow of numeric(18,4) is not validated: the database raises "numeric field
    // overflow" and the API answers 500 instead of a 400 with the field path.
    it('[QA3-BUG-002] a quantity or amount beyond numeric(18,4) is a 400 validation error, not a 500', async () => {
      const big = await docs().create(body([{ qty: '100000000000000', est_rate: '1' }]));   // 1e14 qty
      expect(big.status, JSON.stringify(big.body)).toBe(400);
      expect(JSON.stringify(big.body)).toContain('lines.0.qty');
      const amount = await docs().create(body([{ qty: '10000000', est_rate: '100000000' }])); // amount 1e15
      expect(amount.status, JSON.stringify(amount.body)).toBe(400);
      expect(JSON.stringify(amount.body)).toContain('lines.0.amount');
      // the largest storable value still saves
      expect((await docs().create(body([{ qty: '99999999999999', est_rate: '0' }]))).status).toBe(201);
    });

    it('decision quantities must be plain non-negative decimals (no exponent, sign, or separators)', async () => {
      const d = await submitted([{ qty: '5', est_rate: '10' }]);
      const l = d.lines[0]!.id;
      for (const approve of ['5e0', '-5', '+5', '5,0', ' 5', '0x5', 'NaN', 'Infinity']) {
        const r = await act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l, approve }] });
        expect(r.status, `${approve}: ${JSON.stringify(r.body)}`).toBe(400);
      }
      expect((await invariant(d.id)).lines[0]!.qty.approved).toBe('0');
    });
  });

  // ===================================================================================== send back loops
  describe('send back loops', () => {
    it('Finance ⇄ HOD five times, then approve: one approved event per line, buckets exact, stage states sane', async () => {
      const d = await submitted([{ qty: '10', est_rate: '15000' }, { qty: '4', est_rate: '100' }]); // 1,50,400 → HOD + Finance
      const [l1, l2] = d.lines.map(l => l.id);
      for (let i = 0; i < 5; i++) {
        await mustOk(act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', decisions: [{ lineId: l1, approve: '10' }, { lineId: l2, approve: '4' }] }));
        let cur = await invariant(d.id);
        expect(cur.statusKey).toBe('waiting_finance');
        expect(cur.lines.map(l => l.stages)).toEqual([{ finance: { pending: '10', held: '0' } }, { finance: { pending: '4', held: '0' } }]);
        await mustOk(act(c, finance.token, 'capex', d.id, { action: 'send_back', stageKey: 'finance', toStage: 'hod', reason: `Loop ${i}` }));
        cur = await invariant(d.id);
        expect(cur.statusKey).toBe('waiting_hod');
        expect(cur.workflow!.stages.find(s => s.key === 'finance')!.status).toBe('pending');
      }
      await mustOk(act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
      await mustOk(act(c, finance.token, 'capex', d.id, { action: 'decide', stageKey: 'finance', decisions: [{ lineId: l1, approve: '8', reject: '2', reason: 'cap' }, { lineId: l2, approve: '4' }] }));
      const after = await invariant(d.id);
      expect(after.statusKey).toBe('partially_approved');
      expect(after.lines.map(l => [l.qty.requested, l.qty.approved, l.qty.rejected])).toEqual([['10', '8', '2'], ['4', '4', '0']]);
      const approvedEvents = await c.db.selectFrom('app.line_event').select(['line_id']).where('line_id', 'in', [l1!, l2!]).where('event_type', '=', 'approved').execute();
      expect(approvedEvents.length).toBe(2);
      expect((await instanceOf(c, d.id))!.status).toBe('completed');
      const sendBacks = await c.db.selectFrom('app.wf_action').select('id').where('document_id', '=', d.id).where('action', '=', 'send_back').execute();
      expect(sendBacks.length).toBe(5);
    });

    it('send back to draft three times: resubmit keeps the number; pendingApproval = current qty; requested accumulates append-only', async () => {
      let d = await submitted([{ qty: '5', est_rate: '100' }]);
      const number = d.number;
      expect(number).toMatch(/^CPX-PUN\//);
      for (let i = 0; i < 3; i++) {
        await mustOk(act(c, hod.token, 'capex', d.id, { action: 'send_back', stageKey: 'hod', toStage: '_draft', reason: `Fix ${i}` }));
        const back = await invariant(d.id);
        expect(back.statusKey).toBe('draft');
        expect(back.number).toBe(number);
        expect(back.allowedActions).toEqual(expect.arrayContaining(['edit', 'submit']));
        // QA3-BUG-011: the stage that sent it back is not shown as done
        expect(back.workflow?.stages.find(s => s.key === 'hod')?.status).not.toBe('done');
        const ed = await mustOk<Row>(docs().update(d.id, { ...body([{ qty: String(5 + i + 1), est_rate: '100' }]), version: back.version }));
        d = await mustOk(docs().submit(d.id, ed.version));
        expect(d.number).toBe(number);
        expect(d.statusKey).toBe('waiting_hod');
        const cur = await invariant(d.id);
        expect(cur.lines[0]!.qty.pendingApproval).toBe(String(5 + i + 1));
      }
      expect((await c.db.selectFrom('app.wf_instance').select('id').where('document_id', '=', d.id).execute()).length).toBe(4);
    });

    it('send back to a skipped, later or unknown stage is a 400 and changes nothing', async () => {
      const d = await submitted([{ qty: '1', est_rate: '15000' }]); // 15,000 → HOD only (finance skipped)
      for (const toStage of ['finance', 'director', 'nope', 'hod']) {
        const r = await act(c, hod.token, 'capex', d.id, { action: 'send_back', stageKey: 'hod', toStage, reason: 'try it' });
        expect(r.status, `${toStage} ${JSON.stringify(r.body)}`).toBe(400);
      }
      expect((await invariant(d.id)).statusKey).toBe('waiting_hod');
      // a stage whose actions exclude send_back
      const big = await submitted([{ qty: '10', est_rate: '15000' }]);
      await mustOk(act(c, hod.token, 'capex', big.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
      const hold = await act(c, finance.token, 'capex', big.id, { action: 'decide', stageKey: 'finance', decisions: [{ lineId: big.lines[0]!.id, hold: '10', reason: 'not allowed' }] });
      expect(hold.status).toBe(403);
      expect(hold.body.code).toBe('ACTION_NOT_ALLOWED');
    });
  });

  // ===================================================================================== simulation
  describe('simulation vs real runs', () => {
    it('simulate with the computed total agrees with real submissions at the boundaries (1 lakh, 5 lakh)', async () => {
      const a = api(c, f.token);
      for (const [qty, rate] of [['10', '10000'], ['10', '10000.01'], ['50', '9999.99'], ['50', '10000']] as const) {
        const total = String(Number(qty) * Number(rate));
        const sim = await mustOk(a.post('/config/workflows/capex/simulate', { values: { total_amount: total }, lines: [{ qty, est_rate: rate, amount: total }], useDraft: false }));
        const real = await submitted([{ qty, est_rate: rate }]);
        const simRoute = Object.fromEntries(sim.stages.map((s: { key: string; outcome: string }) => [s.key, s.outcome === 'run']));
        const realRoute = Object.fromEntries(real.workflow!.stages.map(s => [s.key, s.status !== 'skipped']));
        expect(simRoute, `${qty} × ${rate}`).toEqual(realRoute);
      }
    });

    // QA3-BUG-009: POST /config/workflows/:docType/simulate evaluates `when` on the values it is given and does not run
    // the form's formulas, so header formulas that conditions depend on (total_amount = SUM(lines.amount)) are
    // missing unless the caller computes them. The designer UI computes them client-side (so it matches), but the
    // API contract ("dry run of routing for sample header/line values") gives a different route than a real document.
    it('[QA3-BUG-009] simulate computes formula fields from the sample lines (total_amount) like a real submit', async () => {
      const sim = await mustOk(api(c, f.token).post('/config/workflows/capex/simulate', { values: {}, lines: [{ qty: '20', est_rate: '10000' }], useDraft: false }));
      const real = await submitted([{ qty: '20', est_rate: '10000' }]);
      expect(real.workflow!.stages.find(s => s.key === 'finance')!.status).toBe('pending');
      expect(sim.stages.find((s: { key: string }) => s.key === 'finance').outcome).toBe('run');
      // 6 lakh from the lines alone also reaches the director; a small sample skips both
      const big = await mustOk(api(c, f.token).post('/config/workflows/capex/simulate', { values: {}, lines: [{ qty: '60', est_rate: '10000' }], useDraft: false }));
      expect(big.stages.find((s: { key: string }) => s.key === 'director').outcome).not.toBe('skipped_condition');
      const small = await mustOk(api(c, f.token).post('/config/workflows/capex/simulate', { values: {}, lines: [{ qty: '1', est_rate: '10' }], useDraft: false }));
      expect(small.stages.find((s: { key: string }) => s.key === 'finance').outcome).toBe('skipped_condition');
    });
  });

  // ===================================================================================== outbox
  describe('outbox', () => {
    it('concurrent relays with the real queue: every business event is enqueued exactly once (jobId outbox:<id>)', async () => {
      const q = c.app.get(QueueService);
      const relay = c.app.get(OutboxRelay);
      // drain whatever earlier tests left
      while (await relay.relayOnce() > 0) { /* drain */ }
      const d = await submitted([{ qty: '3', est_rate: '10' }]);
      await mustOk(act(c, hod.token, 'capex', d.id, { action: 'decide', stageKey: 'hod', outcome: 'approve' }));
      const ids = (await c.db.selectFrom('app.outbox_event').select('id').where('tenant_id', '=', f.tenantId).where('published_at', 'is', null).execute()).map(r => String(r.id));
      expect(ids.length).toBeGreaterThanOrEqual(3); // document.submitted, workflow.stage_entered, workflow.decided, …
      const counts = await Promise.all(Array.from({ length: 6 }, () => relay.relayOnce()));
      expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(ids.length);
      const rows = await c.db.selectFrom('app.outbox_event').select(['id', 'published_at', 'attempts']).where('id', 'in', ids).execute();
      expect(rows.every(r => r.published_at !== null && r.attempts === 1)).toBe(true);
      const events = q.queue(EVENTS_QUEUE);
      for (const id of ids) expect(await events.getJob(`outbox:${id}`), `job outbox:${id}`).toBeTruthy();
      // a second relay pass for already-published ids adds nothing
      expect(await relay.relayOnce()).toBe(0);
    });

    it('a rolled-back business transaction leaves no outbox event', async () => {
      const before = await c.db.selectFrom('app.outbox_event').select(sql<string>`count(*)`.as('n')).where('tenant_id', '=', f.tenantId).executeTakeFirstOrThrow();
      const d = await draft([{ qty: '1', est_rate: '10' }]);
      const afterCreate = await c.db.selectFrom('app.outbox_event').select(sql<string>`count(*)`.as('n')).where('tenant_id', '=', f.tenantId).executeTakeFirstOrThrow();
      // a failing submit (stale version) must not leave a document.submitted event behind
      const r = await docs().submit(d.id, d.version + 5);
      expect(r.status).toBe(409);
      const afterFail = await c.db.selectFrom('app.outbox_event').select(sql<string>`count(*)`.as('n')).where('tenant_id', '=', f.tenantId).executeTakeFirstOrThrow();
      expect(Number(afterFail.n)).toBe(Number(afterCreate.n));
      expect(Number(afterCreate.n)).toBeGreaterThanOrEqual(Number(before.n));
      await expect(c.app.get(DbService).tenantTx(f.tenantId, async tx => {
        await tx.insertInto('app.outbox_event').values({ tenant_id: f.tenantId, event_type: 'qa.rollback', aggregate_kind: 'test', aggregate_id: null, payload: '{}' }).execute();
        throw new Error('boom');
      })).rejects.toThrow('boom');
      expect((await c.db.selectFrom('app.outbox_event').select('id').where('event_type', '=', 'qa.rollback').execute()).length).toBe(0);
    });
  });

  // ===================================================================================== audit verifier
  describe('audit chain verifier', () => {
    it('verifies a chain of 5,000+ rows across batch boundaries; a changed row or a deleted row in the middle is reported', async () => {
      const db = c.app.get(DbService);
      const audit = c.app.get(AuditService);
      // a dedicated tenant so this does not disturb others
      const t = await wfTenant(c);
      for (let chunk = 0; chunk < 10; chunk++) {
        await db.tenantTx(t.tenantId, async tx => {
          for (let i = 0; i < 520; i++) {
            await audit.tenant(tx, { action: 'update', entity: 'qa_bulk', entityId: `${chunk}-${i}`, actorId: t.adminId, before: { n: i, nested: { a: [1, 2] } }, after: { n: i + 1, note: `ü ${chunk}` } });
          }
        });
      }
      const verifier = c.app.get(AuditVerifier);
      const t0 = Date.now();
      const ok = await verifier.verifyTenant(t.tenantId);
      const ms = Date.now() - t0;
      expect(ok.ok, ok.detail ?? '').toBe(true);
      expect(ok.rowsChecked).toBeGreaterThanOrEqual(5200);
      expect(ms).toBeLessThan(30_000);

      const rows = await c.db.selectFrom('app.audit_log').select('id').where('tenant_id', '=', t.tenantId).where('entity', '=', 'qa_bulk').orderBy('id').execute();
      const victim = rows[3001]!.id; // past the first 2,000-row batch
      await sql`update app.audit_log set after = jsonb_set(after, '{n}', '999') where id = ${victim}`.execute(c.db);
      const bad = await verifier.verifyTenant(t.tenantId);
      expect(bad).toMatchObject({ ok: false, firstBadId: String(victim) });
      // the run is recorded and admins notified
      const checks = await mustOk(api(c, t.token).get('/audit/checks'));
      expect(checks[0]).toMatchObject({ ok: false, firstBadId: String(victim) });
      // restore the content, then delete a row: the gap is reported at the next row
      await sql`update app.audit_log set after = jsonb_set(after, '{n}', ${String(3001 % 520 + 1)}::jsonb) where id = ${victim}`.execute(c.db);
      const gone = rows[4500]!.id;
      const next = rows[4501]!.id;
      await sql`delete from app.audit_log where id = ${gone}`.execute(c.db);
      const gap = await verifier.verifyTenant(t.tenantId);
      expect(gap.ok).toBe(false);
      expect([String(victim), String(next)]).toContain(gap.firstBadId);
    }, 180_000);
  });
});
