import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, chainHash } from '../src/core/audit.service';
import { QueueService } from '../src/core/queue.service';
import { AuditVerifier } from '../src/modules/documents';
import { api, mustOk } from './forms-helpers';
import { API, bearer, bootApp, closeApp, Ctx, superAdmin } from './helpers';
import { capexBody, createCapexType, docsApi, docsTenant, DocsFixture, docUser, workflowLink } from './documents-helpers';

describe('audit chain hashing (pure)', () => {
  it('is stable across a jsonb round trip (key order, JSON text vs object, Date vs ISO)', () => {
    const at = new Date('2026-10-22T10:00:00.123Z');
    const written = { actor_id: 'u', action: 'update', entity: 'x', entity_id: '1', before: JSON.stringify({ b: 1, a: { d: [1, 2], c: null } }), after: null, ip: null, user_agent: null, at: at.toISOString() };
    const read = { after: null, at, before: { a: { c: null, d: [1, 2] }, b: 1 }, entity: 'x', entity_id: '1', action: 'update', actor_id: 'u', ip: null, user_agent: null };
    expect(chainHash('p', read, true)).toBe(chainHash('p', written));
    expect(chainHash('p', { ...read, before: { b: 2, a: { c: null, d: [1, 2] } } }, true)).not.toBe(chainHash('p', written));
    expect(chainHash(null, written)).not.toBe(chainHash('p', written));
    // a stored JSON string value is not re-parsed when read back
    expect(chainHash(null, { ...written, after: JSON.stringify('123') })).toBe(chainHash(null, { ...read, after: '123', before: JSON.parse(written.before) }, true));
    expect(canonicalJson({ z: 1, a: [{ y: 2, b: undefined }], d: new Date(0) })).toBe('{"a":[{"y":2}],"d":"1970-01-01T00:00:00.000Z","z":1}');
  });
});

describe('audit API + verification', () => {
  let c: Ctx;
  let f: DocsFixture;
  let capexTypeId: string;

  beforeAll(async () => {
    c = await bootApp();
    workflowLink(c).override(null);
    f = await docsTenant(c);
    capexTypeId = (await createCapexType(c, f.token)).id;
  });
  afterAll(async () => {
    workflowLink(c).override(undefined);
    await closeApp(c);
  });

  it('lists the tenant audit log newest first with filters, names and cursor', async () => {
    const a = api(c, f.token);
    const doc = await mustOk(docsApi(c, f.token).create(capexBody(f)), 201);
    const all = await mustOk(a.get('/audit?limit=5'));
    expect(all.data).toHaveLength(5);
    expect(all.data[0]).toMatchObject({ action: 'create', entity: 'document', entityId: doc.id, actor: { id: f.adminId, name: 'Tenant Admin' }, impersonatedBy: null });
    expect(all.data[0].after.values.purpose).toBe(doc.values.purpose);
    expect(all.data[0].ip).toMatch(/127\.0\.0\.1|::1/);
    const ids = all.data.map((r: { id: string }) => Number(r.id));
    expect([...ids].sort((x, y) => y - x)).toEqual(ids);
    const next = await mustOk(a.get(`/audit?limit=5&cursor=${all.nextCursor}`));
    expect(Number(next.data[0].id)).toBeLessThan(ids[4]!);
    const byEntity = await mustOk(a.get(`/audit?entity=document&entityId=${doc.id}`));
    expect(byEntity.data.map((r: { action: string }) => r.action)).toEqual(['create']);
    // Provisioning also creates system doc types (Phase 4: indent, vendor_selection, po); look at the one under test.
    const byAction = await mustOk(a.get(`/audit?action=create&entity=doc_type&entityId=${capexTypeId}`));
    expect(byAction.data).toHaveLength(1);
    expect(byAction.data[0].after.key).toBe('capex');
    expect((await mustOk(a.get(`/audit?actorId=${f.adminId}&from=${new Date(Date.now() - 60000).toISOString()}`))).data.length).toBeGreaterThan(0);
    expect((await mustOk(a.get(`/audit?to=2000-01-01T00:00:00.000Z`))).data).toEqual([]);
    expect((await a.get('/audit?cursor=abc')).status).toBe(400);
  });

  it('shows the impersonating Super Admin by name', async () => {
    const sa = await superAdmin(c);
    const imp = await c.http.post(`${API}/platform/tenants/${f.tenantId}/impersonate`).set(bearer(sa.token)).send({ reason: 'Audit test' });
    expect(imp.status).toBe(200);
    const doc = await mustOk(docsApi(c, imp.body.accessToken).create(capexBody(f)), 201);
    const r = await mustOk(api(c, f.token).get(`/audit?entityId=${doc.id}`));
    expect(r.data[0].impersonatedBy).toEqual({ id: sa.userId, name: 'Platform owner' });
  });

  it('needs admin.audit keys', async () => {
    const u = await docUser(c, f, ['doc.capex:action.view']);
    expect((await api(c, u.token).get('/audit')).status).toBe(403);
    expect((await api(c, u.token).get('/audit/checks')).status).toBe(403);
    const viewer = await docUser(c, f, ['admin.audit:action.view']);
    expect((await api(c, viewer.token).get('/audit')).status).toBe(200);
    expect((await api(c, viewer.token).post('/audit/checks')).status).toBe(403);
  });

  it('run-now verifies the chain; a tampered row is detected, recorded and admins are notified', async () => {
    const a = api(c, f.token);
    const ok = await mustOk(a.post('/audit/checks'), 201);
    expect(ok).toMatchObject({ ok: true, firstBadId: null });
    expect(ok.rowsChecked).toBeGreaterThan(10);
    // tamper with a row's content as the database owner (app roles cannot UPDATE audit_log)
    const victim = await c.db.selectFrom('app.audit_log').select(['id', 'after']).where('tenant_id', '=', f.tenantId).where('entity', '=', 'document').orderBy('id').executeTakeFirstOrThrow();
    await c.db.updateTable('app.audit_log').set({ after: JSON.stringify({ ...(victim.after as object), forged: true }) } as never).where('id', '=', victim.id).execute();
    const bad = await mustOk(a.post('/audit/checks'), 201);
    expect(bad).toMatchObject({ ok: false, firstBadId: String(victim.id) });
    expect(bad.detail).toMatch(/hash mismatch/);
    const checks = await mustOk(a.get('/audit/checks'));
    expect(checks.slice(0, 2).map((x: { ok: boolean }) => x.ok)).toEqual([false, true]);
    const note = await c.db.selectFrom('app.notification').select(['kind', 'link']).where('tenant_id', '=', f.tenantId).where('kind', '=', 'audit_check_failed').execute();
    expect(note.length).toBeGreaterThan(0);
    // restoring the content makes it pass again; deleting a row breaks the links
    await c.db.updateTable('app.audit_log').set({ after: JSON.stringify(victim.after) } as never).where('id', '=', victim.id).execute();
    expect((await mustOk(a.post('/audit/checks'), 201)).ok).toBe(true);
    const mid = await c.db.selectFrom('app.audit_log').select('id').where('tenant_id', '=', f.tenantId).orderBy('id').offset(3).limit(1).executeTakeFirstOrThrow();
    await c.db.deleteFrom('app.audit_log').where('id', '=', mid.id).execute();
    const broken = await mustOk(a.post('/audit/checks'), 201);
    expect(broken.ok).toBe(false);
    expect(broken.detail).toMatch(/does not link/);
    expect(Number(broken.firstBadId)).toBeGreaterThan(Number(mid.id));
  });

  it('nightly job verifies every tenant and the platform chain; it is registered as a repeatable at 02:30 UTC', async () => {
    const v = c.app.get(AuditVerifier);
    const fresh = await docsTenant(c);
    const r = await v.verifyAll();
    expect(r.tenants).toBeGreaterThan(1);
    const platform = await c.db.selectFrom('platform.audit_check').selectAll().where('tenant_id', 'is', null).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(platform.ok).toBe(true);
    const freshCheck = await c.db.selectFrom('platform.audit_check').selectAll().where('tenant_id', '=', fresh.tenantId).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(freshCheck).toMatchObject({ ok: true });
    const q = c.app.get(QueueService);
    await q.startWorkers();
    const reps = await q.queue('audit').getRepeatableJobs();
    expect(reps.map(x => [x.name, x.pattern])).toContainEqual(['audit-verify', '30 2 * * *']);
  });
});
