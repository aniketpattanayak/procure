import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, bearer, bootApp, closeApp, Ctx } from './helpers';
import { addRecord, api, builderTenant, createMaster, mustOk } from './forms-helpers';

describe('master import / export', () => {
  let c: Ctx;
  let token: string;
  const upload = (path: string, buf: Buffer, name: string) => c.http.post(`${API}${path}`).set(bearer(token)).attach('file', buf, name);
  const csv = (rows: string[][]) => Buffer.from(rows.map(r => r.join(',')).join('\n'));

  beforeAll(async () => {
    c = await bootApp();
    token = (await builderTenant(c)).token;
    await createMaster(c, token, 'family', [{ key: 'colour', label: 'Colour', type: 'select', options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] }]);
    await addRecord(c, token, 'family', { code: 'F1', name: 'Fam one' });
    await addRecord(c, token, 'family', { code: 'F2', name: 'Fam two' });
    await createMaster(c, token, 'part', [
      { key: 'family', label: 'Family', type: 'lookup', source: { kind: 'master', masterKey: 'family' }, required: true },
      { key: 'price', label: 'Price', type: 'currency' },
      { key: 'qty', label: 'Qty', type: 'number' },
      { key: 'total', label: 'Total', type: 'formula', expr: 'price * qty', precision: 2 },
      { key: 'tags', label: 'Tags', type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'active_flag', label: 'Flag', type: 'toggle' },
    ]);
  });
  afterAll(async () => { await closeApp(c); });

  it('template.xlsx has code, name and data columns (no formulas)', async () => {
    const res = await c.http.get(`${API}/masters/part/template.xlsx`).set(bearer(token)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (d: Buffer) => chunks.push(d));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets[0]!.getRow(1).values).toEqual([undefined, 'code', 'name', 'family', 'price', 'qty', 'tags', 'active_flag']);
    expect(wb.worksheets[1]!.name).toBe('Fields');
  });

  it('dry run validates everything, writes nothing, reports row-numbered errors', async () => {
    const file = csv([
      ['code', 'name', 'family', 'price', 'qty', 'tags', 'active_flag'],
      ['P1', 'Bolt', 'F1', '2.50', '4', 'a;b', 'yes'],
      ['P2', 'Nut', 'NOPE', '1', '1', '', 'no'],
      ['P3', 'Washer', 'F2', 'abc', '1', '', ''],
      ['P1', 'Dup', 'F1', '1', '1', '', ''],
    ]);
    const r = await mustOk(upload('/masters/part/import?dryRun=true', file, 'parts.csv'));
    expect(r).toMatchObject({ dryRun: true, totalRows: 4, created: 1, updated: 0 });
    expect(r.errors).toEqual([
      { row: 3, field: 'family', message: expect.stringMatching(/no record with code "NOPE"/) },
      { row: 4, field: 'price', message: expect.any(String) },
      { row: 5, field: 'code', message: expect.stringMatching(/more than once/) },
    ]);
    const list = await mustOk(api(c, token).get('/masters/part/records'));
    expect(list.data).toHaveLength(0);
  });

  it('all-or-nothing: one bad row means nothing is written', async () => {
    const file = csv([['code', 'name', 'family'], ['OK1', 'Fine', 'F1'], ['BAD', 'Bad', '']]);
    const r = await mustOk(upload('/masters/part/import', file, 'parts.csv'));
    expect(r.dryRun).toBe(false);
    expect(r.errors).toEqual([{ row: 3, field: 'family', message: 'Family is required.' }]);
    expect((await mustOk(api(c, token).get('/masters/part/records'))).data).toHaveLength(0);
  });

  it('commit creates records with lookups by code and computed formulas; upsert updates by code', async () => {
    const file = csv([
      ['code', 'name', 'family', 'price', 'qty', 'tags', 'active_flag'],
      ['P1', 'Bolt', 'f1', '2.50', '4', 'a; b', 'yes'],
      ['P2', 'Nut', 'F2', '1', '10', '', 'no'],
    ]);
    const r = await mustOk(upload('/masters/part/import', file, 'parts.csv'));
    expect(r).toMatchObject({ created: 2, updated: 0, errors: [] });
    const list = await mustOk(api(c, token).get('/masters/part/records?sort=code'));
    const p1 = list.data[0];
    expect(p1.data).toMatchObject({ price: '2.50', qty: '4', total: '10.00', tags: ['a', 'b'], active_flag: true });
    expect(Object.values(p1.refs.family)).toEqual(['F1 - Fam one']);

    const again = await mustOk(upload('/masters/part/import', csv([['code', 'name', 'family', 'qty'], ['P1', 'Bolt M8', 'F1', '5']]), 'p.csv'));
    expect(again.errors[0]).toMatchObject({ row: 2, field: 'code' }); // mode=create refuses existing codes
    const up = await mustOk(upload('/masters/part/import?mode=upsert', csv([['code', 'name', 'family', 'qty'], ['P1', 'Bolt M8', 'F1', '5'], ['P9', 'New', 'F2', '1']]), 'p.csv'));
    expect(up).toMatchObject({ created: 1, updated: 1, errors: [] });
    const p1b = await mustOk(api(c, token).get(`/masters/part/records/${p1.id}`));
    expect(p1b).toMatchObject({ name: 'Bolt M8', data: { qty: '5', total: '12.50' } });
  });

  it('unknown columns are rejected; xlsx import works', async () => {
    const r = await mustOk(upload('/masters/part/import', csv([['code', 'name', 'bogus'], ['X', 'Y', '1']]), 'p.csv'));
    expect(r.errors).toEqual([{ row: 1, field: 'bogus', message: expect.stringMatching(/Unknown column/) }]);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('x');
    ws.addRow(['code', 'name', 'family', 'price', 'qty', 'active_flag']);
    ws.addRow(['X1', 'From excel', 'F2', 3.25, 2, true]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const x = await mustOk(upload('/masters/part/import', buf, 'parts.xlsx'));
    expect(x).toMatchObject({ created: 1, errors: [] });
    expect((await upload('/masters/part/import', Buffer.from('%PDF-1.4'), 'x.pdf')).status).toBe(400);
  });

  it('export csv/xlsx with lookups as codes round-trips through upsert import', async () => {
    const res = await c.http.get(`${API}/masters/part/export?format=csv`).set(bearer(token)).buffer(true).parse((r, cb) => {
      let s = '';
      r.on('data', (d: Buffer) => { s += d.toString('utf8'); });
      r.on('end', () => cb(null, s));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="part-/);
    const text = (res.body as string).replace(/^\uFEFF/, '');
    const lines = text.trim().split('\r\n');
    expect(lines[0]).toBe('code,name,family,price,qty,total,tags,active_flag,is_active');
    expect(lines).toContain('P1,Bolt M8,F1,2.50,5,12.50,a; b,true,true');
    const before = await mustOk(api(c, token).get('/masters/part/records?limit=200'));
    const round = await mustOk(upload('/masters/part/import?mode=upsert', Buffer.from(text), 'export.csv'));
    expect(round).toMatchObject({ created: 0, updated: before.data.length, errors: [] });
    const after = await mustOk(api(c, token).get('/masters/part/records?limit=200'));
    const strip = (rows: { code: string; data: unknown }[]) => rows.map(r => [r.code, r.data]).sort();
    expect(strip(after.data)).toEqual(strip(before.data));
    const xl = await c.http.get(`${API}/masters/part/export?format=xlsx&view=all`).set(bearer(token));
    expect(xl.status).toBe(200);
    expect(xl.headers['content-type']).toMatch(/spreadsheetml/);
  });
});
