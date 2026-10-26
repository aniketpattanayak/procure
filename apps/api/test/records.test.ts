import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, closeApp, Ctx } from './helpers';
import { addRecord, api, builderTenant, createMaster, mustOk, publish, userWithKeys } from './forms-helpers';

const lookup = (key: string, label: string, masterKey: string, extra: Record<string, unknown> = {}) =>
  ({ key, label, type: 'lookup', source: { kind: 'master', masterKey }, ...extra });

describe('records: save pipeline, cascades, formulas, access', () => {
  let c: Ctx;
  let token: string;
  let tenantCode: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    c = await bootApp();
    const t = await builderTenant(c);
    token = t.token;
    tenantCode = t.tenant.code;
    await createMaster(c, token, 'cat', [{ key: 'kind', label: 'Kind', type: 'text' }]);
    await createMaster(c, token, 'subcat', [lookup('category', 'Category', 'cat', { required: true })]);
    await createMaster(c, token, 'grade', [lookup('subcategory', 'Sub-category', 'subcat', { required: true }), { key: 'factor', label: 'Factor', type: 'decimal' }], { settings: { listColumns: ['factor'] } });
    for (const [k, n] of [['A', 'Raw'], ['B', 'Packaging'], ['C', 'Consumables']]) ids[k] = (await addRecord(c, token, 'cat', { code: k, name: n, data: { kind: n.toLowerCase() } })).id;
    for (const [k, n, p] of [['D', 'Steel', 'A'], ['E', 'Copper', 'A'], ['H', 'Cartons', 'B']]) ids[k] = (await addRecord(c, token, 'subcat', { code: k, name: n, data: { category: ids[p!] } })).id;
    ids.G1 = (await addRecord(c, token, 'grade', { code: 'G1', name: 'Grade 1', data: { subcategory: ids.D, factor: '1.5' } })).id;
    ids.G2 = (await addRecord(c, token, 'grade', { code: 'G2', name: 'Box grade', data: { subcategory: ids.H, factor: '2' } })).id;
    await createMaster(c, token, 'widget', [
      lookup('category', 'Category', 'cat'),
      lookup('sub_category', 'Sub-category', 'subcat', { filterBy: [{ field: 'category', targetField: 'category' }] }),
      lookup('grade', 'Grade', 'grade', { filterBy: [{ field: 'sub_category', targetField: 'subcategory' }], autofill: [{ from: 'factor', to: 'factor' }] }),
      { key: 'factor', label: 'Factor', type: 'decimal' },
      { key: 'rate', label: 'Rate', type: 'currency' },
      { key: 'qty', label: 'Qty', type: 'decimal' },
      { key: 'value', label: 'Value', type: 'formula', expr: 'rate * qty * COALESCE(factor, 1)', precision: 2 },
      { key: 'urgent', label: 'Urgent', type: 'toggle' },
      { key: 'reason', label: 'Reason', type: 'text', requiredWhen: 'urgent = TRUE' },
      { key: 'serial', label: 'Serial', type: 'text', unique: true },
      { key: 'gstin', label: 'GSTIN', type: 'gstin' },
    ], { settings: { codePattern: 'W-{SEQ:3}' } });
  });
  afterAll(async () => { await closeApp(c); });

  it('formulas are computed server-side; client values ignored; lookups filled in refs; codes generated', async () => {
    const r = await addRecord(c, token, 'widget', {
      name: 'W one', data: { category: ids.A, sub_category: ids.D, grade: ids.G1, factor: '1.5', rate: '100', qty: '3', value: '999999', unknownKey: 'x' },
    });
    expect(r.code).toBe('W-001');
    expect(r.data.value).toBe('450.00');
    expect(r.data.unknownKey).toBeUndefined();
    expect(r.refs.category[ids.A!]).toBe('A - Raw');
    expect(r.refs.grade[ids.G1!]).toBe('G1 - Grade 1');
    const second = await addRecord(c, token, 'widget', { name: 'W two', data: {} });
    expect(second.code).toBe('W-002');
    // record_ref rows written
    const refs = await c.db.selectFrom('app.record_ref').select(['from_field', 'to_id']).where('from_id', '=', r.id).execute();
    expect(refs.map(x => x.from_field).sort()).toEqual(['category', 'grade', 'sub_category']);
  });

  it('server rejects a sub-category that does not belong to the chosen category (3-level chain too)', async () => {
    const a = api(c, token);
    const bad = await a.post('/masters/widget/records', { name: 'X', data: { category: ids.B, sub_category: ids.D } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toEqual([{ path: 'sub_category', message: expect.stringMatching(/does not belong/) }]);
    const noParent = await a.post('/masters/widget/records', { name: 'X', data: { sub_category: ids.D } });
    expect(noParent.body.errors[0].message).toMatch(/choose Category first/);
    const level3 = await a.post('/masters/widget/records', { name: 'X', data: { category: ids.A, sub_category: ids.D, grade: ids.G2 } });
    expect(level3.status).toBe(400);
    expect(level3.body.errors[0].path).toBe('grade');
    // wrong master entirely
    const wrong = await a.post('/masters/widget/records', { name: 'X', data: { category: ids.D } });
    expect(wrong.body.errors[0].message).toMatch(/does not exist/);
  });

  it('cascading options: filter by parent, empty parent = [], include, attrs for autofill, inactive excluded', async () => {
    const a = api(c, token);
    const subA = await mustOk(a.get(`/masters/subcat/options?filter=category:${ids.A}`));
    expect(subA.map((o: { code: string }) => o.code)).toEqual(['E', 'D']); // ordered by name: Copper, Steel
    expect(await mustOk(a.get('/masters/subcat/options?filter=category:'))).toEqual([]);
    // only declared cascade targets may be filtered on (QA2-BUG-004)
    expect((await a.get('/masters/grade/options?filter=factor:1.5')).status).toBe(400);
    expect((await a.get('/masters/grade/options?filter=code:G1')).status).toBe(400);
    expect(await mustOk(a.get(`/masters/subcat/options?filter=category:${ids.C}`))).toEqual([]);
    const grades = await mustOk(a.get(`/masters/grade/options?filter=subcategory:${ids.D}&attrs=factor&attrs=code`));
    expect(grades).toEqual([{ id: ids.G1, code: 'G1', name: 'Grade 1', label: 'G1 - Grade 1', isActive: true, attrs: { factor: '1.50', code: 'G1' } }]);
    await mustOk(a.post(`/masters/subcat/records/${ids.E}/deactivate`));
    const after = await mustOk(a.get(`/masters/subcat/options?filter=category:${ids.A}`));
    expect(after.map((o: { code: string }) => o.code)).toEqual(['D']);
    const incl = await mustOk(a.get(`/masters/subcat/options?filter=category:${ids.A}&include=${ids.E}`));
    expect(incl.map((o: { code: string; isActive: boolean }) => [o.code, o.isActive])).toEqual([['D', true], ['E', false]]);
    const q = await mustOk(a.get('/masters/cat/options?q=pack'));
    expect(q.map((o: { code: string }) => o.code)).toEqual(['B']);
    // inactive targets cannot be newly chosen
    const pick = await a.post('/masters/widget/records', { name: 'X', data: { category: ids.A, sub_category: ids.E } });
    expect(pick.body.errors[0].message).toMatch(/inactive/);
    await mustOk(a.post(`/masters/subcat/records/${ids.E}/activate`));
  });

  it('requiredWhen and plain type errors are reported together with paths', async () => {
    const a = api(c, token);
    const r = await a.post('/masters/widget/records', { name: 'X', data: { urgent: true, rate: 'abc', gstin: '27AAPFU0939F1ZW' } });
    expect(r.status).toBe(400);
    const paths = r.body.errors.map((e: { path: string }) => e.path).sort();
    expect(paths).toEqual(['gstin', 'rate', 'reason']);
    const r2 = await a.post('/masters/widget/records', { name: 'X', data: { urgent: true } });
    expect(r2.body.errors).toEqual([{ path: 'reason', message: 'Reason is required.' }]);
    await addRecord(c, token, 'widget', { name: 'ok', data: { urgent: true, reason: 'line down' } });
  });

  it('unique fields and codes', async () => {
    const a = api(c, token);
    await addRecord(c, token, 'widget', { name: 'S1', data: { serial: 'SN-1' } });
    const dup = await a.post('/masters/widget/records', { name: 'S2', data: { serial: 'sn-1' } });
    expect(dup.status).toBe(409);
    expect(dup.body.errors[0].path).toBe('serial');
    const dupCode = await a.post('/masters/cat/records', { code: 'a', name: 'dup' });
    expect(dupCode.status).toBe(409);
    expect(dupCode.body.errors[0].path).toBe('code');
    const noCode = await a.post('/masters/cat/records', { name: 'no code' });
    expect(noCode.body.errors[0].path).toBe('code');
  });

  it('delete is blocked while referenced (with usage counts); deactivate is allowed; unreferenced delete works', async () => {
    const a = api(c, token);
    const blocked = await a.del(`/masters/cat/records/${ids.A}`, { reason: 'cleanup' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('RECORD_IN_USE');
    expect(blocked.body.meta.usedBy).toEqual(expect.arrayContaining([{ kind: 'master_record', label: 'subcats', count: 2 }, { kind: 'master_record', label: 'widgets', count: 1 }]));
    expect(await mustOk(a.get(`/masters/cat/records/${ids.A}/usage`))).toEqual(blocked.body.meta.usedBy);
    expect((await a.post(`/masters/cat/records/${ids.A}/deactivate`)).status).toBe(200);
    await mustOk(a.post(`/masters/cat/records/${ids.A}/activate`));
    expect((await a.del(`/masters/cat/records/${ids.C}`, {})).status).toBe(400); // reason required
    expect((await a.del(`/masters/cat/records/${ids.C}`, { reason: 'unused' })).status).toBe(204);
    expect((await a.get(`/masters/cat/records/${ids.C}`)).status).toBe(404);
    // the code can be reused after a delete
    ids.C = (await addRecord(c, token, 'cat', { code: 'C', name: 'Consumables' })).id;
  });

  it('lists: views, q prefix search, f.<field> filters, sort by data key, cursor pagination', async () => {
    const a = api(c, token);
    for (let i = 1; i <= 5; i++) await addRecord(c, token, 'grade', { code: `P${i}`, name: `Page ${i}`, data: { subcategory: ids.H, factor: String(10 - i) } });
    const p1 = await mustOk(a.get('/masters/grade/records?limit=3&sort=-factor'));
    expect(p1.data.map((r: { code: string }) => r.code)).toEqual(['P1', 'P2', 'P3']);
    const p2 = await mustOk(a.get(`/masters/grade/records?limit=3&sort=-factor&cursor=${p1.nextCursor}`));
    expect(p2.data.map((r: { code: string }) => r.code)).toEqual(['P4', 'P5', 'G2']);
    const byParent = await mustOk(a.get(`/masters/grade/records?f.subcategory=${ids.D}`));
    expect(byParent.data.map((r: { code: string }) => r.code)).toEqual(['G1']);
    const q = await mustOk(a.get('/masters/grade/records?q=pag 3'));
    expect(q.data.map((r: { code: string }) => r.code)).toEqual(['P3']);
    const qc = await mustOk(a.get('/masters/subcat/records?q=d'));
    expect(qc.data.map((r: { code: string }) => r.code)).toEqual(['D']);
    await mustOk(a.post(`/masters/grade/records/${ids.G2}/deactivate`));
    const inactive = await mustOk(a.get('/masters/grade/records?view=inactive'));
    expect(inactive.data.map((r: { code: string }) => r.code)).toEqual(['G2']);
    const all = await mustOk(a.get('/masters/grade/records?view=all&limit=200'));
    expect(all.data).toHaveLength(7);
    expect((await a.get('/masters/grade/records?sort=nope')).status).toBe(400);
    // data-key sorts only for list columns (QA2-BUG-009)
    expect((await a.get('/masters/widget/records?sort=rate')).status).toBe(400);
    expect((await a.get('/masters/grade/records?f.nope=1')).status).toBe(400);
    await mustOk(a.post(`/masters/grade/records/${ids.G2}/activate`));
  });

  it('permission keys per master: a restricted user can view but not add; views enforced', async () => {
    const u = await userWithKeys(c, token, tenantCode, ['master.cat:action.view', 'master.cat:view.active']);
    const a = api(c, u.token);
    const list = await mustOk(a.get('/masters/cat/records'));
    expect(list.data.length).toBeGreaterThan(0);
    expect((await a.get('/masters/cat/records?view=inactive')).status).toBe(403);
    expect((await a.post('/masters/cat/records', { code: 'Z', name: 'Z' })).status).toBe(403);
    expect((await a.get('/masters/subcat/records')).status).toBe(403);
    const masters = await mustOk(a.get('/masters'));
    expect(masters.map((m: { key: string }) => m.key)).toEqual(['cat']);
    expect((await a.get('/masters/cat/export')).status).toBe(403);
    expect((await a.get('/masters/cat/template.xlsx')).status).toBe(403);
  });

  it('field access: hidden fields omitted, changing read-only/hidden fields is 403 FIELD_READ_ONLY', async () => {
    const r = await addRecord(c, token, 'widget', { name: 'Secret', data: { rate: '10', qty: '2', serial: 'SECRET-1', reason: 'r' } });
    const keys = ['master.widget:action.view', 'master.widget:action.edit', 'master.widget:action.add', 'master.widget:view.active'];
    const u = await userWithKeys(c, token, tenantCode, keys, {
      'master.widget': { fieldAccess: [{ formKey: 'widget', fieldKey: 'rate', mode: 'hidden' }, { formKey: 'widget', fieldKey: 'serial', mode: 'readonly' }] },
    });
    const a = api(c, u.token);
    const got = await mustOk(a.get(`/masters/widget/records/${r.id}`));
    expect(got.data.rate).toBeUndefined();
    expect(got.data.serial).toBe('SECRET-1');
    expect(got.data.value).toBe('20.00');
    // unchanged read-only value + omitted hidden field: fine, hidden value kept
    const ok = await mustOk(a.put(`/masters/widget/records/${r.id}`, { code: got.code, name: 'Secret 2', data: { ...got.data, qty: '3' }, version: got.version }));
    expect(ok.data.value).toBe('30.00');
    const stored = await c.db.selectFrom('app.master_record').select('data').where('id', '=', r.id).executeTakeFirstOrThrow();
    expect((stored.data as { rate: string }).rate).toBe('10.00');
    const ro = await a.put(`/masters/widget/records/${r.id}`, { code: got.code, name: 'x', data: { serial: 'CHANGED' }, version: ok.version });
    expect(ro.status).toBe(403);
    expect(ro.body).toMatchObject({ code: 'FIELD_READ_ONLY', meta: { field: 'serial' } });
    const hidden = await a.put(`/masters/widget/records/${r.id}`, { code: got.code, name: 'x', data: { rate: '1' }, version: ok.version });
    expect(hidden.body).toMatchObject({ code: 'FIELD_READ_ONLY', meta: { field: 'rate' } });
    const created = await a.post('/masters/widget/records', { name: 'new', data: { serial: 'S-NEW' } });
    expect(created.body.meta).toEqual({ field: 'serial' });
    // stale version
    expect((await a.put(`/masters/widget/records/${r.id}`, { code: got.code, name: 'x', data: {}, version: got.version })).status).toBe(409);
    // hidden fields never leak via options attrs
    const opts = await mustOk(a.get('/masters/widget/options?attrs=rate&attrs=qty&limit=1'));
    expect(Object.keys(opts[0].attrs)).toEqual(['qty']);
  });

  it('custom_forms limit counts non-system masters', async () => {
    const t = await builderTenant(c, { custom_forms: 1 });
    await createMaster(c, t.token, 'one');
    const r = await api(c, t.token).post('/config/masters', { key: 'two', name: 'Two', pluralName: 'Twos' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('LIMIT_EXCEEDED.custom_forms');
  });

  it('master designer: update, deactivate (system masters refuse), registry keys', async () => {
    const a = api(c, token);
    const m = (await mustOk(a.get('/masters'))).find((x: { key: string }) => x.key === 'cat');
    const upd = await mustOk(a.put('/config/masters/cat', { pluralName: 'Item Categories', version: m.version }));
    expect(upd.pluralName).toBe('Item Categories');
    const tab = await c.db.selectFrom('app.permission_def').select('label').where('key', '=', 'master.cat').where('tenant_id', '=', m.id ? (await c.db.selectFrom('app.master_def').select('tenant_id').where('id', '=', m.id).executeTakeFirstOrThrow()).tenant_id : '').executeTakeFirstOrThrow();
    expect(tab.label).toBe('Item Categories');
    expect((await a.post('/config/masters/item/deactivate')).status).toBe(409);
    await mustOk(a.post('/config/masters/grade/deactivate'));
    const bad = await publish(c, token, 'widget', [{ key: 'grade', label: 'Grade', type: 'lookup', source: { kind: 'master', masterKey: 'grade' } }]);
    expect(bad.status).toBe(400); // UNKNOWN_MASTER (inactive) — and removing the others is fine
    expect(bad.body.meta.issues.map((i: { code: string }) => i.code)).toEqual(['UNKNOWN_MASTER']);
    expect((await a.post('/masters/grade/records', { code: 'NEW', name: 'n', data: { subcategory: ids.D } })).status).toBe(409);
    await mustOk(a.post('/config/masters/grade/activate'));
    expect((await a.post('/config/masters', { key: 'cat', name: 'Dup', pluralName: 'Dups' })).status).toBe(409);
  });
});
