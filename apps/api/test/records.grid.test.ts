import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, closeApp, Ctx } from './helpers';
import { addRecord, api, builderTenant, createMaster, mustOk, userWithKeys } from './forms-helpers';

describe('records with grids: row formulas, aggregates, grid lookups and column access', () => {
  let c: Ctx;
  let token: string;
  let code: string;
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    c = await bootApp();
    const t = await builderTenant(c);
    token = t.token;
    code = t.tenant.code;
    await createMaster(c, token, 'zone');
    ids.Z1 = (await addRecord(c, token, 'zone', { code: 'Z1', name: 'North' })).id;
    ids.Z2 = (await addRecord(c, token, 'zone', { code: 'Z2', name: 'South' })).id;
    await createMaster(c, token, 'depot', [{ key: 'zone', label: 'Zone', type: 'lookup', source: { kind: 'master', masterKey: 'zone' } }, { key: 'km', label: 'Km', type: 'decimal' }]);
    ids.D1 = (await addRecord(c, token, 'depot', { code: 'D1', name: 'Depot N', data: { zone: ids.Z1, km: '10' } })).id;
    ids.D2 = (await addRecord(c, token, 'depot', { code: 'D2', name: 'Depot S', data: { zone: ids.Z2, km: '20' } })).id;
    await createMaster(c, token, 'route', [
      { key: 'rate', label: 'Rate', type: 'currency' },
      {
        key: 'legs', label: 'Legs', type: 'grid', minRows: 1, columns: [
          { key: 'zone', label: 'Zone', type: 'lookup', source: { kind: 'master', masterKey: 'zone' }, required: true },
          { key: 'depot', label: 'Depot', type: 'lookup', source: { kind: 'master', masterKey: 'depot' }, filterBy: [{ field: 'zone', targetField: 'zone' }] },
          { key: 'trips', label: 'Trips', type: 'number', required: true },
          { key: 'cost', label: 'Cost', type: 'formula', expr: 'trips * depot.km * rate', precision: 2 },
          { key: 'note', label: 'Note', type: 'text' },
        ],
      },
      { key: 'total', label: 'Total', type: 'formula', expr: 'SUM(legs.cost)', precision: 2 },
    ]);
  });
  afterAll(async () => { await closeApp(c); });

  it('computes row and header formulas, validates grid lookups per row, fills grid refs', async () => {
    const r = await addRecord(c, token, 'route', {
      code: 'R1', name: 'Route 1',
      data: { rate: '2', legs: [{ zone: ids.Z1, depot: ids.D1, trips: '3', cost: '1' }, { zone: ids.Z2, depot: ids.D2, trips: '1' }] },
    });
    expect(r.data.legs.map((l: { cost: string }) => l.cost)).toEqual(['60.00', '40.00']);
    expect(r.data.total).toBe('100.00');
    expect(r.refs['legs.depot'][ids.D1!]).toBe('D1 - Depot N');
    const bad = await api(c, token).post('/masters/route/records', { code: 'R2', name: 'x', data: { legs: [{ zone: ids.Z1, depot: ids.D2, trips: 'x' }, {}] } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['legs.0.depot', 'legs.0.trips', 'legs.1.trips', 'legs.1.zone']);
    const refs = await c.db.selectFrom('app.record_ref').select('from_field').where('from_id', '=', r.id).execute();
    expect(refs.map(x => x.from_field).sort()).toEqual(['legs.depot', 'legs.depot', 'legs.zone', 'legs.zone']);
  });

  it('read-only grid columns keep stored cell values; changing one is 403', async () => {
    const r = await addRecord(c, token, 'route', { code: 'R3', name: 'Route 3', data: { rate: '1', legs: [{ zone: ids.Z1, trips: '1', note: 'keep me' }] } });
    const u = await userWithKeys(c, token, code, ['master.route:action.view', 'master.route:action.edit', 'master.route:view.active'], {
      'master.route': { fieldAccess: [{ formKey: 'route', fieldKey: 'legs.note', mode: 'hidden' }] },
    });
    const a = api(c, u.token);
    const got = await mustOk(a.get(`/masters/route/records/${r.id}`));
    expect(got.data.legs[0].note).toBeUndefined();
    const legs = [{ ...got.data.legs[0], trips: '5' }];
    const upd = await mustOk(a.put(`/masters/route/records/${r.id}`, { code: 'R3', name: 'Route 3', data: { legs }, version: got.version }));
    expect(upd.data.legs[0].trips).toBe('5');
    const stored = await c.db.selectFrom('app.master_record').select('data').where('id', '=', r.id).executeTakeFirstOrThrow();
    expect((stored.data as { legs: { note: string }[] }).legs[0]!.note).toBe('keep me');
    const changed = await a.put(`/masters/route/records/${r.id}`, { code: 'R3', name: 'Route 3', data: { legs: [{ ...legs[0], note: 'hack' }] }, version: upd.version });
    expect(changed.body).toMatchObject({ code: 'FIELD_READ_ONLY', meta: { field: 'legs.note' } });
  });
});
