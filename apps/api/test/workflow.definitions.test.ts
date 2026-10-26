/**
 * Workflow definitions (contract §Workflow config endpoints): validation issue codes, draft/publish/versions,
 * stage permission key regeneration (removed stages lose keys + grants), permver bump, simulate, feature gating.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMVER_KEY } from '../src/core/entitlements.service';
import { RedisService } from '../src/core/redis.service';
import { bootApp, closeApp, Ctx } from './helpers';
import { api, mustOk } from './forms-helpers';
import { createRole } from './permissions-helpers';
import { createDocType, DocType, publishWorkflow, useFakeDocs, WfTenant, wfTenant, wfUser } from './workflow-helpers';

describe('workflow definitions', () => {
  let c: Ctx;
  let t: WfTenant;
  let dt: DocType;
  let roleId: string;

  beforeAll(async () => {
    c = await bootApp();
    useFakeDocs(c);
    t = await wfTenant(c);
    dt = await createDocType(c, t);
    roleId = (await createRole(c, t.token, 'Approver')).id;
  });
  afterAll(async () => { await closeApp(c); });
  const a = () => api(c, t.token);

  it('reports every validation issue code on the draft and refuses to publish', async () => {
    const d = await mustOk(a().get(`/config/workflows/${dt.key}`));
    expect(d).toMatchObject({ docTypeKey: dt.key, published: null, publishedVersion: null, draft: null, draftIssues: [] });
    expect(d.availableEffects).toEqual(expect.arrayContaining(['lock_editing', 'unlock_editing', 'close_document', 'notify', 'emit', 'route_to']));
    expect(d.availableEffects).not.toContain('post_stock');
    const definition = {
      stages: [
        { key: 'hod', name: 'HOD', when: 'total_amount > ', actors: [{ type: 'role', roleId: crypto.randomUUID() }] },
        { key: 'hod', name: 'HOD again', when: 'purpose', actors: [{ type: 'users', userIds: [crypto.randomUUID()] }] },
        { key: 'draft', name: 'Reserved', actors: [{ type: 'field', field: 'purpose' }], actions: ['reject'] },
        { key: 'p1', name: 'P1', parallelGroup: 'g' },
        { key: 'mid', name: 'Mid', quorum: 'all', actors: [{ type: 'reporting_manager' }], editableLineFields: ['nope'] },
        { key: 'p2', name: 'P2', parallelGroup: 'g', effects: { onApprove: [{ effect: 'route_to', stage: 'hod' }], onReject: [{ effect: 'route_to', stage: 'ghost' }, { effect: 'post_stock' }] } },
        { key: 'ok', name: 'Ok', when: "lines.qty > 0", effects: { onEnter: [{ effect: 'notify', to: [{ type: 'stage_actors', stage: 'ghost' }, { type: 'role', roleId: crypto.randomUUID() }] }] } },
      ],
      onComplete: [{ effect: 'send_email', template: 'x' }],
    };
    const saved = await mustOk(a().put(`/config/workflows/${dt.key}/draft`, { definition, version: d.version }));
    const codes = (saved.draftIssues as { code: string; path: string }[]).map(i => `${i.code}@${i.path}`);
    expect(codes).toEqual(expect.arrayContaining([
      'BAD_CONDITION@stages.0.when', 'UNKNOWN_ROLE@stages.0.actors.0.roleId', 'DUPLICATE_STAGE@stages.1.key', 'BAD_CONDITION@stages.1.when',
      'UNKNOWN_USER@stages.1.actors.0.userIds.0', 'RESERVED_STAGE_KEY@stages.2.key', 'UNKNOWN_FIELD@stages.2.actors.0.field', 'NO_ACTIONS@stages.2.actions',
      'QUORUM_NEEDS_ACTORS@stages.4.quorum', 'UNKNOWN_FIELD@stages.4.editableLineFields.0', 'BAD_ROUTE@stages.5.effects.onApprove.0',
      'BAD_ROUTE@stages.5.effects.onReject.0.stage', 'EFFECT_UNAVAILABLE@stages.5.effects.onReject.1', 'BAD_PARALLEL_GROUP@stages.5.parallelGroup',
      'BAD_ROUTE@stages.6.effects.onEnter.0.to.0.stage', 'UNKNOWN_ROLE@stages.6.effects.onEnter.0.to.1.roleId', 'EFFECT_UNAVAILABLE@onComplete.0',
      'BAD_CONDITION@stages.6.when',
    ]));
    const pub = await a().post(`/config/workflows/${dt.key}/publish`, { version: saved.version });
    expect(pub.status).toBe(400);
    expect(pub.body.meta.issues.length).toBe(saved.draftIssues.length);
    expect((await a().post(`/config/workflows/${dt.key}/publish`, { version: saved.version - 1 })).status).toBe(409);
    const discarded = await mustOk(a().del(`/config/workflows/${dt.key}/draft`));
    expect(discarded.draft).toBeNull();
    expect((await a().post(`/config/workflows/${dt.key}/publish`, { version: discarded.version })).status).toBe(409);
  });

  it('publishes versions, regenerates stage keys/views, deletes removed keys with their grants, bumps permver', async () => {
    const redis = c.app.get(RedisService);
    const before = Number(await redis.client.get(PERMVER_KEY(t.tenantId)) ?? 0);
    await publishWorkflow(c, t.token, dt.key, {
      stages: [
        { key: 'hod', name: 'HOD approval', actors: [{ type: 'role', roleId }] },
        { key: 'finance', name: 'Finance review', statusLabel: 'With finance', when: 'total_amount > 100000 and SUM(lines.qty) > 0' },
      ],
    });
    expect(Number(await redis.client.get(PERMVER_KEY(t.tenantId)))).toBeGreaterThan(before);
    // Only the type under test (provisioning publishes default workflows for the procurement system types too).
    const defs = await c.db.selectFrom('app.permission_def').select(['key', 'kind', 'label', 'source', 'tab_key']).where('tenant_id', '=', t.tenantId).where('source', '=', 'workflow').where('tab_key', '=', `doc.${dt.key}`).orderBy('key').execute();
    expect(defs).toEqual([
      { key: `doc.${dt.key}:action.stage_finance`, kind: 'action', label: 'Act on Finance review', source: 'workflow', tab_key: `doc.${dt.key}` },
      { key: `doc.${dt.key}:action.stage_hod`, kind: 'action', label: 'Act on HOD approval', source: 'workflow', tab_key: `doc.${dt.key}` },
      { key: `doc.${dt.key}:view.waiting_finance`, kind: 'view', label: 'With finance', source: 'workflow', tab_key: `doc.${dt.key}` },
      { key: `doc.${dt.key}:view.waiting_hod`, kind: 'view', label: 'Waiting for HOD approval', source: 'workflow', tab_key: `doc.${dt.key}` },
    ]);
    // grant the finance keys, visible on the permissions screen
    await mustOk(a().put(`/roles/${roleId}/permissions/tabs/doc.${dt.key}`, { actions: [`doc.${dt.key}:action.stage_finance`], views: [`doc.${dt.key}:view.waiting_finance`] }));
    const u = await wfUser(c, t, [`doc.${dt.key}:action.stage_hod`]);
    expect((await mustOk(api(c, u.token).get('/auth/me'))).permissions.keys).toContain(`doc.${dt.key}:action.stage_hod`);

    // v2: finance removed, hod renamed
    await publishWorkflow(c, t.token, dt.key, { stages: [{ key: 'hod', name: 'Head of department', actors: [{ type: 'role', roleId }] }] });
    const keys = await c.db.selectFrom('app.permission_def').select(['key', 'label']).where('tenant_id', '=', t.tenantId).where('source', '=', 'workflow').where('tab_key', '=', `doc.${dt.key}`).orderBy('key').execute();
    expect(keys).toEqual([
      { key: `doc.${dt.key}:action.stage_hod`, label: 'Act on Head of department' },
      { key: `doc.${dt.key}:view.waiting_hod`, label: 'Waiting for Head of department' },
    ]);
    const grants = await c.db.selectFrom('app.permission_grant').select('perm_key').where('tenant_id', '=', t.tenantId).where('perm_key', 'like', `%finance%`).execute();
    expect(grants).toEqual([]);
    const versions = await mustOk(a().get(`/config/workflows/${dt.key}/versions`));
    expect(versions.map((v: { version: number; isCurrent: boolean; stageCount: number }) => [v.version, v.isCurrent, v.stageCount])).toEqual([[2, true, 1], [1, false, 2]]);
    const v1 = await mustOk(a().get(`/config/workflows/${dt.key}/versions/1`));
    expect(v1.stages.map((s: { key: string }) => s.key)).toEqual(['hod', 'finance']);
    expect((await a().get(`/config/workflows/${dt.key}/versions/9`)).status).toBe(404);
    const list = await mustOk(a().get('/config/workflows'));
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ docTypeKey: dt.key, publishedVersion: 2, hasDraft: false, stageCount: 1 })]));
    const audit = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', t.tenantId).where('entity', '=', 'workflow').execute();
    expect(audit.map(x => x.action)).toEqual(expect.arrayContaining(['save_draft', 'publish']));
  });

  it('simulates routing with sample values (draft or published), incl. actors and no-actor outcomes', async () => {
    const nobody = await createRole(c, t.token, 'Nobody role');
    await wfUser(c, t, [`doc.${dt.key}:action.stage_hod`], { roleId });
    await mustOk(a().put(`/roles/${roleId}/scope`, { entries: [{ nodeId: t.plantA.id }] }));
    const d = await mustOk(a().get(`/config/workflows/${dt.key}`));
    await mustOk(a().put(`/config/workflows/${dt.key}/draft`, { version: d.version, definition: { stages: [
      { key: 'hod', name: 'HOD', actors: [{ type: 'role', roleId }] },
      { key: 'finance', name: 'Finance', when: 'total_amount > 100000' },
      { key: 'off', name: 'Off', enabled: false },
      { key: 'ghost', name: 'Ghost', actors: [{ type: 'role', roleId: nobody.id }], ifNoActor: 'skip' },
      { key: 'admins', name: 'Admins', actors: [{ type: 'role', roleId: nobody.id }] },
      { key: 'lines', name: 'Lines', when: 'SUM(lines.qty) >= 10' },
    ] } }));
    const sim = await mustOk(a().post(`/config/workflows/${dt.key}/simulate`, { values: { total_amount: '50000', location: t.plantA.id }, lines: [{ qty: '4' }, { qty: '6' }] }), 200);
    expect(sim.stages.map((s: { key: string; outcome: string }) => `${s.key}:${s.outcome}`)).toEqual([
      'hod:run', 'finance:skipped_condition', 'off:disabled', 'ghost:no_actor_skip', 'admins:no_actor_admins', 'lines:no_actor_admins',
    ]);
    expect(sim.stages[0].actors.length).toBeGreaterThan(0);
    expect(sim.stages[4].actors).toContain('Tenant Admin');
    const noLoc = await mustOk(a().post(`/config/workflows/${dt.key}/simulate`, { values: { total_amount: '150000' } }), 200);
    expect(noLoc.stages[1]).toMatchObject({ key: 'finance', outcome: 'run', conditionValue: true });
    expect(noLoc.stages[0].actors).toEqual(['Approver']);
    const published = await mustOk(a().post(`/config/workflows/${dt.key}/simulate`, { values: {}, useDraft: false }), 200);
    expect(published.stages.map((s: { key: string }) => s.key)).toEqual(['hod']);
  });

  it('gates by permission and plan feature; unknown doc type → 404', async () => {
    const viewer = await wfUser(c, t, ['config.workflows:action.view']);
    expect((await api(c, viewer.token).get(`/config/workflows/${dt.key}`)).status).toBe(200);
    expect((await api(c, viewer.token).put(`/config/workflows/${dt.key}/draft`, { definition: {}, version: 1 })).status).toBe(403);
    expect((await a().get('/config/workflows/no_such_type')).status).toBe(404);
    expect((await a().get('/config/workflows/BAD!')).status).toBe(404);
    const t2 = await wfTenant(c, ['indent', 'purchase', 'form_builder']);
    expect((await api(c, t2.token).put('/config/workflows/x1/draft', { definition: {}, version: 1 })).status).toBe(404);
    expect((await api(c, t2.token).get('/config/workflows')).status).toBe(403);
  });
});
