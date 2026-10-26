import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, closeApp, Ctx, superAdmin, tenantWithAdmin } from './helpers';
import { addRecord, api, builderTenant, createMaster, mustOk, publish, userWithKeys } from './forms-helpers';

describe('forms: drafts, publish rules, versions, render', () => {
  let c: Ctx;
  let token: string;
  let code: string;
  beforeAll(async () => {
    c = await bootApp();
    const t = await builderTenant(c);
    token = t.token;
    code = t.tenant.code;
    await createMaster(c, token, 'grade', [{ key: 'level', label: 'Level', type: 'text' }]);
  });
  afterAll(async () => { await closeApp(c); });

  it('lists forms, saves drafts with issues, rejects publishing them', async () => {
    const a = api(c, token);
    const forms = await mustOk(a.get('/config/forms'));
    expect(forms.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['item', 'vendor', 'user', 'grade']));
    const d = await mustOk(a.get('/config/forms/grade'));
    expect(d).toMatchObject({ currentVersion: 1, hasDraft: false, draft: null, draftIssues: [] });

    const bad = {
      fields: [
        { key: 'level', label: 'Level', type: 'number' },                                                    // FIELD_RETYPED
        { key: 'dup', label: 'D', type: 'text' }, { key: 'dup', label: 'D2', type: 'text' },                  // DUPLICATE_KEY
        { key: 'created_at', label: 'C', type: 'text' },                                                     // RESERVED_KEY
        { key: 'm', label: 'M', type: 'lookup', source: { kind: 'master', masterKey: 'ghost' } },            // UNKNOWN_MASTER
        { key: 'total', label: 'Total', type: 'formula', expr: 'qtyy * 2' },                                 // UNKNOWN_FIELD_REF
        { key: 'loop1', label: 'L1', type: 'formula', expr: 'loop2 + 1' }, { key: 'loop2', label: 'L2', type: 'formula', expr: 'loop1 + 1' }, // FORMULA_CYCLE
        { key: 'syn', label: 'S', type: 'formula', expr: '1 +' },                                             // FORMULA_SYNTAX
      ],
    };
    const saved = await mustOk(a.put('/config/forms/grade/draft', { definition: bad, version: d.version }));
    const codes = saved.draftIssues.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['FIELD_RETYPED', 'DUPLICATE_KEY', 'RESERVED_KEY', 'UNKNOWN_MASTER', 'UNKNOWN_FIELD_REF', 'FORMULA_CYCLE', 'FORMULA_SYNTAX']));
    expect(saved.hasDraft).toBe(true);
    expect(saved.draft.version).toBe(2);

    const pub = await a.post('/config/forms/grade/publish', { version: saved.version });
    expect(pub.status).toBe(400);
    expect(pub.body.code).toBe('VALIDATION_FAILED');
    expect(pub.body.errors.length).toBeGreaterThanOrEqual(7);

    // stale version -> conflict; discard draft
    expect((await a.put('/config/forms/grade/draft', { definition: bad, version: d.version })).status).toBe(409);
    const discarded = await mustOk(a.del('/config/forms/grade/draft'));
    expect(discarded.hasDraft).toBe(false);
    expect((await a.post('/config/forms/grade/publish', { version: discarded.version })).status).toBe(409);
  });

  it('validate endpoint uses the same checks (type errors in conditions too)', async () => {
    const a = api(c, token);
    const r = await mustOk(a.post('/config/forms/validate', {
      formKey: 'item',
      definition: { fields: [{ key: 'uom', label: 'UoM', type: 'text', system: true }, { key: 'x', label: 'X', type: 'text', visibleWhen: '1 + 1' }] },
    }));
    const codes = r.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain('SYSTEM_FIELD_RETYPED');
    expect(codes).toContain('SYSTEM_FIELD_REMOVED'); // hsn_code etc. missing
    expect(codes).toContain('FORMULA_TYPE');
    const clean = await mustOk(a.post('/config/forms/validate', { definition: { fields: [{ key: 'x', label: 'X', type: 'text' }] } }));
    expect(clean.issues).toEqual([]);
  });

  it('versioning: v1 records keep rendering with v1 after v2 removes a field; update re-saves on v2 keeping data', async () => {
    const a = api(c, token);
    await createMaster(c, token, 'tool', [{ key: 'brand', label: 'Brand', type: 'text' }, { key: 'size', label: 'Size', type: 'text' }]);
    const v1 = await addRecord(c, token, 'tool', { code: 'T1', name: 'Hammer', data: { brand: 'Acme', size: 'L' } });
    const r = await publish(c, token, 'tool', [{ key: 'brand', label: 'Brand', type: 'text' }, { key: 'weight', label: 'Weight', type: 'decimal' }]);
    expect(r.status).toBe(200);
    expect(r.body.currentVersion).toBe(2);
    const sizeField = r.body.published.fields.find((f: { key: string }) => f.key === 'size');
    expect(sizeField).toMatchObject({ removed: true, type: 'text' });

    const versions = await mustOk(a.get('/config/forms/tool/versions'));
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(versions[0].publishedByName).toBe('Tenant Admin');
    const def1 = await mustOk(a.get('/config/forms/tool/versions/1'));
    expect(def1.fields.map((f: { key: string }) => f.key)).toEqual(['brand', 'size']);

    const got = await mustOk(a.get(`/masters/tool/records/${v1.id}`));
    expect(got.formVersionId).toBe(v1.formVersionId);
    expect(got.data).toEqual({ brand: 'Acme', size: 'L' });
    const render1 = await mustOk(a.get(`/forms/tool/render?versionId=${v1.formVersionId}`));
    expect(render1.definition.fields.map((f: { key: string }) => f.key)).toEqual(['brand', 'size']);

    const upd = await mustOk(a.put(`/masters/tool/records/${v1.id}`, { code: 'T1', name: 'Hammer', data: { brand: 'Acme', weight: '1.25', size: 'IGNORED' }, version: got.version }));
    expect(upd.formVersionId).not.toBe(v1.formVersionId);
    expect(upd.data).toEqual({ brand: 'Acme', weight: '1.25', size: 'L' });
    const current = await mustOk(a.get('/forms/tool/render'));
    expect(current.formVersionId).toBe(upd.formVersionId);

    // re-adding a removed field with another type is FIELD_RETYPED
    const re = await publish(c, token, 'tool', [{ key: 'brand', label: 'Brand', type: 'text' }, { key: 'size', label: 'Size', type: 'number' }]);
    expect(re.status).toBe(400);
    expect(re.body.meta.issues.map((i: { code: string }) => i.code)).toContain('FIELD_RETYPED');
  });

  it('render strips hidden fields and lists read-only ones per the caller', async () => {
    await createMaster(c, token, 'secret', [{ key: 'pub', label: 'Pub', type: 'text' }, { key: 'cost', label: 'Cost', type: 'currency' }, { key: 'note', label: 'Note', type: 'text' }]);
    const u = await userWithKeys(c, token, code, ['master.secret:action.view', 'master.secret:view.active'], {
      'master.secret': { fieldAccess: [{ formKey: 'secret', fieldKey: 'cost', mode: 'hidden' }, { formKey: 'secret', fieldKey: 'note', mode: 'readonly' }] },
    });
    const r = await mustOk(api(c, u.token).get('/forms/secret/render'));
    expect(r.definition.fields.map((f: { key: string }) => f.key)).toEqual(['pub', 'note']);
    expect(r.readOnlyFields).toEqual(['note']);
    // no tab access -> 403; config endpoints need config keys
    expect((await api(c, u.token).get('/forms/grade/render')).status).toBe(403);
    expect((await api(c, u.token).get('/config/forms')).status).toBe(403);
  });

  it('GET /users/options: active users, id/name/email only, any tenant user', async () => {
    const u = await userWithKeys(c, token, code, ['master.grade:action.view']);
    const rows = await mustOk(api(c, u.token).get('/users/options?q=admin&limit=5'));
    expect(rows).toEqual([{ id: expect.any(String), name: 'Tenant Admin', email: expect.stringMatching(/^admin@/) }]);
    expect((await mustOk(api(c, u.token).get('/users/options'))).length).toBeGreaterThanOrEqual(2);
  });

  it('form builder writes need the plan feature', async () => {
    const sa = await superAdmin(c);
    const t = await tenantWithAdmin(c, sa.token, { features: ['indent'], limits: { max_users: 5 } });
    const a = api(c, t.admin.token);
    expect((await a.put('/config/forms/item/draft', { definition: { fields: [{ key: 'x', label: 'X', type: 'text' }] }, version: 1 })).status).toBe(404);
    expect((await a.post('/config/masters', { key: 'abc', name: 'Abc', pluralName: 'Abcs' })).status).toBe(404);
  });
});
