/**
 * QA Phase 2 — integrity under concurrency and delete protection:
 *   record_ref blocks deleting referenced UoM / category records; concurrent publish of the same form version;
 *   concurrent saves with the same unique value / code; parallel auto-numbering; location move races on overlapping
 *   subtrees (the tree must stay consistent: every node's path = parent.path || label(id), no cycles).
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { addRecord, api, builderTenant, createMaster, mustOk } from './forms-helpers';

describe('QA2 integrity', () => {
  let c: Ctx;
  let token: string;
  let tenantId: string;

  beforeAll(async () => {
    c = await bootApp();
    const t = await builderTenant(c, { max_locations: 500 });
    token = t.token;
    tenantId = t.tenant.tenantId;
  });
  afterAll(async () => { await closeApp(c); });

  describe('record_ref delete protection', () => {
    it('a UoM used by an item cannot be deleted (409 RECORD_IN_USE with usedBy); after re-pointing the item it can', async () => {
      const a = api(c, token);
      const kg = await addRecord(c, token, 'uom', { code: `KG${uid(3)}`, name: 'Kilogram', data: { decimals: '3' } });
      const nos = await addRecord(c, token, 'uom', { code: `NO${uid(3)}`, name: 'Numbers', data: { decimals: '0' } });
      const item = await addRecord(c, token, 'item', { name: 'Bolt', data: { uom: kg.id } });
      const del = await a.del(`/masters/uom/records/${kg.id}`, { reason: 'cleanup' });
      expect(del.status).toBe(409);
      expect(del.body.code).toBe('RECORD_IN_USE');
      expect(del.body.meta.usedBy).toEqual([{ kind: 'master_record', label: 'Items', count: 1 }]);
      expect((await mustOk(a.get(`/masters/uom/records/${kg.id}/usage`)))).toEqual([{ kind: 'master_record', label: 'Items', count: 1 }]);
      // Still there and active.
      expect((await mustOk(a.get(`/masters/uom/records/${kg.id}`))).isActive).toBe(true);
      // A deactivated (not deleted) item still counts as a reference.
      await mustOk(a.post(`/masters/item/records/${item.id}/deactivate`));
      expect((await a.del(`/masters/uom/records/${kg.id}`, { reason: 'cleanup' })).status).toBe(409);
      await mustOk(a.post(`/masters/item/records/${item.id}/activate`));
      // Re-point the item → the old UoM is free.
      const cur = await mustOk(a.get(`/masters/item/records/${item.id}`));
      await mustOk(a.put(`/masters/item/records/${item.id}`, { name: cur.name, data: { ...cur.data, uom: nos.id }, version: cur.version }));
      expect((await a.del(`/masters/uom/records/${kg.id}`, { reason: 'cleanup' })).status).toBe(204);
      expect((await a.del(`/masters/uom/records/${nos.id}`, { reason: 'cleanup' })).status).toBe(409);
      // Deleting the item frees the other one.
      expect((await a.del(`/masters/item/records/${item.id}`, { reason: 'x' })).status).toBe(204);
      expect((await a.del(`/masters/uom/records/${nos.id}`, { reason: 'cleanup' })).status).toBe(204);
    });

    it('a category used by a sub-category (and through it by items) cannot be deleted', async () => {
      await createMaster(c, token, 'qa_cat');
      await createMaster(c, token, 'qa_sub', [{ key: 'category', label: 'Category', type: 'lookup', source: { kind: 'master', masterKey: 'qa_cat' }, required: true }]);
      const cat = await addRecord(c, token, 'qa_cat', { code: 'A', name: 'Raw' });
      const sub = await addRecord(c, token, 'qa_sub', { code: 'D', name: 'Steel', data: { category: cat.id } });
      const del = await api(c, token).del(`/masters/qa_cat/records/${cat.id}`, { reason: 'x' });
      expect(del.status).toBe(409);
      expect(del.body.meta.usedBy[0]).toMatchObject({ kind: 'master_record', count: 1 });
      expect((await api(c, token).del(`/masters/qa_sub/records/${sub.id}`, { reason: 'x' })).status).toBe(204);
      expect((await api(c, token).del(`/masters/qa_cat/records/${cat.id}`, { reason: 'x' })).status).toBe(204);
    });

    it('[QA2-BUG-006] a UoM cannot be deleted while a new reference to it is being saved (race)', async () => {
      const a = api(c, token);
      for (let i = 0; i < 20; i++) {
        const u = await addRecord(c, token, 'uom', { code: `R${uid(5)}`, name: 'Racy unit', data: { decimals: '0' } });
        const [del, save] = await Promise.all([
          a.del(`/masters/uom/records/${u.id}`, { reason: 'race' }),
          a.post('/masters/item/records', { name: `Racer ${i}`, data: { uom: u.id } }),
        ]);
        // Never both: a live item pointing at a deleted UoM.
        expect(del.status === 204 && save.status === 201, `round ${i}: delete ${del.status}, save ${save.status}`).toBe(false);
      }
    });
  });

  describe('concurrency', () => {
    it('two publishes of the same draft version → exactly one succeeds, the other 409; one new version', async () => {
      await createMaster(c, token, 'qa_pub', [{ key: 'a', label: 'A', type: 'text' }]);
      for (let round = 0; round < 3; round++) {
        const a = api(c, token);
        const d = await mustOk(a.get('/config/forms/qa_pub'));
        const fields = [...d.published.fields, { key: `f${round}`, label: `F${round}`, type: 'text' }];
        const saved = await mustOk(a.put('/config/forms/qa_pub/draft', { definition: { fields, validations: [] }, version: d.version }));
        const res = await Promise.all([1, 2].map(() => a.post('/config/forms/qa_pub/publish', { version: saved.version })));
        expect(res.map(r => r.status).sort()).toEqual([200, 409]);
        const versions = await mustOk(a.get('/config/forms/qa_pub/versions'));
        expect(versions.length).toBe(round + 2);
        expect(new Set(versions.map((v: { version: number }) => v.version)).size).toBe(versions.length);
      }
    });

    it('concurrent saves with the same unique value → one 201, the rest 409 on that field', async () => {
      await createMaster(c, token, 'qa_uniq', [{ key: 'serial', label: 'Serial', type: 'text', unique: true }]);
      for (let round = 0; round < 3; round++) {
        const serial = `SN-${uid(6)}`;
        const res = await Promise.all(Array.from({ length: 6 }, (_, i) =>
          api(c, token).post('/masters/qa_uniq/records', { code: `U${round}-${i}-${uid(3)}`, name: `Unit ${i}`, data: { serial: i % 2 ? serial : serial.toLowerCase() } })));
        expect(res.filter(r => r.status === 201)).toHaveLength(1);
        for (const r of res.filter(x => x.status !== 201)) {
          expect(r.status).toBe(409);
          expect(r.body.errors[0].path).toBe('serial');
        }
      }
    });

    it('concurrent creates with the same explicit code → one 201, the rest 409 on code (never 500)', async () => {
      await createMaster(c, token, 'qa_code');
      for (let round = 0; round < 3; round++) {
        const code = `C-${uid(5)}`;
        const res = await Promise.all(Array.from({ length: 6 }, (_, i) => api(c, token).post('/masters/qa_code/records', { code, name: `Dup ${i}` })));
        expect(res.map(r => r.status).filter(s => s === 201)).toHaveLength(1);
        expect(res.map(r => r.status).filter(s => s !== 201 && s !== 409)).toEqual([]);
      }
    });

    it('parallel auto-numbered creates get distinct sequential codes', async () => {
      await createMaster(c, token, 'qa_auto', [], { settings: { codePattern: 'QA-{SEQ:4}' } });
      const res = await Promise.all(Array.from({ length: 12 }, (_, i) => api(c, token).post('/masters/qa_auto/records', { name: `Auto ${i}` })));
      expect(res.map(r => r.status)).toEqual(Array(12).fill(201));
      const codes = res.map(r => r.body.code).sort();
      expect(codes).toEqual(Array.from({ length: 12 }, (_, i) => `QA-${String(i + 1).padStart(4, '0')}`));
    });
  });

  describe('location move races', () => {
    const tree = async () => (await sql<{ id: string; parent_id: string | null; path: string; depth: number; code: string }>`
      select id, parent_id, path::text as path, depth, code from app.location_node where tenant_id = ${tenantId}`.execute(c.db)).rows;

    /** Every node: path = parent.path || label(id), depth = nlevel(path), and walking parents terminates. */
    async function consistency(only: string[]) {
      const rows = await tree();
      const byId = new Map(rows.map(r => [r.id, r]));
      const label = (id: string) => `n${id.replace(/-/g, '')}`;
      const problems: string[] = [];
      for (const r of rows.filter(x => only.includes(x.id))) {
        const want = r.parent_id ? `${byId.get(r.parent_id)?.path}.${label(r.id)}` : label(r.id);
        if (r.path !== want) problems.push(`${r.code}: path ${r.path} != ${want}`);
        if (r.depth !== r.path.split('.').length) problems.push(`${r.code}: depth ${r.depth} != nlevel`);
        const seen = new Set<string>();
        let cur: string | null = r.id;
        while (cur) {
          if (seen.has(cur)) { problems.push(`${r.code}: cycle through ${byId.get(cur)?.code}`); break; }
          seen.add(cur);
          cur = byId.get(cur)?.parent_id ?? null;
        }
      }
      return problems;
    }

    async function node(code: string, parentId: string | null = null) {
      return mustOk(api(c, token).post('/locations', { code: `${code}-${uid(4)}`, name: code, parentId }), 201);
    }

    it('[QA2-BUG-005] moving two subtrees under each other at the same time cannot create a cycle', async () => {
      const problems: string[] = [];
      for (let round = 0; round < 6; round++) {
        const x = await node('X');
        const x1 = await node('X1', x.id);
        const y = await node('Y');
        const y1 = await node('Y1', y.id);
        const res = await Promise.all([
          api(c, token).post(`/locations/${x.id}/move`, { parentId: y1.id, version: x.version }),
          api(c, token).post(`/locations/${y.id}/move`, { parentId: x1.id, version: y.version }),
        ]);
        expect(res.map(r => r.status).every(s => s === 200 || s === 409)).toBe(true);
        problems.push(...(await consistency([x.id, x1.id, y.id, y1.id])).map(p => `round ${round} [${res.map(r => r.status)}]: ${p}`));
        if (problems.length) break;
      }
      expect(problems).toEqual([]);
    });

    it('overlapping moves (parent and child moved at once) leave every path = parent.path || label', async () => {
      const problems: string[] = [];
      for (let round = 0; round < 6; round++) {
        const p1 = await node('P1');
        const p2 = await node('P2');
        const p3 = await node('P3');
        const s = await node('S', p1.id);
        const b1 = await node('B1', s.id);
        const b2 = await node('B2', s.id);
        const res = await Promise.all([
          api(c, token).post(`/locations/${s.id}/move`, { parentId: p2.id, version: s.version }),
          api(c, token).post(`/locations/${b1.id}/move`, { parentId: p3.id, version: b1.version }),
          api(c, token).post(`/locations/${p1.id}/move`, { parentId: p3.id, version: p1.version }),
        ]);
        expect(res.map(r => r.status).every(st => st === 200 || st === 409), JSON.stringify(res.map(r => [r.status, r.body?.code]))).toBe(true);
        problems.push(...(await consistency([p1.id, p2.id, p3.id, s.id, b1.id, b2.id])).map(p => `round ${round} [${res.map(r => r.status)}]: ${p}`));
        if (problems.length) break;
      }
      expect(problems).toEqual([]);
    });
  });
});
