import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { financialYear, periodOf, renderNumber } from '../src/modules/documents';
import { unknownTokens } from '../src/modules/documents/numbering';
import { api, mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { capexBody, createCapexType, docsApi, docsTenant, DocsFixture, submittedCapex, workflowLink } from './documents-helpers';

describe('numbering (pure)', () => {
  it('financial year from the tenant start month', () => {
    expect(financialYear('2026-04-01', 4)).toMatchObject({ start: 2026, fy: '2026-27', fys: '26-27' });
    expect(financialYear('2027-03-31', 4)).toMatchObject({ start: 2026, fy: '2026-27', fys: '26-27' });
    expect(financialYear('2027-04-01', 4)).toMatchObject({ start: 2027, fy: '2027-28', fys: '27-28' });
    expect(financialYear('2026-12-31', 1)).toMatchObject({ start: 2026, fy: '2026', fys: '26' });
    expect(financialYear('2099-06-30', 7)).toMatchObject({ fy: '2098-99', fys: '98-99' });
    expect(financialYear('2099-07-01', 7)).toMatchObject({ fy: '2099-00', fys: '99-00' });
  });

  it('periods per reset policy', () => {
    expect(periodOf('never', '2026-10-22', 4)).toBe('all');
    expect(periodOf('fy', '2026-10-22', 4)).toBe('2026-27');
    expect(periodOf('month', '2026-10-22', 4)).toBe('2026-10');
  });

  it('renders every token', () => {
    const ctx = { prefix: 'capex', locationCode: 'PUN', date: '2026-10-22', fyStartMonth: 4 };
    expect(renderNumber('{PREFIX}/{LOC}/{FY}/{FYS}/{YYYY}{YY}{MM}/{SEQ:5}', ctx, 42)).toBe('CAPEX/PUN/2026-27/26-27/202626' + '10/00042');
    expect(renderNumber('CPX-{SEQ:2}', ctx, 123)).toBe('CPX-123');
    expect(unknownTokens('{PREFIX}{NOPE}{SEQ:4}{SEQ:0}')).toEqual(['NOPE', 'SEQ:0']);
  });
});

describe('numbering (integration)', () => {
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

  it('20 concurrent submits in one series get 20 distinct consecutive numbers', async () => {
    const d = docsApi(c, f.token);
    const docs = [];
    for (let i = 0; i < 20; i++) docs.push(await mustOk(d.create(capexBody(f, { location: f.chennai, values: { doc_date: '2026-11-15' } })), 201));
    const res = await Promise.all(docs.map(x => d.submit(x.id, x.version)));
    expect(res.map(r => r.status)).toEqual(Array(20).fill(200));
    const seqs = res.map(r => Number(String(r.body.number).split('/').pop())).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(res.map(r => r.body.number)).size).toBe(20);
  });

  it('series by location: nearest ancestor wins, else the default series; preview; one active series per location', async () => {
    const a = api(c, f.token);
    const pune = await mustOk(a.post('/config/numbering', { docTypeKey: 'capex', name: 'Pune', locationNodeId: f.pune, pattern: 'CPX-PUN/{FYS}/{SEQ:4}' }), 201);
    expect(pune).toMatchObject({ locationName: 'Pune plant', reset: 'fy', isActive: true });
    expect(pune.preview).toMatch(/^CPX-PUN\/\d\d-\d\d\/0001$/);
    const atChild = await submittedCapex(c, f, { location: f.puneMain, values: { doc_date: '2026-11-01' } });
    expect(atChild.number).toBe('CPX-PUN/26-27/0001');
    const atPune = await submittedCapex(c, f, { location: f.pune, values: { doc_date: '2026-11-02' } });
    expect(atPune.number).toBe('CPX-PUN/26-27/0002');
    const atChennai = await submittedCapex(c, f, { location: f.chennai, values: { doc_date: '2026-11-03' } });
    expect(atChennai.number).toMatch(/^CAPEX\/CHE-\w+\/26-27\/0021$/);
    const dup = await a.post('/config/numbering', { docTypeKey: 'capex', name: 'Pune 2', locationNodeId: f.pune, pattern: 'X/{SEQ:3}' });
    expect(dup.status).toBe(409);
    expect((await a.post('/config/numbering', { docTypeKey: 'capex', name: 'Bad', pattern: 'X/{YEAR}/{SEQ:3}' })).status).toBe(400);
    expect((await a.post('/config/numbering', { docTypeKey: 'capex', name: 'Bad', pattern: 'X-no-seq' })).status).toBe(400);
    expect((await a.post('/config/numbering', { docTypeKey: 'nope', name: 'Bad', pattern: '{SEQ:3}' })).status).toBe(400);
    const pv = await mustOk(a.get(`/config/numbering/${pune.id}/preview?locationId=${f.puneMain}&date=2027-04-01`));
    expect(pv.number).toBe('CPX-PUN/27-28/0001');
    const pv2 = await mustOk(a.get(`/config/numbering/${pune.id}/preview?date=2026-12-01`));
    expect(pv2.number).toBe('CPX-PUN/26-27/0003');
  });

  it('FY rollover restarts the sequence; editing a pattern never renumbers issued documents', async () => {
    const a = api(c, f.token);
    const before = await submittedCapex(c, f, { location: f.pune, values: { doc_date: '2027-03-31' } });
    expect(before.number).toBe('CPX-PUN/26-27/0003');
    const after = await submittedCapex(c, f, { location: f.pune, values: { doc_date: '2027-04-01' } });
    expect(after.number).toBe('CPX-PUN/27-28/0001');
    const series = (await mustOk(a.get('/config/numbering?docType=capex'))).find((s: { locationNodeId: string | null }) => s.locationNodeId === f.pune);
    const upd = await mustOk(a.put(`/config/numbering/${series.id}`, { docTypeKey: 'capex', name: 'Pune', locationNodeId: f.pune, pattern: 'P/{FY}/{SEQ:3}', reset: 'fy', version: series.version }));
    expect(upd.pattern).toBe('P/{FY}/{SEQ:3}');
    expect((await mustOk(docsApi(c, f.token).get(before.id))).number).toBe('CPX-PUN/26-27/0003');
    const next = await submittedCapex(c, f, { location: f.pune, values: { doc_date: '2027-04-02' } });
    expect(next.number).toBe('P/2027-28/002');
    expect((await a.put(`/config/numbering/${series.id}`, { docTypeKey: 'capex', name: 'x', pattern: '{SEQ:3}', version: series.version })).status).toBe(409);
    // deactivating the location series falls back to the default one
    await mustOk(a.put(`/config/numbering/${series.id}`, { docTypeKey: 'capex', name: 'Pune', locationNodeId: f.pune, pattern: 'P/{FY}/{SEQ:3}', isActive: false, version: upd.version }));
    const fallback = await submittedCapex(c, f, { location: f.pune, values: { doc_date: '2027-04-03' } });
    expect(fallback.number).toMatch(/^CAPEX\/PUN-\w+\/27-28\/0001$/);
  });

  it('reset policies: never and month', async () => {
    const a = api(c, f.token);
    const m = await mustOk(a.post('/config/numbering', { docTypeKey: 'capex', name: 'Monthly', locationNodeId: f.puneMain, pattern: 'M/{YYYY}{MM}/{SEQ:3}', reset: 'month' }), 201);
    expect((await submittedCapex(c, f, { location: f.puneMain, values: { doc_date: '2026-11-30' } })).number).toBe('M/202611/001');
    expect((await submittedCapex(c, f, { location: f.puneMain, values: { doc_date: '2026-12-01' } })).number).toBe('M/202612/001');
    await mustOk(a.put(`/config/numbering/${m.id}`, { docTypeKey: 'capex', name: 'Never', locationNodeId: f.puneMain, pattern: 'N-{SEQ:3}', reset: 'never', version: m.version }));
    expect((await submittedCapex(c, f, { location: f.puneMain, values: { doc_date: '2026-12-02' } })).number).toBe('N-001');
    expect((await submittedCapex(c, f, { location: f.puneMain, values: { doc_date: '2028-01-01' } })).number).toBe('N-002');
  });

  it('a type without any applicable series cannot submit (409); a failed submit leaves no gap', async () => {
    const a = api(c, f.token);
    await mustOk(a.post('/config/doc-types', { key: 'travel', name: 'Travel', pluralName: 'Travels', hasLines: false, numberPattern: 'TR-{SEQ:3}' }), 201);
    const rows = await mustOk(a.get('/config/numbering?docType=travel'));
    await mustOk(a.put(`/config/numbering/${rows[0].id}`, { docTypeKey: 'travel', name: 'off', pattern: 'TR-{SEQ:3}', isActive: false, version: rows[0].version }));
    const d = docsApi(c, f.token, 'travel');
    const doc = await mustOk(d.create({ values: { location: f.pune, total_amount: '5000' } }), 201);
    expect((await d.submit(doc.id, doc.version)).status).toBe(409);
    await mustOk(a.put(`/config/numbering/${rows[0].id}`, { docTypeKey: 'travel', name: 'on', pattern: 'TR-{SEQ:3}', isActive: true, version: rows[0].version + 1 }));
    const sub = await mustOk(d.submit(doc.id, doc.version));
    expect(sub.number).toBe('TR-001');
    // a document-level type carries one implicit line so the ledger works
    expect(sub.lines).toHaveLength(1);
    expect(sub.lines[0].qty).toMatchObject({ requested: '1', approved: '1' });
    expect(sub.statusKey).toBe('approved');
  });
});
