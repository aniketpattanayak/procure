import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import {
  addStageViews, ALL_CAPEX_KEYS, capexBody, createCapexType, docsApi, docsTenant, DocsFixture, docUser, FakeWorkflow, submittedCapex, workflowLink,
} from './documents-helpers';

describe('documents', () => {
  let c: Ctx;
  let f: DocsFixture;

  beforeAll(async () => {
    c = await bootApp();
    workflowLink(c).override(null);
    f = await docsTenant(c);
    await createCapexType(c, f.token);
  });
  afterAll(async () => {
    workflowLink(c).override(undefined);
    await closeApp(c);
  });

  describe('save pipeline', () => {
    it('creates a draft: formulas computed (amount = qty * est_rate, total = SUM(lines.amount)), uom autofilled, refs', async () => {
      const d = docsApi(c, f.token);
      const doc = await mustOk(d.create(capexBody(f)), 201);
      expect(doc).toMatchObject({ docTypeKey: 'capex', number: null, statusKey: 'draft', statusLabel: 'Draft', isLocked: false });
      expect(doc.values).toMatchObject({ location: f.pune, purpose: 'New laptops for the design team', priority: 'Normal', doc_date: '2026-10-01', total_amount: '120000.00' });
      expect(doc.lines).toHaveLength(2);
      expect(doc.lines[0]).toMatchObject({ lineNo: 1, statusKey: 'draft' });
      expect(doc.lines[0].values).toMatchObject({ item: f.items[0], uom: f.uom, qty: '2.000', est_rate: '50000.00', amount: '100000.00' });
      expect(doc.lines[1].values.amount).toBe('20000.00');
      expect(Object.values(doc.refs.location)[0]).toMatch(/Pune plant/);
      expect(Object.keys(doc.lines[0].refs.item)).toEqual([f.items[0]]);
      expect(doc.lines[0].qty).toMatchObject({ requested: '0', pendingApproval: '0' });
      expect(doc.allowedActions).toEqual(expect.arrayContaining(['edit', 'delete', 'submit', 'copy', 'comment', 'attach']));
      const row = await c.db.selectFrom('app.document').selectAll().where('id', '=', doc.id).executeTakeFirstOrThrow();
      expect(row.total_amount).toBe('120000.0000');
      expect(row.custom).toEqual({ purpose: 'New laptops for the design team', priority: 'Normal' });
      const refs = await c.db.selectFrom('app.record_ref').select(['from_field', 'to_id']).where('from_id', '=', doc.id).execute();
      expect(refs.map(r => r.from_field).sort()).toEqual(['lines.item', 'lines.item', 'lines.uom', 'location']);
    });

    it('validates header + lines with paths (required, visibleWhen/requiredWhen, types, unknown records)', async () => {
      const d = docsApi(c, f.token);
      const r = await d.create({
        values: { location: f.pune, priority: 'Urgent' },
        lines: [{ values: { item: f.items[0], qty: 'abc', est_rate: '10' } }, { values: { item: '00000000-0000-4000-8000-000000000000', qty: '1' } }],
      });
      expect(r.status).toBe(400);
      const paths = r.body.errors.map((e: { path: string }) => e.path).sort();
      expect(paths).toEqual(['justification', 'lines.0.qty', 'lines.1.est_rate', 'lines.1.item', 'purpose']);
      // justification is only required (and visible) when Urgent
      const ok = await d.create(capexBody(f, { values: { priority: 'Urgent', justification: 'Old ones broke' } }));
      expect(ok.status).toBe(201);
      const missingLoc = await d.create({ values: { purpose: 'x' }, lines: [] });
      expect(missingLoc.status).toBe(400);
      expect(missingLoc.body.errors.map((e: { path: string }) => e.path)).toContain('location');
    });

    it('drafts may omit quantities; submit requires lines with qty > 0', async () => {
      const d = docsApi(c, f.token);
      const empty = await mustOk(d.create({ values: { location: f.pune, purpose: 'Later' }, lines: [] }), 201);
      const r = await d.submit(empty.id, empty.version);
      expect(r.status).toBe(400);
      expect(r.body.errors.map((e: { path: string }) => e.path)).toContain('lines');
      const zero = await mustOk(d.create(capexBody(f, { lines: [{ qty: '0', est_rate: '5' }] })), 201);
      const r2 = await d.submit(zero.id, zero.version);
      expect(r2.status).toBe(400);
      expect(r2.body.errors.map((e: { path: string }) => e.path)).toEqual(['lines.0.qty']);
    });

    it('edits a draft: lines omitted are deleted, new lines added, version conflicts detected', async () => {
      const d = docsApi(c, f.token);
      const doc = await mustOk(d.create(capexBody(f)), 201);
      const keep = doc.lines[1];
      const upd = await mustOk(d.update(doc.id, {
        version: doc.version, values: { ...doc.values, purpose: 'Changed' },
        lines: [{ id: keep.id, values: { ...keep.values, qty: '3' } }, { values: { item: f.items[0], qty: '1', est_rate: '1000' } }],
      }));
      expect(upd.values.purpose).toBe('Changed');
      expect(upd.lines.map((l: { id: string; lineNo: number }) => [l.id === keep.id, l.lineNo])).toEqual([[true, 1], [false, 2]]);
      expect(upd.values.total_amount).toBe('61000.00');
      expect((await d.update(doc.id, { version: doc.version, values: doc.values, lines: [] })).status).toBe(409);
      const foreign = await d.update(doc.id, { version: upd.version, values: upd.values, lines: [{ id: doc.lines[0].id, values: {} }] });
      expect(foreign.status).toBe(400);
      const deleted = await c.db.selectFrom('app.document_line').select('is_deleted').where('id', '=', doc.lines[0].id).executeTakeFirstOrThrow();
      expect(deleted.is_deleted).toBe(true);
    });

    it('re-saves a draft on the current form version; a submitted document keeps its version', async () => {
      const d = docsApi(c, f.token);
      const a = api(c, f.token);
      const draft = await mustOk(d.create(capexBody(f)), 201);
      const sub = await submittedCapex(c, f);
      const form = await mustOk(a.get('/config/forms/capex_header'));
      const saved = await mustOk(a.put('/config/forms/capex_header/draft', { definition: { fields: [...form.published.fields, { key: 'cost_centre', type: 'text', label: 'Cost centre' }] }, version: form.version }));
      await mustOk(a.post('/config/forms/capex_header/publish', { version: saved.version }));
      const after = await mustOk(d.update(draft.id, { version: draft.version, values: { ...draft.values, cost_centre: 'CC-1' }, lines: draft.lines.map((l: { id: string; values: unknown }) => ({ id: l.id, values: l.values })) }));
      expect(after.formVersionId).not.toBe(draft.formVersionId);
      expect(after.values.cost_centre).toBe('CC-1');
      const again = await mustOk(d.get(sub.id));
      expect(again.formVersionId).toBe(sub.formVersionId);
    });
  });

  describe('field access and scope', () => {
    it('hidden header/line fields are not returned; read-only ones cannot be changed (403)', async () => {
      const u = await docUser(c, f, ALL_CAPEX_KEYS());
      await c.db.insertInto('app.field_access').values([
        { tenant_id: f.tenantId, role_id: u.roleId, form_key: 'capex_header', field_key: 'priority', mode: 'readonly' },
        { tenant_id: f.tenantId, role_id: u.roleId, form_key: 'capex_line', field_key: 'remarks', mode: 'hidden' },
      ]).execute();
      await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
      const d = docsApi(c, u.token);
      const doc = await mustOk(d.create(capexBody(f, { lines: [{ qty: '1', est_rate: '10' }] })), 201);
      expect(doc.values.priority).toBe('Normal');
      const changed = await d.update(doc.id, { version: doc.version, values: { ...doc.values, priority: 'Urgent' }, lines: doc.lines.map((l: { id: string; values: unknown }) => ({ id: l.id, values: l.values })) });
      expect(changed.status).toBe(403);
      expect(changed.body.code).toBe('FIELD_READ_ONLY');
      // admin writes a remark; the restricted user never sees it and keeps it when saving
      const admin = docsApi(c, f.token);
      const full = await mustOk(admin.get(doc.id));
      const withRemark = await mustOk(admin.update(doc.id, { version: full.version, values: full.values, lines: [{ id: full.lines[0].id, values: { ...full.lines[0].values, remarks: 'secret' } }] }));
      const seen = await mustOk(d.get(doc.id));
      expect(seen.lines[0].values).not.toHaveProperty('remarks');
      await mustOk(d.update(doc.id, { version: seen.version, values: seen.values, lines: [{ id: seen.lines[0].id, values: { ...seen.lines[0].values, est_rate: '11' } }] }));
      expect((await mustOk(admin.get(doc.id))).lines[0].values.remarks).toBe('secret');
      expect(withRemark.version).toBeGreaterThan(full.version);
      const writeHidden = await d.update(doc.id, { version: seen.version + 1, values: seen.values, lines: [{ id: seen.lines[0].id, values: { ...seen.lines[0].values, remarks: 'mine' } }] });
      expect(writeHidden.status).toBe(403);
    });

    it('documents outside the scope are 404; creating outside the scope is refused', async () => {
      const u = await docUser(c, f, ALL_CAPEX_KEYS(), f.pune);
      const d = docsApi(c, u.token);
      const chennaiDoc = await mustOk(docsApi(c, f.token).create(capexBody(f, { location: f.chennai })), 201);
      expect((await d.get(chennaiDoc.id)).status).toBe(404);
      expect((await d.update(chennaiDoc.id, { version: chennaiDoc.version, values: {}, lines: [] })).status).toBe(404);
      expect((await d.raw.post(`/docs/capex/${chennaiDoc.id}/comments`, { body: 'hi' })).status).toBe(404);
      const out = await d.create(capexBody(f, { location: f.chennai }));
      expect([400, 403]).toContain(out.status);
      const inScope = await mustOk(d.create(capexBody(f, { location: f.puneMain })), 201);
      expect((await mustOk(d.get(inScope.id))).id).toBe(inScope.id);
      const list = await mustOk(d.list('limit=200'));
      expect(list.data.map((x: { id: string }) => x.id)).not.toContain(chennaiDoc.id);
    });

    it('needs the action keys: view-only users cannot create/edit/submit; missing status views hide documents', async () => {
      const viewer = await docUser(c, f, ['doc.capex:action.view', 'doc.capex:view.approved']);
      const d = docsApi(c, viewer.token);
      expect((await d.create(capexBody(f))).status).toBe(403);
      const draft = await mustOk(docsApi(c, f.token).create(capexBody(f)), 201);
      expect((await d.get(draft.id)).status).toBe(404);
      const sub = await submittedCapex(c, f);
      const seen = await mustOk(d.get(sub.id));
      expect(seen.allowedActions).toEqual([]);
      expect((await d.submit(draft.id, draft.version)).status).toBe(403);
      expect((await d.list('status=draft')).status).toBe(403);
      const nobody = await docUser(c, f, ['master.item:action.view']);
      expect((await docsApi(c, nobody.token).list()).status).toBe(404);
    });
  });

  describe('submit, edit rules, delete, copy', () => {
    it('submit assigns a number, writes requested + approved (no workflow), locks and audits', async () => {
      const sub = await submittedCapex(c, f);
      expect(sub.number).toMatch(/^CAPEX\/PUN-\w+\/26-27\/\d{4}$/);
      expect(sub).toMatchObject({ statusKey: 'approved', statusLabel: 'Approved', isLocked: true });
      expect(sub.submittedBy.id).toBe(f.adminId);
      expect(sub.lines[0].qty).toMatchObject({ requested: '2', approved: '2', pendingApproval: '0', pendingOrder: '2' });
      expect(sub.lines.map((l: { statusKey: string }) => l.statusKey)).toEqual(['approved', 'approved']);
      expect(sub.allowedActions).toEqual(expect.arrayContaining(['close', 'copy']));
      expect(sub.allowedActions).not.toContain('edit');
      const ev = await c.db.selectFrom('app.line_event').select(['event_type', 'qty']).where('document_id', '=', sub.id).orderBy('id').execute();
      expect(ev.map(e => e.event_type)).toEqual(['requested', 'requested', 'approved', 'approved']);
      const audit = await c.db.selectFrom('app.audit_log').select('action').where('entity', '=', 'document').where('entity_id', '=', sub.id).orderBy('id').execute();
      expect(audit.map(a => a.action)).toEqual(['create', 'status', 'submit']);
      const out = await c.db.selectFrom('app.outbox_event').select('event_type').where('aggregate_id', '=', sub.id).orderBy('id').execute();
      expect(out.map(o => o.event_type)).toEqual(['document.created', 'document.status_changed', 'document.submitted']);
      const d = docsApi(c, f.token);
      expect((await d.update(sub.id, { version: sub.version, values: sub.values, lines: [] })).status).toBe(409);
      expect((await d.submit(sub.id, sub.version)).status).toBe(409);
      expect((await d.raw.del(`/docs/capex/${sub.id}`)).status).toBe(409);
    });

    it('editable statuses: a non-draft status in settings allows editing custom fields but not lines/qty', async () => {
      const a = api(c, f.token);
      const fake = new FakeWorkflow();
      workflowLink(c).override(fake);
      try {
        await addStageViews(c, f, 'capex', ['hod', 'finance']);
        const t = (await mustOk(a.get('/doc-types'))).find((x: { key: string }) => x.key === 'capex');
        await mustOk(a.put('/config/doc-types/capex', { settings: { ...t.settings, editableStatuses: ['draft', 'waiting_hod'] }, version: t.version }));
        const sub = await submittedCapex(c, f);
        expect(sub.statusKey).toBe('waiting_hod');
        expect(sub.statusLabel).toBe('Waiting for HOD approval');
        // locked on submit -> not editable until the workflow unlocks
        expect(sub.allowedActions).not.toContain('edit');
        await c.db.updateTable('app.document').set({ is_locked: false }).where('id', '=', sub.id).execute();
        const cur = await mustOk(docsApi(c, f.token).get(sub.id));
        expect(cur.allowedActions).toContain('edit');
        const d = docsApi(c, f.token);
        const ok = await mustOk(d.update(sub.id, { version: cur.version, values: { ...cur.values, purpose: 'Edited while waiting' }, lines: [{ id: cur.lines[0].id, values: { ...cur.lines[0].values, remarks: 'r' } }] }));
        expect(ok.values.purpose).toBe('Edited while waiting');
        expect(ok.lines).toHaveLength(2);
        expect(ok.lines[0].values.remarks).toBe('r');
        const qty = await d.update(sub.id, { version: ok.version, values: ok.values, lines: [{ id: ok.lines[0].id, values: { ...ok.lines[0].values, qty: '5' } }] });
        expect(qty.status).toBe(409);
        const add = await d.update(sub.id, { version: ok.version, values: ok.values, lines: [{ values: { item: f.items[0], qty: '1', est_rate: '1' } }] });
        expect(add.status).toBe(409);
        await mustOk(a.put('/config/doc-types/capex', { settings: { ...t.settings, editableStatuses: ['draft'] }, version: t.version + 1 }));
      } finally {
        workflowLink(c).override(null);
      }
    });

    it('deletes drafts only (soft delete)', async () => {
      const d = docsApi(c, f.token);
      const doc = await mustOk(d.create(capexBody(f)), 201);
      expect((await d.raw.del(`/docs/capex/${doc.id}`)).status).toBe(204);
      expect((await d.get(doc.id)).status).toBe(404);
      const row = await c.db.selectFrom('app.document').select('is_deleted').where('id', '=', doc.id).executeTakeFirstOrThrow();
      expect(row.is_deleted).toBe(true);
    });

    it('copies a document into a new draft without number', async () => {
      const sub = await submittedCapex(c, f, { values: { priority: 'Urgent', justification: 'Because' } });
      const copy = await mustOk(api(c, f.token).post(`/docs/capex/${sub.id}/copy`), 201);
      expect(copy).toMatchObject({ statusKey: 'draft', number: null });
      expect(copy.id).not.toBe(sub.id);
      expect(copy.values).toMatchObject({ purpose: sub.values.purpose, priority: 'Urgent', justification: 'Because', total_amount: sub.values.total_amount });
      expect(copy.lines.map((l: { values: { qty: string } }) => l.values.qty)).toEqual(sub.lines.map((l: { values: { qty: string } }) => l.values.qty));
      const audit = await c.db.selectFrom('app.audit_log').select(['action', 'after']).where('entity_id', '=', copy.id).executeTakeFirstOrThrow();
      expect(audit.action).toBe('copy');
      expect((audit.after as { copiedFrom: string }).copiedFrom).toBe(sub.id);
      const noCopy = await docUser(c, f, ALL_CAPEX_KEYS().filter(k => !k.endsWith('copy')));
      expect((await api(c, noCopy.token).post(`/docs/capex/${sub.id}/copy`)).status).toBe(403);
    });
  });

  describe('cancel and close', () => {
    it('cancel without a workflow port: nothing pending after auto-approval → 409; close works', async () => {
      const sub = await submittedCapex(c, f);
      const a = api(c, f.token);
      const r = await a.post(`/docs/capex/${sub.id}/cancel`, { reason: 'No longer needed' });
      expect(r.status).toBe(409);
      expect((await a.post(`/docs/capex/${sub.id}/cancel`, { reason: 'x' })).status).toBe(400);
      const closed = await mustOk(a.post(`/docs/capex/${sub.id}/close`, { reason: 'Bought elsewhere' }));
      expect(closed).toMatchObject({ statusKey: 'closed', statusLabel: 'Closed' });
      expect(closed.lines[0].qty).toMatchObject({ approved: '2', shortClosed: '2', pendingOrder: '0' });
      expect((await a.post(`/docs/capex/${sub.id}/close`, { reason: 'again' })).status).toBe(409);
    });

    it('cancel with a workflow port: whole document cancels remaining (pending + held) and calls port.cancel', async () => {
      const fake = new FakeWorkflow();
      workflowLink(c).override(fake);
      try {
        await addStageViews(c, f, 'capex', ['hod', 'finance']);
        const sub = await submittedCapex(c, f);
        expect(sub.statusKey).toBe('waiting_hod');
        expect(sub.lines[0].stages).toEqual({ hod: { pending: '2', held: '0' } });
        expect(sub.allowedActions).toEqual(expect.arrayContaining(['cancel', 'cancel_lines']));
        await fake.decide(c, f.tenantId, sub.id, sub.lines[0].id, 'hod', { approve: 1, hold: 1 });
        const mid = await mustOk(docsApi(c, f.token).get(sub.id));
        expect(mid.lines[0].statusKey).toBe('waiting_finance');
        expect(mid.lines[0].qty).toMatchObject({ held: '1', pendingApproval: '2' });
        expect(mid.statusKey).toBe('waiting_hod');
        const cancelled = await mustOk(api(c, f.token).post(`/docs/capex/${sub.id}/cancel`, { reason: 'Budget frozen' }));
        expect(fake.calls).toContain(`cancel:${sub.id}`);
        expect(cancelled.statusKey).toBe('cancelled');
        expect(cancelled.lines.map((l: { statusKey: string }) => l.statusKey)).toEqual(['cancelled', 'cancelled']);
        expect(cancelled.lines[0].qty).toMatchObject({ requested: '2', cancelled: '2', held: '0', pendingApproval: '0' });
        expect(cancelled.lines[0].cancelledReason).toBe('Budget frozen');
        const ev = await c.db.selectFrom('app.line_event').select(['event_type', 'qty']).where('line_id', '=', sub.lines[0].id).orderBy('id').execute();
        expect(ev.map(e => `${e.event_type}:${Number(e.qty)}`)).toEqual(['requested:2', 'held:1', 'unheld:1', 'cancelled:2']);
        expect((await api(c, f.token).post(`/docs/capex/${sub.id}/cancel`, { reason: 'again' })).status).toBe(409);
      } finally {
        workflowLink(c).override(null);
      }
    });

    it('cancel lines with a workflow port: only those lines, port.linesCancelled; status from the rest', async () => {
      const fake = new FakeWorkflow();
      workflowLink(c).override(fake);
      try {
        const sub = await submittedCapex(c, f);
        const r = await mustOk(api(c, f.token).post(`/docs/capex/${sub.id}/cancel`, { reason: 'Printer not needed', lineIds: [sub.lines[1].id] }));
        expect(fake.calls).toContain(`linesCancelled:${sub.id}:1`);
        expect(r.lines.map((l: { statusKey: string }) => l.statusKey)).toEqual(['waiting_hod', 'cancelled']);
        expect(r.statusKey).toBe('waiting_hod');
        expect((await api(c, f.token).post(`/docs/capex/${sub.id}/cancel`, { reason: 'again', lineIds: [sub.lines[1].id] })).status).toBe(409);
        await fake.decide(c, f.tenantId, sub.id, sub.lines[0].id, 'hod', { approve: 2 });
        await fake.decide(c, f.tenantId, sub.id, sub.lines[0].id, 'finance', { approve: 1, reject: 1 });
        const done = await mustOk(docsApi(c, f.token).get(sub.id));
        expect(done.lines.map((l: { statusKey: string }) => l.statusKey)).toEqual(['partially_approved', 'cancelled']);
        expect(done.statusKey).toBe('partially_approved');
        const t = (await mustOk(api(c, f.token).get('/doc-types'))).find((x: { key: string }) => x.key === 'capex');
        await mustOk(api(c, f.token).put('/config/doc-types/capex', { settings: { ...t.settings, allowLineCancel: false }, version: t.version }));
        const other = await submittedCapex(c, f);
        expect((await api(c, f.token).post(`/docs/capex/${other.id}/cancel`, { reason: 'Nope', lineIds: [other.lines[0].id] })).status).toBe(409);
        expect((await mustOk(docsApi(c, f.token).get(other.id))).allowedActions).not.toContain('cancel_lines');
        await mustOk(api(c, f.token).put('/config/doc-types/capex', { settings: { ...t.settings, allowLineCancel: true }, version: t.version + 1 }));
      } finally {
        workflowLink(c).override(null);
      }
    });

    it('drafts cannot be cancelled', async () => {
      const draft = await mustOk(docsApi(c, f.token).create(capexBody(f)), 201);
      expect((await api(c, f.token).post(`/docs/capex/${draft.id}/cancel`, { reason: 'Nope nope' })).status).toBe(409);
    });
  });
});
