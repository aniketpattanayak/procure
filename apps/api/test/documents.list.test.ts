import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EntitlementsService } from '../src/core/entitlements.service';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import {
  addStageViews, ALL_CAPEX_KEYS, capexBody, createCapexType, docsApi, docsTenant, DocsFixture, docUser, FakeWorkflow, submittedCapex, workflowLink,
} from './documents-helpers';

describe('document lists', () => {
  let c: Ctx;
  let f: DocsFixture;
  const fake = new FakeWorkflow();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    c = await bootApp();
    f = await docsTenant(c);
    await createCapexType(c, f.token);
    await addStageViews(c, f, 'capex', ['hod', 'finance']);
    workflowLink(c).override(fake);
    const d = docsApi(c, f.token);
    // 2 drafts, 3 waiting at hod (one in Chennai, one urgent), 1 partially approved, 1 cancelled
    ids.draft1 = (await mustOk(d.create(capexBody(f, { values: { doc_date: '2026-09-01' } })), 201)).id;
    ids.draft2 = (await mustOk(d.create(capexBody(f, { values: { doc_date: '2026-09-02', purpose: 'Projector for room 4' }, lines: [{ item: f.items[1], qty: '1', est_rate: '30000' }] })), 201)).id;
    ids.w1 = (await submittedCapex(c, f, { values: { doc_date: '2026-10-03' } })).id;
    ids.w2 = (await submittedCapex(c, f, { location: f.chennai, values: { doc_date: '2026-10-04' } })).id;
    ids.w3 = (await submittedCapex(c, f, { location: f.puneMain, values: { doc_date: '2026-10-05', priority: 'Urgent', justification: 'Broken' } })).id;
    const p = await submittedCapex(c, f, { values: { doc_date: '2026-10-06' }, lines: [{ qty: '4', est_rate: '100' }] });
    ids.partial = p.id;
    await fake.decide(c, f.tenantId, p.id, p.lines[0].id, 'hod', { approve: 4 });
    await fake.decide(c, f.tenantId, p.id, p.lines[0].id, 'finance', { approve: 3, reject: 1 });
    const x = await submittedCapex(c, f, { values: { doc_date: '2026-10-07' } });
    ids.cancelled = x.id;
    await mustOk(api(c, f.token).post(`/docs/capex/${x.id}/cancel`, { reason: 'Not needed' }));
  });
  afterAll(async () => {
    workflowLink(c).override(undefined);
    await closeApp(c);
  });

  const idsOf = (page: { data: { id?: string; lineId?: string }[] }) => page.data.map(r => r.id ?? r.lineId);

  it('document-wise: all statuses the caller holds, newest first, row shape', async () => {
    const page = await mustOk(docsApi(c, f.token).list());
    expect(idsOf(page)).toEqual([ids.cancelled, ids.partial, ids.w3, ids.w2, ids.w1, ids.draft2, ids.draft1]);
    const w3 = page.data.find((r: { id: string }) => r.id === ids.w3);
    expect(w3).toMatchObject({ statusKey: 'waiting_hod', statusLabel: 'Waiting for HOD approval', docDate: '2026-10-05', totalAmount: '120000.0000', lineCount: 2, overdue: false });
    expect(w3.number).toMatch(/^CAPEX\//);
    expect(w3.location.id).toBe(f.puneMain);
    expect(page.nextCursor).toBeNull();
  });

  it('status filters (single, repeated, comma) and counts per held status', async () => {
    const d = docsApi(c, f.token);
    expect(idsOf(await mustOk(d.list('status=draft')))).toEqual([ids.draft2, ids.draft1]);
    expect(idsOf(await mustOk(d.list('status=waiting_hod&status=cancelled')))).toEqual([ids.cancelled, ids.w3, ids.w2, ids.w1]);
    expect(idsOf(await mustOk(d.list('status=partially_approved,cancelled')))).toEqual([ids.cancelled, ids.partial]);
    const counts = await mustOk(d.counts());
    expect(counts.map((x: { statusKey: string; count: number }) => `${x.statusKey}:${x.count}`)).toEqual([
      'draft:2', 'waiting_hod:3', 'waiting_finance:0', 'on_hold:0', 'partially_approved:1', 'approved:0', 'rejected:0', 'cancelled:1', 'closed:0',
    ]);
    expect(counts.find((x: { statusKey: string }) => x.statusKey === 'waiting_finance').label).toBe('Waiting for Finance review');
    const c2 = await mustOk(d.counts(`location=${f.pune}`));
    expect(c2.find((x: { statusKey: string }) => x.statusKey === 'waiting_hod').count).toBe(2);
  });

  it('filters: location subtree, dates, item, q, f.<field>; bad filters are 400', async () => {
    const d = docsApi(c, f.token);
    expect(idsOf(await mustOk(d.list(`location=${f.chennai}`)))).toEqual([ids.w2]);
    expect(idsOf(await mustOk(d.list(`location=${f.pune}&status=waiting_hod`)))).toEqual([ids.w3, ids.w1]);
    expect(idsOf(await mustOk(d.list('from=2026-10-04&to=2026-10-06')))).toEqual([ids.partial, ids.w3, ids.w2]);
    expect(idsOf(await mustOk(d.list(`item=${f.items[0]}&status=draft`)))).toEqual([ids.draft1]);
    expect(idsOf(await mustOk(d.list('q=projector')))).toEqual([ids.draft2]);
    const num = (await mustOk(d.get(ids.w2))).number as string;
    expect(idsOf(await mustOk(d.list(`q=${encodeURIComponent(num)}`)))).toEqual([ids.w2]);
    expect(idsOf(await mustOk(d.list('f.priority=Urgent')))).toEqual([ids.w3]);
    expect((await d.list('f.nope=1')).status).toBe(400);
    expect((await d.list('sort=nope')).status).toBe(400);
    expect((await d.list('cursor=garbage')).status).toBe(400);
  });

  it('sort + cursor pagination is stable (no duplicates, no gaps) in both directions', async () => {
    const d = docsApi(c, f.token);
    for (const sort of ['doc_date', '-doc_date', 'number', '-total_amount', 'status', '-created_at']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: { id: string }[]; nextCursor: string | null } = await mustOk(d.list(`sort=${sort}&limit=2${cursor ? `&cursor=${cursor}` : ''}`));
        seen.push(...page.data.map(r => r.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen, sort).toHaveLength(7);
      expect(new Set(seen).size, sort).toBe(7);
    }
    const asc = idsOf(await mustOk(d.list('sort=doc_date')));
    expect(asc).toEqual([ids.draft1, ids.draft2, ids.w1, ids.w2, ids.w3, ids.partial, ids.cancelled]);
  });

  it('item-wise view: one row per line with ledger buckets', async () => {
    const d = docsApi(c, f.token);
    const page = await mustOk(d.list(`view=item&status=partially_approved`));
    expect(page.data).toHaveLength(1);
    const r = page.data[0];
    expect(r).toMatchObject({ documentId: ids.partial, lineNo: 1, statusKey: 'partially_approved', statusLabel: 'Partially approved' });
    expect(r.item).toMatchObject({ id: f.items[0], name: 'Laptop' });
    expect(r.qty).toMatchObject({ requested: '4', approved: '3', rejected: '1', pendingApproval: '0', pendingOrder: '3' });
    const waiting = await mustOk(d.list(`view=item&status=waiting_hod&sort=-qty`));
    expect(waiting.data).toHaveLength(6);
    expect(waiting.data[0].qty).toMatchObject({ requested: '2', pendingApproval: '2' });
    const cancelled = await mustOk(d.list('view=item&status=cancelled'));
    expect(cancelled.data.every((x: { qty: { cancelled: string; pendingApproval: string } }) => x.qty.pendingApproval === '0' && Number(x.qty.cancelled) > 0)).toBe(true);
    const byItem = await mustOk(d.list(`view=item&item=${f.items[1]}`));
    expect(new Set(byItem.data.map((x: { item: { id: string } }) => x.item.id))).toEqual(new Set([f.items[1]]));
    const ic = await mustOk(d.counts('view=item'));
    expect(ic.find((x: { statusKey: string }) => x.statusKey === 'waiting_hod').count).toBe(6);
    const paged = await mustOk(d.list('view=item&limit=4&sort=line_no'));
    const next = await mustOk(d.list(`view=item&limit=4&sort=line_no&cursor=${paged.nextCursor}`));
    expect(new Set([...idsOf(paged), ...idsOf(next)]).size).toBe(paged.data.length + next.data.length);
  });

  it('[QA3-BUG-017] item-wise default order (created_at, index-driven page): cursor paging matches one big page, with filters and search', async () => {
    const d = docsApi(c, f.token);
    for (const qs of ['view=item', 'view=item&status=waiting_hod', 'view=item&sort=created_at', 'view=item&q=Laptop', `view=item&item=${f.items[1]}`]) {
      const all = idsOf(await mustOk(d.list(`${qs}&limit=200`)));
      const seen: (string | undefined)[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: { lineId: string }[]; nextCursor: string | null } = await mustOk(d.list(`${qs}&limit=2${cursor ? `&cursor=${cursor}` : ''}`));
        seen.push(...idsOf(page));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen, qs).toEqual(all);
      expect(all.length, qs).toBeGreaterThan(0);
    }
  });

  it('ad-hoc columns=…: system + custom keys with display values, header+line in item view, unknown keys 400, field access honoured', async () => {
    const d = docsApi(c, f.token);
    const page = await mustOk(d.list('status=waiting_hod&columns=location,justification,total_amount,priority'));
    const w3 = page.data.find((r: { id: string }) => r.id === ids.w3);
    expect(w3.columns).toMatchObject({ justification: 'Broken', total_amount: '120000.00', priority: 'Urgent' });
    expect(w3.columns.location).toMatch(/Pune main store/);
    expect(page.data.find((r: { id: string }) => r.id === ids.w1).columns.justification).toBeNull();
    const items = await mustOk(d.list('view=item&status=partially_approved&columns=est_rate,item,amount,purpose,remarks'));
    expect(items.data[0].columns).toMatchObject({ est_rate: '100.00', amount: '400.00', purpose: 'New laptops for the design team', remarks: null });
    expect(items.data[0].columns.item).toMatch(/Laptop/);
    expect((await d.list('columns=nope')).status).toBe(400);
    expect((await d.list('columns=est_rate')).status).toBe(400); // line key in the document view
    expect((await d.list(`columns=${Array.from({ length: 41 }, (_, i) => `c${i}`).join(',')}`)).status).toBe(400);
    const u = await docUser(c, f, [...ALL_CAPEX_KEYS(), 'doc.capex:view.waiting_hod']);
    await c.db.insertInto('app.field_access').values([
      { tenant_id: f.tenantId, role_id: u.roleId, form_key: 'capex_header', field_key: 'justification', mode: 'hidden' },
      { tenant_id: f.tenantId, role_id: u.roleId, form_key: 'capex_line', field_key: 'est_rate', mode: 'hidden' },
    ]).execute();
    await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
    const ud = docsApi(c, u.token);
    const up = await mustOk(ud.list('status=waiting_hod&columns=justification,priority'));
    for (const r of up.data) expect(r.columns).not.toHaveProperty('justification');
    expect(up.data.find((r: { id: string }) => r.id === ids.w3).columns.priority).toBe('Urgent');
    const ui = await mustOk(ud.list('view=item&status=waiting_hod&columns=est_rate,qty'));
    for (const r of ui.data) expect(r.columns).not.toHaveProperty('est_rate');
    expect(ui.data[0].columns.qty).toMatch(/^\d+\.000$/);
  });

  it('restricted users: only held statuses and in-scope locations; requesting other statuses is 403', async () => {
    const u = await docUser(c, f, ['doc.capex:action.view', 'doc.capex:view.waiting_hod', 'doc.capex:view.draft'], f.pune);
    const d = docsApi(c, u.token);
    expect(idsOf(await mustOk(d.list()))).toEqual([ids.w3, ids.w1, ids.draft2, ids.draft1]);
    expect((await d.list('status=cancelled')).status).toBe(403);
    const counts = await mustOk(d.counts());
    expect(counts.map((x: { statusKey: string; count: number }) => `${x.statusKey}:${x.count}`)).toEqual(['draft:2', 'waiting_hod:2']);
  });

  describe('saved views', () => {
    it('personal views: owner only; applied to lists (filters + sort)', async () => {
      const a = api(c, f.token);
      const v = await mustOk(a.post('/saved-views', { scopeKey: 'doc.capex:document', name: 'Urgent Pune', config: { filters: { 'f.priority': 'Urgent', location: f.pune }, sort: 'doc_date' } }), 201);
      expect(v).toMatchObject({ shared: false, isMine: true, isDefault: false });
      expect(idsOf(await mustOk(docsApi(c, f.token).list(`savedView=${v.id}`)))).toEqual([ids.w3]);
      // explicit params win over the view
      expect(idsOf(await mustOk(docsApi(c, f.token).list(`savedView=${v.id}&f.priority=Normal&status=draft`)))).toEqual([ids.draft1, ids.draft2]);
      const other = await docUser(c, f, ALL_CAPEX_KEYS());
      expect((await mustOk(api(c, other.token).get('/saved-views?scope=doc.capex:document'))).map((x: { id: string }) => x.id)).not.toContain(v.id);
      expect((await api(c, other.token).put(`/saved-views/${v.id}`, { scopeKey: 'doc.capex:document', name: 'x', config: { filters: {} }, version: v.version })).status).toBe(404);
      expect((await docsApi(c, other.token).list(`savedView=${v.id}`)).status).toBe(400);
      const upd = await mustOk(a.put(`/saved-views/${v.id}`, { scopeKey: 'doc.capex:document', name: 'Urgent', config: { filters: { 'f.priority': 'Urgent' } }, isDefault: true, version: v.version }));
      expect(upd).toMatchObject({ name: 'Urgent', isDefault: true });
      expect((await a.put(`/saved-views/${v.id}`, { scopeKey: 'doc.capex:document', name: 'Stale', config: { filters: {} }, version: v.version })).status).toBe(409);
      const v2 = await mustOk(a.post('/saved-views', { scopeKey: 'doc.capex:document', name: 'Second', config: { filters: {} }, isDefault: true }), 201);
      const mine = await mustOk(a.get('/saved-views?scope=doc.capex:document'));
      expect(mine.filter((x: { isDefault: boolean }) => x.isDefault).map((x: { id: string }) => x.id)).toEqual([v2.id]);
      expect((await a.del(`/saved-views/${v2.id}`)).status).toBe(204);
    });

    it('shared views: admins or role editors only, need the tab view; role-limited visibility', async () => {
      const a = api(c, f.token);
      const plain = await docUser(c, f, ALL_CAPEX_KEYS());
      expect((await api(c, plain.token).post('/saved-views', { scopeKey: 'doc.capex:document', name: 'Team', config: { filters: {} }, shared: true })).status).toBe(403);
      const sharedAll = await mustOk(a.post('/saved-views', { scopeKey: 'doc.capex:document', name: 'Everyone', config: { filters: { status: 'draft' } }, shared: true }), 201);
      const sharedRole = await mustOk(a.post('/saved-views', { scopeKey: 'doc.capex:document', name: 'Role only', config: { filters: {} }, shared: true, sharedRoleIds: [plain.roleId] }), 201);
      expect(sharedAll).toMatchObject({ shared: true, isMine: true });
      const other = await docUser(c, f, ALL_CAPEX_KEYS());
      const seenPlain = (await mustOk(api(c, plain.token).get('/saved-views?scope=doc.capex:document'))).map((x: { id: string }) => x.id);
      const seenOther = (await mustOk(api(c, other.token).get('/saved-views?scope=doc.capex:document'))).map((x: { id: string }) => x.id);
      expect(seenPlain).toEqual(expect.arrayContaining([sharedAll.id, sharedRole.id]));
      expect(seenOther).toContain(sharedAll.id);
      expect(seenOther).not.toContain(sharedRole.id);
      expect((await api(c, plain.token).del(`/saved-views/${sharedAll.id}`)).status).toBe(403);
      const noTab = await docUser(c, f, ['master.item:action.view']);
      expect((await mustOk(api(c, noTab.token).get('/saved-views'))).map((x: { id: string }) => x.id)).not.toContain(sharedAll.id);
      const bogusRole = await a.post('/saved-views', { scopeKey: 'doc.capex:document', name: 'Bad', config: { filters: {} }, shared: true, sharedRoleIds: ['00000000-0000-4000-8000-000000000000'] });
      expect(bogusRole.status).toBe(400);
      expect(idsOf(await mustOk(docsApi(c, plain.token).list(`savedView=${sharedAll.id}`)))).toEqual([ids.draft2, ids.draft1]);
    });
  });
});
