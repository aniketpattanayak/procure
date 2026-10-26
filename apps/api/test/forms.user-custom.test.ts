import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { addRecord, api, builderTenant, createMaster, mustOk, publish } from './forms-helpers';

describe('user form custom fields', () => {
  let c: Ctx;
  let token: string;
  let ccId: string;
  beforeAll(async () => {
    c = await bootApp();
    token = (await builderTenant(c)).token;
    await createMaster(c, token, 'cost_center');
    ccId = (await addRecord(c, token, 'cost_center', { code: 'CC1', name: 'Plant ops' })).id;
    const current = await mustOk(api(c, token).get('/config/forms/user'));
    const r = await publish(c, token, 'user', [
      ...current.published.fields,
      { key: 'department', label: 'Department', type: 'select', required: true, options: [{ value: 'ops', label: 'Ops' }, { value: 'fin', label: 'Finance' }] },
      { key: 'cost_center', label: 'Cost centre', type: 'lookup', source: { kind: 'master', masterKey: 'cost_center' } },
      { key: 'badge', label: 'Badge', type: 'formula', resultType: 'text', expr: "UPPER(department) & '-' & name" },
    ]);
    expect(r.status).toBe(200);
  });
  afterAll(async () => { await closeApp(c); });

  it('POST/PUT /users validate `custom` against the user form', async () => {
    const a = api(c, token);
    const bad = await a.post('/users', { name: 'Asha', email: `asha-${uid()}@x.test`, custom: { department: 'nope' } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].path).toBe('department');
    const missing = await a.post('/users', { name: 'Asha', email: `asha-${uid()}@x.test` });
    expect(missing.body.errors).toEqual([{ path: 'department', message: 'Department is required.' }]);

    const ok = await mustOk(a.post('/users', { name: 'Asha', email: `asha-${uid()}@x.test`, custom: { department: 'ops', cost_center: ccId, junk: 1 } }), 201);
    expect(ok.user.custom).toEqual({ department: 'ops', cost_center: ccId, badge: 'OPS-Asha' });
    const got = await mustOk(a.get(`/users/${ok.user.id}`));
    expect(got.custom.badge).toBe('OPS-Asha');
    const upd = await mustOk(a.put(`/users/${ok.user.id}`, { name: 'Asha K', version: got.version, custom: { department: 'fin' } }));
    expect(upd.custom).toEqual({ department: 'fin', cost_center: ccId, badge: 'FIN-Asha K' });

    // the user's lookup protects the cost centre from deletion
    const del = await a.del(`/masters/cost_center/records/${ccId}`, { reason: 'x' });
    expect(del.status).toBe(409);
    expect(del.body.meta.usedBy).toEqual([{ kind: 'tenant_user', label: 'Users', count: 1 }]);
  });
});
