import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { ALL_CAPEX_KEYS, CAPEX_HEADER, createCapexType, docsTenant, DocsFixture, docUser, workflowLink } from './documents-helpers';

describe('document types', () => {
  let c: Ctx;
  let f: DocsFixture;

  beforeAll(async () => {
    c = await bootApp();
    workflowLink(c).override(null);
    f = await docsTenant(c, { custom_forms: 3 });
  });
  afterAll(async () => {
    workflowLink(c).override(undefined);
    await closeApp(c);
  });

  it('creates header + line forms with system fields, static permission keys, a default series', async () => {
    const t = await createCapexType(c, f.token);
    expect(t).toMatchObject({ key: 'capex', kind: 'custom', isActive: true, headerFormKey: 'capex_header', lineFormKey: 'capex_line' });
    expect(t.statuses.map((s: { key: string }) => s.key)).toEqual(['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed']);
    const a = api(c, f.token);
    const header = await mustOk(a.get('/config/forms/capex_header'));
    expect(header.kind).toBe('transaction');
    const hk = header.published.fields.map((x: { key: string }) => x.key);
    expect(hk).toEqual(expect.arrayContaining(['location', 'doc_date', 'required_by', 'total_amount', 'purpose', 'priority', 'justification']));
    const total = header.published.fields.find((x: { key: string }) => x.key === 'total_amount');
    expect(total).toMatchObject({ type: 'formula', expr: 'SUM(lines.amount)', system: true });
    const line = await mustOk(a.get('/config/forms/capex_line'));
    const lk = line.published.fields.map((x: { key: string; system: boolean }) => `${x.key}:${x.system}`);
    expect(lk).toEqual(expect.arrayContaining(['item:true', 'uom:true', 'qty:true', 'rate:true', 'amount:true', 'required_date:true', 'est_rate:false', 'remarks:false']));
    expect(line.published.fields.find((x: { key: string }) => x.key === 'amount').expr).toBe('qty * est_rate');

    const keys = await c.db.selectFrom('app.permission_def').select(['key', 'source']).where('tenant_id', '=', f.tenantId).where('tab_key', '=', 'doc.capex').execute();
    expect(keys.map(k => k.key).sort()).toEqual(['doc.capex', ...ALL_CAPEX_KEYS()].sort());
    expect(new Set(keys.map(k => k.source))).toEqual(new Set(['form']));

    const series = await mustOk(a.get('/config/numbering?docType=capex'));
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ pattern: 'CAPEX/{LOC}/{FYS}/{SEQ:4}', locationNodeId: null, reset: 'fy', isActive: true });
    expect(series[0].preview).toMatch(/^CAPEX\/LOC\/\d\d-\d\d\/0001$/);

    // the admin sees the new tab right away (permver bumped)
    const me = await mustOk(a.get('/auth/me'));
    expect(me.permissions.keys).toEqual(expect.arrayContaining(['doc.capex', 'doc.capex:action.add']));
    const list = await mustOk(a.get('/doc-types'));
    expect(list.map((x: { key: string }) => x.key)).toContain('capex');
  });

  it('system fields cannot be removed or retyped through the form builder; lines formulas check against the sibling', async () => {
    const a = api(c, f.token);
    const d = await mustOk(a.get('/config/forms/capex_header'));
    const without = d.published.fields.filter((x: { key: string }) => x.key !== 'location');
    const saved = await mustOk(a.put('/config/forms/capex_header/draft', { definition: { fields: without }, version: d.version }));
    expect(saved.draftIssues.map((i: { code: string }) => i.code)).toContain('SYSTEM_FIELD_REMOVED');
    await mustOk(a.del('/config/forms/capex_header/draft'));
    // a header formula over an unknown line column is reported
    const d2 = await mustOk(a.get('/config/forms/capex_header'));
    const bad = [...d2.published.fields, { key: 'max_rate', type: 'formula', label: 'Max', expr: 'MAX(lines.nope)' }];
    const s2 = await mustOk(a.put('/config/forms/capex_header/draft', { definition: { fields: bad }, version: d2.version }));
    expect(s2.draftIssues.some((i: { message: string }) => /nope/.test(i.message))).toBe(true);
    // a valid one publishes
    const d3 = await mustOk(a.del('/config/forms/capex_header/draft'));
    const good = [...d3.published.fields, { key: 'max_rate', type: 'formula', label: 'Max rate', expr: 'MAX(lines.est_rate)' }];
    const s3 = await mustOk(a.put('/config/forms/capex_header/draft', { definition: { fields: good }, version: d3.version }));
    expect(s3.draftIssues).toEqual([]);
    await mustOk(a.post('/config/forms/capex_header/publish', { version: s3.version }));
    // a line formula reading a header field resolves through the composed form
    const l = await mustOk(a.get('/config/forms/capex_line'));
    const lf = [...l.published.fields, { key: 'share', type: 'formula', label: 'Share', expr: 'IF(max_rate > 0, est_rate / max_rate * 100, 0)' }];
    const ls = await mustOk(a.put('/config/forms/capex_line/draft', { definition: { fields: lf }, version: l.version }));
    expect(ls.draftIssues).toEqual([]);
    await mustOk(a.del('/config/forms/capex_line/draft'));
  });

  it('rejects duplicate keys, wrong system field types and "lines" in the header', async () => {
    const a = api(c, f.token);
    expect((await a.post('/config/doc-types', { key: 'capex', name: 'Again', pluralName: 'Agains' })).status).toBe(409);
    const r = await a.post('/config/doc-types', {
      key: 'badsys', name: 'Bad', pluralName: 'Bads', headerDefinition: { fields: [{ key: 'location', type: 'text', label: 'Location' }, { key: 'lines', type: 'text', label: 'Lines' }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: { path: string }) => e.path)).toEqual(['headerDefinition.fields.0.type', 'headerDefinition.fields.1.key']);
  });

  it('counts against custom_forms together with custom masters', async () => {
    const a = api(c, f.token);
    // limit 3: capex + one master + one more type = 3; the next one fails
    await mustOk(a.post('/config/masters', { key: 'asset_class', name: 'Asset class', pluralName: 'Asset classes' }), 201);
    await mustOk(a.post('/config/doc-types', { key: 'travel', name: 'Travel Request', pluralName: 'Travel Requests', hasLines: false }), 201);
    const r = await a.post('/config/doc-types', { key: 'loan', name: 'Loan', pluralName: 'Loans' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('LIMIT_EXCEEDED.custom_forms');
  });

  it('a type without lines has no line form and no item-wise view', async () => {
    const list = await mustOk(api(c, f.token).get('/doc-types'));
    const travel = list.find((x: { key: string }) => x.key === 'travel');
    expect(travel).toMatchObject({ lineFormKey: null });
    expect(travel.settings.itemWiseView).toBe(false);
    const header = await mustOk(api(c, f.token).get('/config/forms/travel_header'));
    expect(header.published.fields.find((x: { key: string }) => x.key === 'total_amount').type).toBe('currency');
  });

  it('updates name/settings with optimistic locking, deactivates and reactivates', async () => {
    const a = api(c, f.token);
    const list = await mustOk(a.get('/doc-types'));
    const t = list.find((x: { key: string }) => x.key === 'capex');
    const u = await mustOk(a.put('/config/doc-types/capex', { name: 'Capital Request', settings: { ...t.settings, editableStatuses: ['draft', 'on_hold'] }, version: t.version }));
    expect(u).toMatchObject({ name: 'Capital Request' });
    expect(u.settings.editableStatuses).toEqual(['draft', 'on_hold']);
    expect((await a.put('/config/doc-types/capex', { name: 'Stale', version: t.version })).status).toBe(409);
    const tab = await c.db.selectFrom('app.permission_def').select('label').where('tenant_id', '=', f.tenantId).where('key', '=', 'doc.capex:action.add').executeTakeFirstOrThrow();
    expect(tab.label).toBe('Create capital request');
    const off = await mustOk(a.post('/config/doc-types/capex/deactivate'));
    expect(off.isActive).toBe(false);
    expect((await a.post('/docs/capex', { values: { location: f.pune, purpose: 'x' }, lines: [] })).status).toBe(409);
    expect((await mustOk(a.post('/config/doc-types/capex/activate'))).isActive).toBe(true);
    await mustOk(a.put('/config/doc-types/capex', { name: 'Capex Request', version: u.version + 2 }));
  });

  it('GET /doc-types shows only types the user can view; config endpoints need config keys', async () => {
    const viewer = await docUser(c, f, ['doc.capex:action.view']);
    const list = await mustOk(api(c, viewer.token).get('/doc-types'));
    expect(list.map((x: { key: string }) => x.key)).toEqual(['capex']);
    expect((await api(c, viewer.token).post('/config/doc-types', { key: 'zzz', name: 'Zzz', pluralName: 'Zzzs' })).status).toBe(403);
    expect((await api(c, viewer.token).get('/config/numbering')).status).toBe(403);
    expect(CAPEX_HEADER.length).toBe(3);
  });
});
