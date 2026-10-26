import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workflowSentence } from '../src/modules/documents/collaboration.service';
import { parseMentions } from '../src/modules/documents';
import { api, builderTenant, mustOk, PNG_1PX } from './forms-helpers';
import { API, bearer, bootApp, closeApp, Ctx } from './helpers';
import {
  addStageViews, ALL_CAPEX_KEYS, createCapexType, docsApi, docsTenant, DocsFixture, docUser, FakeWorkflow, submittedCapex, workflowLink,
} from './documents-helpers';

describe('mentions + sentences (pure)', () => {
  it('extracts unique mention ids', () => {
    const a = '0190d9d2-3f6a-7c1e-9a1b-1234567890ab';
    expect(parseMentions(`Hi @[Asha K](user:${a}) and @[Asha K](user:${a.toUpperCase()}), see @[x](user:nope)`)).toEqual([a]);
  });
  it('renders workflow actions as sentences', () => {
    const d = (approve: string, hold = '0', reject = '0') => ({ approve, hold, reject });
    expect(workflowSentence('decide', 'HOD approval', [d('2'), d('1'), d('0', '1'), d('0', '0', '3')], null, null)).toBe('Approved 2 lines, held 1, rejected 1 at HOD approval');
    expect(workflowSentence('decide', 'HOD approval', [d('0', '0', '3')], null, null)).toBe('Rejected 1 line at HOD approval');
    expect(workflowSentence('send_back', 'Finance', [], '_draft', null)).toBe('Sent back to the creator from Finance');
    expect(workflowSentence('send_back', 'Finance', [], 'HOD approval', null)).toBe('Sent back to HOD approval from Finance');
    expect(workflowSentence('forward', 'HOD', [], null, 'Ravi')).toBe('Forwarded to Ravi at HOD');
    expect(workflowSentence('auto_approve', '', [], null, null)).toBe('Approved automatically');
  });
});

const KEYS = () => [...ALL_CAPEX_KEYS(), 'doc.capex:view.waiting_hod'];

describe('document collaboration', () => {
  let c: Ctx;
  let f: DocsFixture;
  const fake = new FakeWorkflow();

  beforeAll(async () => {
    c = await bootApp();
    f = await docsTenant(c);
    await createCapexType(c, f.token);
    await addStageViews(c, f, 'capex', ['hod', 'finance']);
    workflowLink(c).override(fake);
  });
  afterAll(async () => {
    workflowLink(c).override(undefined);
    await closeApp(c);
  });

  const upload = async (token: string) => {
    const r = await c.http.post(`${API}/files`).set(bearer(token)).attach('file', PNG_1PX, 'quote.png');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string };
  };

  it('comments with @mentions notify mentioned users (not the author) and emit outbox events', async () => {
    const sub = await submittedCapex(c, f);
    const u = await docUser(c, f, KEYS());
    const a = api(c, f.token);
    const body = `Please check @[Approver](user:${u.userId}) and me @[Admin](user:${f.adminId})`;
    const cm = await mustOk(a.post(`/docs/capex/${sub.id}/comments`, { body }), 201);
    expect(cm).toMatchObject({ body, parentId: null, canEdit: true, editedAt: null });
    expect(cm.mentions.map((m: { id: string }) => m.id).sort()).toEqual([u.userId, f.adminId].sort());
    const notes = await mustOk(api(c, u.token).get('/notifications'));
    const n = notes.data.find((x: { kind: string }) => x.kind === 'mention');
    expect(n).toMatchObject({ link: `/docs/capex/${sub.id}` });
    expect(n.title).toContain(sub.number);
    const adminNotes = await c.db.selectFrom('app.notification').select('id').where('user_id', '=', f.adminId).where('kind', '=', 'mention').execute();
    expect(adminNotes).toHaveLength(0);
    const ob = await c.db.selectFrom('app.outbox_event').select(['event_type', 'payload']).where('aggregate_id', '=', sub.id).where('event_type', 'like', 'comment.%').orderBy('id').execute();
    expect(ob.map(o => o.event_type)).toEqual(['comment.created', 'comment.mentioned']);
    expect((ob[1]!.payload as { userIds: string[] }).userIds).toEqual([u.userId]);
    const reply = await mustOk(api(c, u.token).post(`/docs/capex/${sub.id}/comments`, { body: 'Done', parentId: cm.id }), 201);
    expect(reply.parentId).toBe(cm.id);
    const list = await mustOk(a.get(`/docs/capex/${sub.id}/comments`));
    expect(list.map((x: { id: string; canEdit: boolean }) => [x.id, x.canEdit])).toEqual([[cm.id, true], [reply.id, false]]);
  });

  it('rejects mentions of users of another tenant or inactive users, and bad parents', async () => {
    const sub = await submittedCapex(c, f);
    const other = await builderTenant(c);
    const a = api(c, f.token);
    const r = await a.post(`/docs/capex/${sub.id}/comments`, { body: `hi @[X](user:${other.admin.userId})` });
    expect(r.status).toBe(400);
    const u = await docUser(c, f, ['doc.capex:action.view']);
    await mustOk(a.post(`/users/${u.userId}/deactivate`));
    expect((await a.post(`/docs/capex/${sub.id}/comments`, { body: `hi @[U](user:${u.userId})` })).status).toBe(400);
    expect((await a.post(`/docs/capex/${sub.id}/comments`, { body: 'x', parentId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    const noComment = await docUser(c, f, KEYS().filter(k => !k.endsWith(':action.comment')));
    expect((await api(c, noComment.token).post(`/docs/capex/${sub.id}/comments`, { body: 'x' })).status).toBe(403);
  });

  it('edit: author only, within 15 minutes, notifies newly mentioned; delete is soft', async () => {
    const sub = await submittedCapex(c, f);
    const u = await docUser(c, f, KEYS());
    const a = api(c, f.token);
    const cm = await mustOk(a.post(`/docs/capex/${sub.id}/comments`, { body: 'First' }), 201);
    expect((await api(c, u.token).put(`/docs/capex/${sub.id}/comments/${cm.id}`, { body: 'Hijack' })).status).toBe(403);
    const ed = await mustOk(a.put(`/docs/capex/${sub.id}/comments/${cm.id}`, { body: `First, cc @[U](user:${u.userId})` }));
    expect(ed.editedAt).not.toBeNull();
    const notes = await c.db.selectFrom('app.notification').select('id').where('user_id', '=', u.userId).where('kind', '=', 'mention').execute();
    expect(notes).toHaveLength(1);
    await c.db.updateTable('app.comment').set({ created_at: new Date(Date.now() - 16 * 60 * 1000) }).where('id', '=', cm.id).execute();
    expect((await a.put(`/docs/capex/${sub.id}/comments/${cm.id}`, { body: 'Too late' })).status).toBe(409);
    expect((await api(c, u.token).del(`/docs/capex/${sub.id}/comments/${cm.id}`)).status).toBe(403);
    expect((await a.del(`/docs/capex/${sub.id}/comments/${cm.id}`)).status).toBe(204);
    const list = await mustOk(a.get(`/docs/capex/${sub.id}/comments`));
    expect(list[0]).toMatchObject({ id: cm.id, body: '', mentions: [], canEdit: false });
    expect((await a.del(`/docs/capex/${sub.id}/comments/${cm.id}`)).status).toBe(404);
  });

  it('attachments: clean tenant files only, not already attached; detach frees the file', async () => {
    const sub = await submittedCapex(c, f);
    const a = api(c, f.token);
    const file = await upload(f.token);
    const att = await mustOk(a.post(`/docs/capex/${sub.id}/attachments`, { fileId: file.id, note: 'Vendor quote' }), 201);
    expect(att).toMatchObject({ note: 'Vendor quote', file: { id: file.id, filename: 'quote.png', mime: 'image/png' } });
    expect(att.file.url).toMatch(/\/files\//);
    const row = await c.db.selectFrom('app.file_object').select('attached_to').where('id', '=', file.id).executeTakeFirstOrThrow();
    expect(row.attached_to).toMatchObject({ kind: 'document_attachment', id: sub.id });
    const sub2 = await submittedCapex(c, f);
    expect((await a.post(`/docs/capex/${sub2.id}/attachments`, { fileId: file.id })).status).toBe(400);
    // a pending (unscanned) file and a file of another tenant are rejected
    const pending = await c.db.insertInto('app.file_object').values({ tenant_id: f.tenantId, storage_key: `${f.tenantId}/p/${Date.now()}`, filename: 'p.pdf', mime: 'application/pdf', size_bytes: 3, sha256: 'x', scan_status: 'pending' })
      .returning('id').executeTakeFirstOrThrow();
    const p = await a.post(`/docs/capex/${sub.id}/attachments`, { fileId: pending.id });
    expect(p.status).toBe(400);
    expect(p.body.title).toMatch(/still being scanned/);
    const other = await builderTenant(c);
    const foreign = await upload(other.token);
    expect((await a.post(`/docs/capex/${sub.id}/attachments`, { fileId: foreign.id })).status).toBe(400);
    // editing the document does not detach panel attachments
    expect((await mustOk(a.get(`/docs/capex/${sub.id}/attachments`))).map((x: { id: string }) => x.id)).toEqual([att.id]);
    expect((await a.del(`/docs/capex/${sub.id}/attachments/${att.id}`)).status).toBe(204);
    expect(await mustOk(a.get(`/docs/capex/${sub.id}/attachments`))).toEqual([]);
    await mustOk(a.post(`/docs/capex/${sub2.id}/attachments`, { fileId: file.id }), 201);
    const viewer = await docUser(c, f, ['doc.capex:action.view', 'doc.capex:view.waiting_hod']);
    expect((await api(c, viewer.token).post(`/docs/capex/${sub2.id}/attachments`, { fileId: (await upload(viewer.token)).id })).status).toBe(403);
  });

  it('timeline merges audit, workflow actions (with line decisions), comments, attachments, quantities, status — newest first', async () => {
    const d = docsApi(c, f.token);
    const a = api(c, f.token);
    const draft = await mustOk(d.create({ values: { location: f.pune, purpose: 'Timeline', doc_date: '2026-10-01' }, lines: [{ values: { item: f.items[0], qty: '2', est_rate: '10' } }, { values: { item: f.items[1], qty: '1', est_rate: '5' } }] }), 201);
    const edited = await mustOk(d.update(draft.id, { version: draft.version, values: { ...draft.values, purpose: 'Timeline v2' }, lines: draft.lines.map((l: { id: string; values: unknown }) => ({ id: l.id, values: l.values })) }));
    const sub = await mustOk(d.submit(draft.id, edited.version));
    // a workflow action as the workflow module records it (wf_instance + wf_action rows)
    const ver = await c.db.insertInto('app.workflow_def').values({ tenant_id: f.tenantId, doc_type_id: (await c.db.selectFrom('app.doc_type').select('id').where('tenant_id', '=', f.tenantId).where('key', '=', 'capex').executeTakeFirstOrThrow()).id, name: 'wf' })
      .returning('id').executeTakeFirstOrThrow();
    const wv = await c.db.insertInto('app.workflow_version').values({ tenant_id: f.tenantId, workflow_id: ver.id, version: 1, definition: JSON.stringify({ stages: [] }) }).returning('id').executeTakeFirstOrThrow();
    const inst = await c.db.insertInto('app.wf_instance').values({ tenant_id: f.tenantId, document_id: sub.id, workflow_version_id: wv.id, status: 'running' }).returning('id').executeTakeFirstOrThrow();
    await c.db.insertInto('app.wf_action').values({
      tenant_id: f.tenantId, instance_id: inst.id, document_id: sub.id, stage_key: 'hod', action: 'decide', actor_id: f.adminId, comment: 'Looks fine',
      decisions: JSON.stringify([{ lineId: sub.lines[1].id, approve: '0', hold: '1', reject: '0', reason: 'Wait' }, { lineId: sub.lines[0].id, approve: '2', hold: '0', reject: '0' }]),
      at: new Date(Date.now() + 1000),
    }).execute();
    await new Promise(r => setTimeout(r, 1100));
    await mustOk(a.post(`/docs/capex/${sub.id}/comments`, { body: 'A comment' }), 201);
    const file = await upload(f.token);
    await mustOk(a.post(`/docs/capex/${sub.id}/attachments`, { fileId: file.id }), 201);
    const tl = await mustOk(a.get(`/docs/capex/${sub.id}/timeline`));
    const kinds = tl.map((e: { kind: string }) => e.kind);
    expect(kinds.slice(0, 3)).toEqual(['attachment', 'comment', 'workflow']);
    expect(kinds).toEqual(expect.arrayContaining(['created', 'updated', 'submitted', 'status', 'quantity']));
    expect(kinds[kinds.length - 1]).toBe('created');
    const at = tl.map((e: { at: string }) => e.at);
    expect([...at].sort().reverse()).toEqual(at);
    const wf = tl.find((e: { kind: string }) => e.kind === 'workflow');
    expect(wf).toMatchObject({ title: 'Approved 1 line, held 1 at HOD approval', detail: 'Looks fine', actor: { id: f.adminId } });
    expect(wf.lineDecisions).toEqual([{ lineNo: 1, approve: '2', hold: '0', reject: '0', reason: null }, { lineNo: 2, approve: '0', hold: '1', reject: '0', reason: 'Wait' }]);
    const upd = tl.find((e: { kind: string }) => e.kind === 'updated');
    expect(upd.changes).toEqual([{ field: 'purpose', label: 'Purpose', before: 'Timeline', after: 'Timeline v2' }]);
    expect(tl.find((e: { kind: string }) => e.kind === 'submitted').title).toBe(`Submitted as ${sub.number}`);
    expect(tl.find((e: { kind: string }) => e.kind === 'status').title).toBe('Status changed to Waiting for HOD approval');
    expect(tl.find((e: { kind: string }) => e.kind === 'quantity').title).toBe('Requested 3 on 2 lines');
    expect(tl.find((e: { kind: string }) => e.kind === 'comment').detail).toBe('A comment');
    expect(tl.find((e: { kind: string }) => e.kind === 'attachment').title).toBe('Attached quote.png');
    expect(new Set(tl.map((e: { id: string }) => e.id)).size).toBe(tl.length);
  });
});
