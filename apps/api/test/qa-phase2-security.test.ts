/**
 * QA Phase 2 — security: privilege escalation, cross-tenant ids on the Phase 2 routes, signed file URLs, upload
 * polyglots, formula / prototype injection. Known bugs are reproduced with `it.fails` and their QA2-BUG id
 * (docs/qa/phase-2-report.md); remove the marker once fixed.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/core/config';
import { API, bearer, bootApp, closeApp, Ctx, uid } from './helpers';
import { addRecord, api, builderTenant, createMaster, mustOk, PNG_1PX, publish, userWithKeys } from './forms-helpers';

type Tok = string;

describe('QA2 security', () => {
  let c: Ctx;
  // Tenant A (attacker side) and B (victim side), both on a form-builder plan.
  let A: { token: Tok; code: string; tenantId: string; adminId: string };
  let B: { token: Tok; code: string; tenantId: string; itemId: string; thingId: string; fileId: string; uomId: string; catId: string };

  const up = (tok: Tok, buf: Buffer, name: string, fields: Record<string, string> = {}) => {
    let r = c.http.post(`${API}/files`).set(bearer(tok));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', buf, name);
  };
  const rawGet = (url: string) => c.http.get(url.replace(/^https?:\/\/[^/]+/, '')).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (d: Buffer) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  beforeAll(async () => {
    c = await bootApp();
    const ta = await builderTenant(c);
    A = { token: ta.token, code: ta.tenant.code, tenantId: ta.tenant.tenantId, adminId: ta.admin.userId };
    const tb = await builderTenant(c);
    const bt = tb.token;
    // Same custom master key in both tenants + a key that exists only in B.
    await createMaster(c, A.token, 'qa_thing', [{ key: 'note', label: 'Note', type: 'text' }]);
    await createMaster(c, bt, 'qa_thing', [{ key: 'note', label: 'Note', type: 'text' }, { key: 'pic', label: 'Pic', type: 'image' }]);
    await createMaster(c, bt, 'bonly', [{ key: 'secret', label: 'Secret', type: 'text' }]);
    await addRecord(c, bt, 'bonly', { code: 'S1', name: 'B secret row', data: { secret: 'b-secret-value' } });
    const uom = await addRecord(c, bt, 'uom', { code: `BU${uid(3)}`, name: 'B unit', data: { decimals: '0' } });
    const item = await addRecord(c, bt, 'item', { name: 'B private item', data: { uom: uom.id } });
    const file = await mustOk(up(bt, PNG_1PX, 'b.png'), 201);
    const thing = await addRecord(c, bt, 'qa_thing', { code: 'T1', name: 'B thing', data: { note: 'b-note', pic: file.id } });
    B = { token: bt, code: tb.tenant.code, tenantId: tb.tenant.tenantId, itemId: item.id, thingId: thing.id, fileId: file.id, uomId: uom.id, catId: '' };
  });
  afterAll(async () => { await closeApp(c); });

  // ------------------------------------------------------------------ escalation
  describe('privilege escalation by non-admins', () => {
    it('[QA2-BUG-001] a user with admin.users:action.add cannot create a tenant administrator', async () => {
      const mgr = await userWithKeys(c, A.token, A.code, ['admin.users:action.view', 'admin.users:action.add', 'admin.users:view.active']);
      const res = await api(c, mgr.token).post('/users', { name: 'Shadow admin', email: `shadow-${uid()}@x.test`, isTenantAdmin: true });
      expect(res.status).toBe(403);
    });

    it('[QA2-BUG-001] a user with admin.users:action.edit cannot make themselves a tenant administrator', async () => {
      const mgr = await userWithKeys(c, A.token, A.code, ['admin.users:action.view', 'admin.users:action.edit', 'admin.users:view.active']);
      const me = await mustOk(api(c, mgr.token).get(`/users/${mgr.userId}`));
      const res = await api(c, mgr.token).put(`/users/${mgr.userId}`, { isTenantAdmin: true, version: me.version });
      expect(res.status).toBe(403);
      const after = await mustOk(api(c, A.token).get(`/users/${mgr.userId}`));
      expect(after.isTenantAdmin).toBe(false);
    });

    it('[QA2-BUG-001] PUT /users/:id roleIds cannot assign a role with keys the caller lacks (same rule as PUT /users/:id/roles)', async () => {
      const mgr = await userWithKeys(c, A.token, A.code, ['admin.users:action.view', 'admin.users:action.edit', 'admin.users:view.active']);
      const strong = await mustOk(api(c, A.token).post('/roles', { key: `strong_${uid(4)}`, name: 'Strong' }), 201);
      await mustOk(api(c, A.token).put(`/roles/${strong.id}/permissions/tabs/admin.settings`, { actions: ['admin.settings:action.view', 'admin.settings:action.edit'] }));
      const me = await mustOk(api(c, mgr.token).get(`/users/${mgr.userId}`));
      const res = await api(c, mgr.token).put(`/users/${mgr.userId}`, { roleIds: [mgr.roleId, strong.id], version: me.version });
      expect(res.status).toBe(403);
      expect((await api(c, mgr.token).get('/config/settings')).status).toBe(403);
    });

    it('[QA2-BUG-001] POST /users with roleIds cannot hand out a role the caller could not assign', async () => {
      const mgr = await userWithKeys(c, A.token, A.code, ['admin.users:action.view', 'admin.users:action.add', 'admin.users:view.active']);
      const roles = await mustOk(api(c, A.token).get('/roles'));
      const sys = (roles.data ?? roles).find((r: { isSystem: boolean }) => r.isSystem);
      const res = await api(c, mgr.token).post('/users', { name: 'Via role', email: `vr-${uid()}@x.test`, roleIds: [sys.id] });
      expect(res.status).toBe(403);
    });

    it('[QA2-BUG-002] a manager cannot lift a Deny that an admin placed on their own account', async () => {
      const mgr = await userWithKeys(c, A.token, A.code, [
        'admin.users:action.view', 'admin.users:action.manage_permissions', 'admin.users:view.active', 'admin.users:action.add',
      ]);
      await mustOk(api(c, A.token).put(`/users/${mgr.userId}/permissions/tabs/admin.users`, { allow: [], deny: ['admin.users:action.add'], fieldAccess: [] }));
      expect((await api(c, mgr.token).post('/users', { name: 'Blocked', email: `b-${uid()}@x.test` })).status).toBe(403);
      const lift = await api(c, mgr.token).put(`/users/${mgr.userId}/permissions/tabs/admin.users`, { allow: [], deny: [], fieldAccess: [] });
      expect(lift.status).toBe(403);
      expect((await api(c, mgr.token).post('/users', { name: 'Blocked', email: `b-${uid()}@x.test` })).status).toBe(403);
    });

    it('[QA2-BUG-002] a manager cannot make a field editable for themselves that their role locks', async () => {
      const mgr = await userWithKeys(c, A.token, A.code, [
        'admin.users:action.view', 'admin.users:action.manage_permissions', 'admin.users:view.active',
        'master.item:action.view', 'master.item:action.edit', 'master.item:view.active',
      ], { 'master.item': { fieldAccess: [{ formKey: 'item', fieldKey: 'hsn_code', mode: 'readonly' }] } });
      const res = await api(c, mgr.token).put(`/users/${mgr.userId}/permissions/tabs/master.item`, {
        allow: [], deny: [], fieldAccess: [{ formKey: 'item', fieldKey: 'hsn_code', mode: 'editable' }],
      });
      expect(res.status).toBe(403);
    });

    it('[QA2-BUG-003] a location-scoped manager cannot widen scope by assigning a role that covers all locations', async () => {
      const plant = await mustOk(api(c, A.token).post('/locations', { code: `P-${uid(4)}`, name: 'Mgr plant' }), 201);
      const mgr = await userWithKeys(c, A.token, A.code, [
        'admin.users:action.view', 'admin.users:action.manage_permissions', 'admin.users:view.active', 'admin.locations:action.view',
      ]);
      await mustOk(api(c, A.token).put(`/roles/${mgr.roleId}/scope`, { entries: [{ nodeId: plant.id }] }));
      // A role with only keys the manager holds, but scope = all locations.
      const wide = await mustOk(api(c, A.token).post('/roles', { key: `wide_${uid(4)}`, name: 'Wide' }), 201);
      await mustOk(api(c, A.token).put(`/roles/${wide.id}/permissions/tabs/admin.locations`, { actions: ['admin.locations:action.view'] }));
      await mustOk(api(c, A.token).put(`/roles/${wide.id}/scope`, { entries: [{ allNodes: true }] }));
      // Direct scope grant is refused (control)...
      expect((await api(c, mgr.token).put(`/users/${mgr.userId}/scope`, { entries: [{ allNodes: true }] })).status).toBe(403);
      // ...so assigning the wide role must be refused too.
      const res = await api(c, mgr.token).put(`/users/${mgr.userId}/roles`, { roleIds: [mgr.roleId, wide.id] });
      expect(res.status).toBe(403);
    });

    it('control: escalation through role tabs, user allow and the admin role is refused', async () => {
      const mgr = await userWithKeys(c, A.token, A.code, [
        'admin.roles:action.view', 'admin.roles:action.manage_permissions', 'admin.users:action.view',
        'admin.users:action.manage_permissions', 'admin.users:view.active',
      ]);
      expect((await api(c, mgr.token).put(`/roles/${mgr.roleId}/permissions/tabs/admin.settings`, { actions: ['admin.settings:action.view'] })).status).toBe(403);
      expect((await api(c, mgr.token).put(`/users/${mgr.userId}/permissions/tabs/admin.settings`, { allow: ['admin.settings:action.view'] })).status).toBe(403);
      const sys = ((await mustOk(api(c, A.token).get('/roles'))) as { id: string; isSystem: boolean }[]).find(r => r.isSystem)!;
      expect((await api(c, mgr.token).put(`/users/${mgr.userId}/roles`, { roleIds: [sys.id] })).status).toBe(403);
      // Nothing changed for the manager.
      expect((await api(c, mgr.token).get('/config/settings')).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------ cross-tenant
  describe('cross-tenant ids on Phase 2 routes', () => {
    it('A admin with B record / file ids → 404, never B data', async () => {
      const a = api(c, A.token);
      const wrong: string[] = [];
      const routes: [string, () => PromiseLike<{ status: number; body: unknown }>][] = [
        [`GET item/${B.itemId}`, () => a.get(`/masters/item/records/${B.itemId}`)],
        [`PUT item/${B.itemId}`, () => a.put(`/masters/item/records/${B.itemId}`, { name: 'x', data: {}, version: 1 })],
        [`deactivate item`, () => a.post(`/masters/item/records/${B.itemId}/deactivate`)],
        [`activate item`, () => a.post(`/masters/item/records/${B.itemId}/activate`)],
        [`DELETE item`, () => a.del(`/masters/item/records/${B.itemId}`, { reason: 'x' })],
        [`usage item`, () => a.get(`/masters/item/records/${B.itemId}/usage`)],
        [`GET qa_thing (same key) record`, () => a.get(`/masters/qa_thing/records/${B.thingId}`)],
        [`PUT qa_thing record`, () => a.put(`/masters/qa_thing/records/${B.thingId}`, { name: 'x', data: {}, version: 1 })],
        [`DELETE qa_thing record`, () => a.del(`/masters/qa_thing/records/${B.thingId}`, { reason: 'x' })],
        [`GET uom record via item key`, () => a.get(`/masters/item/records/${B.uomId}`)],
        [`B-only master list`, () => a.get('/masters/bonly/records')],
        [`B-only master options`, () => a.get('/masters/bonly/options')],
        [`B-only master template`, () => a.get('/masters/bonly/template.xlsx')],
        [`B-only master export`, () => a.get('/masters/bonly/export')],
        [`B-only config form`, () => a.get('/config/forms/bonly')],
        [`B-only config form versions`, () => a.get('/config/forms/bonly/versions')],
        [`B-only form render`, () => a.get('/forms/bonly/render')],
        [`B-only draft save`, () => a.put('/config/forms/bonly/draft', { definition: { fields: [{ key: 'x', label: 'X', type: 'text' }] }, version: 1 })],
        [`B-only publish`, () => a.post('/config/forms/bonly/publish', { version: 1 })],
        [`B-only master update`, () => a.put('/config/masters/bonly', { name: 'Hijack', version: 1 })],
        [`B-only master deactivate`, () => a.post('/config/masters/bonly/deactivate')],
        [`B file meta`, () => a.get(`/files/${B.fileId}`)],
      ];
      for (const [name, call] of routes) {
        const res = await call();
        const text = JSON.stringify(res.body ?? '');
        if (res.status !== 404) wrong.push(`${name} → ${res.status} ${text.slice(0, 120)}`);
        if (/b-secret-value|b-note|B private item|B thing|B secret row/.test(text) || text.includes(B.tenantId)) wrong.push(`${name} leaks B data`);
      }
      expect(wrong).toEqual([]);
      // B is untouched.
      const still = await mustOk(api(c, B.token).get(`/masters/qa_thing/records/${B.thingId}`));
      expect(still).toMatchObject({ name: 'B thing', isActive: true, version: 1 });
    });

    it('B ids are invalid references from A (lookup, image, options include)', async () => {
      const a = api(c, A.token);
      const r1 = await a.post('/masters/item/records', { name: 'Uses B uom', data: { uom: B.uomId } });
      expect(r1.status).toBe(400);
      expect(r1.body.errors.map((e: { path: string }) => e.path)).toContain('uom');
      const r2 = await a.post('/masters/qa_thing/records', { code: `X${uid(3)}`, name: 'Uses B file', data: {} });
      expect(r2.status).toBe(201); // control
      const uomA = await addRecord(c, A.token, 'uom', { code: `AU${uid(3)}`, name: 'A unit', data: { decimals: '0' } });
      const r3 = await a.post('/masters/item/records', { name: 'Image from B', data: { uom: uomA.id, image: B.fileId } });
      expect(r3.status).toBe(400);
      expect(r3.body.errors.map((e: { path: string }) => e.path)).toContain('image');
      const opts = (await mustOk(a.get(`/masters/item/options?include=${B.itemId}`))) as { id: string }[];
      expect(opts.map(o => o.id)).not.toContain(B.itemId);
      const usage = await a.get(`/masters/uom/records/${B.uomId}/usage`);
      expect(usage.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ signed file URLs
  describe('file content URLs', () => {
    const sign = (id: string, exp: number, w: number | null) => createHmac('sha256', config.files.urlSecret).update(`${id}|${exp}|${w ?? ''}`).digest('base64url');
    const url = (tenant: string, id: string, exp: number, sig: string, w?: number) =>
      `${API}/files/${id}/content?t=${tenant}&exp=${exp}${w ? `&w=${w}` : ''}&sig=${sig}`;

    it('valid URL serves bytes; tampered sig / expired / wrong width / B id with A sig → 403', async () => {
      const meta = await mustOk(up(A.token, PNG_1PX, 'a.png'), 201);
      const ok = await rawGet(meta.url);
      expect(ok.status).toBe(200);
      expect(Buffer.compare(ok.body as Buffer, PNG_1PX)).toBe(0);
      const u = new URL(meta.url, 'http://x');
      const exp = Number(u.searchParams.get('exp'));
      const sig = u.searchParams.get('sig')!;
      const flip = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
      expect((await rawGet(url(A.tenantId, meta.id, exp, flip))).status).toBe(403);
      expect((await rawGet(url(A.tenantId, meta.id, exp + 60, sig))).status).toBe(403); // exp changed
      const past = Math.floor(Date.now() / 1000) - 5;
      expect((await rawGet(url(A.tenantId, meta.id, past, sign(meta.id, past, null)))).status).toBe(403); // genuinely signed, expired
      expect((await rawGet(url(A.tenantId, meta.id, exp, sig, 64))).status).toBe(403); // w not covered by sig
      expect((await rawGet(url(A.tenantId, B.fileId, exp, sig))).status).toBe(403); // A's sig on B's id
      expect((await rawGet(`${API}/files/${meta.id}/content`)).status).toBe(403); // no sig at all
      expect((await rawGet(`${API}/files/${meta.id}/content?t=${A.tenantId}&exp=99999999999&sig=${sign(meta.id, 99999999999, null).slice(0, 10)}`)).status).toBe(403);
    });

    it('a correctly signed URL routed to the wrong tenant finds nothing (404), and B bytes never come back', async () => {
      const exp = Math.floor(Date.now() / 1000) + 120;
      const sig = sign(B.fileId, exp, null);
      const wrongTenant = await rawGet(url(A.tenantId, B.fileId, exp, sig));
      expect(wrongTenant.status).toBe(404);
      expect((wrongTenant.body as Buffer).includes(PNG_1PX)).toBe(false);
      // Garbage tenant ids are refused before any lookup.
      expect((await rawGet(url('not-a-uuid', B.fileId, exp, sig))).status).toBe(403);
      expect((await rawGet(url(`${B.tenantId}' or '1'='1`, B.fileId, exp, sig))).status).toBe(403);
    });
  });

  // ------------------------------------------------------------------ upload polyglots
  describe('uploads: renamed executables and polyglots', () => {
    const MZ = Buffer.concat([Buffer.from('4d5a90000300000004000000ffff0000b800000000000000400000000000000000000000000000000000000000000000000000000000000000000000800000000e1fba0e00b409cd21b8014ccd21546869732070726f6772616d2063616e6e6f742062652072756e20696e20444f53206d6f64652e', 'hex'), Buffer.alloc(256)]);
    const ELF = Buffer.concat([Buffer.from('7f454c46020101000000000000000000', 'hex'), Buffer.alloc(256)]);
    const SH = Buffer.from('#!/bin/sh\nrm -rf / --no-preserve-root\n');
    const HTML = Buffer.from('<!doctype html><html><body><script>alert(document.cookie)</script></body></html>');
    const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
    const GIFJS = Buffer.concat([Buffer.from('GIF89a/*\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1'), Buffer.from('*/=1;alert(1)//')]);

    it.each([
      ['exe renamed .png', MZ, 'photo.png'],
      ['exe renamed .pdf', MZ, 'invoice.pdf'],
      ['ELF renamed .jpg', ELF, 'pic.jpg'],
      ['ELF as .txt', ELF, 'notes.txt'],
      ['shell script renamed .png', SH, 'x.png'],
      ['HTML renamed .png', HTML, 'x.png'],
      ['HTML as .html', HTML, 'x.html'],
      ['SVG with script', SVG, 'logo.svg'],
      ['SVG renamed .png', SVG, 'logo.png'],
      ['real PNG with an .exe name', PNG_1PX, 'photo.png.exe'],
      ['real PNG with no extension', PNG_1PX, 'photo'],
    ])('rejects %s', async (_name, buf, filename) => {
      const res = await up(A.token, buf, filename);
      expect(res.status).toBe(400);
      expect(res.body.errors?.[0]?.path).toBe('file');
    });

    it('a shell script or HTML named .txt is stored as text/plain and served as an attachment with nosniff', async () => {
      for (const buf of [SH, HTML]) {
        const meta = await mustOk(up(A.token, buf, 'readme.txt'), 201);
        expect(meta.mime).toBe('text/plain');
        const res = await rawGet(meta.url);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/plain/);
        expect(res.headers['content-disposition']).toMatch(/^attachment/);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      }
    });

    it('GIF/JS and PNG/HTML polyglots are only ever served as images (inline image/*, nosniff), never as script/html', async () => {
      const g = await up(A.token, GIFJS, 'pixel.gif');
      if (g.status === 201) {
        const res = await rawGet(g.body.url);
        expect(res.headers['content-type']).toBe('image/gif');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      } else {
        expect(g.status).toBe(400);
      }
      const p = await mustOk(up(A.token, Buffer.concat([PNG_1PX, HTML]), 'poly.png'), 201);
      const res = await rawGet(p.url);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // Field rules: an image field refuses a PDF even though PDFs are on the platform list.
      const pdf = await up(A.token, Buffer.from('%PDF-1.4\n%%EOF\n'), 'x.pdf', { formKey: 'item', fieldKey: 'image' });
      expect(pdf.status).toBe(400);
    });

    it('path traversal / header injection in file names is neutralised', async () => {
      const meta = await mustOk(up(A.token, PNG_1PX, '../../../etc/passwd".png'), 201);
      expect(meta.filename).not.toMatch(/[/\\"]/);
      const crlf = await up(A.token, PNG_1PX, 'a\r\nSet-Cookie: pwn=1\r\n.png');
      if (crlf.status === 201) {
        const res = await rawGet(crlf.body.url);
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(String(res.headers['content-disposition'])).not.toMatch(/[\r\n]/);
      }
    });
  });

  // ------------------------------------------------------------------ formula / prototype injection
  describe('formula and prototype injection in form definitions', () => {
    const protoKeys = () => Object.getOwnPropertyNames(Object.prototype).sort().join(',');
    let baseline: string;
    beforeAll(() => { baseline = protoKeys(); });

    const bad = [
      'constructor', '__proto__', 'prototype', 'toString()', 'qty.constructor', 'qty.__proto__', 'qty.constructor.constructor',
      'CONSTRUCTOR(1)', '__PROTO__(1)', 'HASOWNPROPERTY(qty)', 'VALUEOF(qty)', "''.constructor", 'this', 'globalThis', 'process.exit(1)',
      "require('fs')", 'eval("1")', 'Function("return 1")()', '(() => 1)()', 'qty[0]', 'qty["constructor"]', '`${qty}`', 'new Date()',
      'qty; process.exit(1)', 'IF(1, 2)', `${'('.repeat(60)}1${')'.repeat(60)}`, Array.from({ length: 300 }, () => 'qty').join(' + '),
    ];

    it.each(bad)('validate + publish refuse %s (never executed)', async expr => {
      const def = { fields: [{ key: 'qty', label: 'Qty', type: 'decimal' }, { key: 'out', label: 'Out', type: 'formula', expr }] };
      const v = await mustOk(api(c, A.token).post('/config/forms/validate', { definition: def }));
      expect(v.issues.length, `${expr}: ${JSON.stringify(v.issues)}`).toBeGreaterThan(0);
      expect(v.issues.some((i: { path: string }) => i.path.startsWith('fields.1'))).toBe(true);
      expect(protoKeys()).toBe(baseline);
    });

    it('over-long expressions (> 2,000 chars) are rejected by the schema; visibleWhen / validations are checked too', async () => {
      const a = api(c, A.token);
      const long = `qty + ${'1 + '.repeat(600)}1`;
      const r = await a.post('/config/forms/validate', { definition: { fields: [{ key: 'qty', label: 'Qty', type: 'decimal' }, { key: 'o', label: 'O', type: 'formula', expr: long }] } });
      expect(r.status === 400 || (r.status === 200 && r.body.issues.length > 0)).toBe(true);
      const vw = await mustOk(a.post('/config/forms/validate', { definition: { fields: [{ key: 'qty', label: 'Qty', type: 'decimal', visibleWhen: 'constructor' }], validations: [] } }));
      expect(vw.issues.length).toBeGreaterThan(0);
      const vr = await mustOk(a.post('/config/forms/validate', { definition: { fields: [{ key: 'qty', label: 'Qty', type: 'decimal' }], validations: [{ key: 'v1', expr: '__proto__', message: 'x' }] } }));
      expect(vr.issues.length).toBeGreaterThan(0);
    });

    it('a publish with an injected formula is refused (400) and the form keeps its last version', async () => {
      await createMaster(c, A.token, 'qa_inj', [{ key: 'qty', label: 'Qty', type: 'decimal' }]);
      const before = await mustOk(api(c, A.token).get('/config/forms/qa_inj'));
      const res = await publish(c, A.token, 'qa_inj', [{ key: 'qty', label: 'Qty', type: 'decimal' }, { key: 'o', label: 'O', type: 'formula', expr: 'qty.constructor' }]);
      expect(res.status).toBe(400);
      const after = await mustOk(api(c, A.token).get('/config/forms/qa_inj'));
      expect(after.currentVersion).toBe(before.currentVersion);
    });

    it('field keys like __proto__ / constructor are invalid; record data with __proto__ / constructor keys is stripped and pollutes nothing', async () => {
      for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
        const r = await api(c, A.token).post('/config/forms/validate', { definition: { fields: [{ key, label: 'K', type: 'text' }] } });
        // `constructor`/`prototype` match the key pattern; they must at least not break anything.
        expect([200, 400]).toContain(r.status);
      }
      const body = JSON.parse(`{"code":"P${uid(3)}","name":"Proto","data":{"note":"ok","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}}`);
      const res = await c.http.post(`${API}/masters/qa_thing/records`).set(bearer(A.token)).set('content-type', 'application/json').send(JSON.stringify(body));
      expect(res.status).toBe(201);
      expect(Object.keys(res.body.data)).toEqual(['note']);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
      expect(protoKeys()).toBe(baseline);
      const row = await c.db.selectFrom('app.master_record').select('data').where('id', '=', res.body.id).executeTakeFirstOrThrow();
      expect(Object.keys(row.data as object)).toEqual(['note']);
    });

    it('options attrs / filters on a master never expose or probe hidden fields', async () => {
      await createMaster(c, A.token, 'qa_price', [{ key: 'cost', label: 'Cost', type: 'currency' }, { key: 'grade', label: 'Grade', type: 'text' }]);
      await addRecord(c, A.token, 'qa_price', { code: 'P1', name: 'Priced', data: { cost: '42', grade: 'g1' } });
      const u = await userWithKeys(c, A.token, A.code, ['master.qa_price:action.view', 'master.qa_price:view.active'],
        { 'master.qa_price': { fieldAccess: [{ formKey: 'qa_price', fieldKey: 'cost', mode: 'hidden' }] } });
      const attrs = (await mustOk(api(c, u.token).get('/masters/qa_price/options?attrs=cost&attrs=grade'))) as { attrs: Record<string, unknown> }[];
      expect(attrs[0]!.attrs).toEqual({ grade: 'g1' });
      expect((await api(c, u.token).get('/masters/qa_price/records?f.cost=42')).status).toBe(400);
      expect((await api(c, u.token).get('/masters/qa_price/records?sort=cost')).status).toBe(400);
    });

    it('[QA2-BUG-004] options filter=<hidden field>:<guess> must not work as an oracle for hidden values', async () => {
      const u = await userWithKeys(c, A.token, A.code, ['master.qa_price:action.view', 'master.qa_price:view.active'],
        { 'master.qa_price': { fieldAccess: [{ formKey: 'qa_price', fieldKey: 'cost', mode: 'hidden' }] } });
      const hit = await api(c, u.token).get('/masters/qa_price/options?filter=cost:42');
      const miss = await api(c, u.token).get('/masters/qa_price/options?filter=cost:41');
      // Either refused, or the filter is ignored — but a hit/miss difference reveals the hidden value.
      const leaks = hit.status === 200 && miss.status === 200 && hit.body.length !== miss.body.length;
      expect(leaks).toBe(false);
    });
  });
});
