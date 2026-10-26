/** Performance smoke: 100k document lines → a grouped item-wise report answers in under 2 s. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { bulkCapex, reportsApi, reportsTenant, ReportsFixture } from './reports-helpers';

describe('reports performance', () => {
  let c: Ctx;
  let f: ReportsFixture;

  beforeAll(async () => {
    c = await bootApp();
    f = await reportsTenant(c);
    await bulkCapex(c, f, 10_000, 10, 'PERF'); // 100k lines
  }, 300_000);
  afterAll(async () => closeApp(c));

  it('100k lines grouped by item category and plant with sums < 2 s', async () => {
    const n = await c.db.selectFrom('app.document_line').select(eb => eb.fn.countAll<string>().as('n')).where('tenant_id', '=', f.tenantId).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(100_000);
    const r = reportsApi(c, f.token);
    const rep = await mustOk(r.create({
      key: 'perf_lines', name: 'Lines by category and plant', definition: {
        source: { kind: 'doc_line', key: 'capex' },
        columns: [
          { field: 'item.category.name' }, { field: 'location.top' }, { field: 'doc_date.month' },
          { field: 'line.amount', aggregate: 'sum' }, { field: 'qty.approved', aggregate: 'sum' }, { field: 'number', aggregate: 'count_distinct' },
        ],
        groupBy: ['item.category.name', 'location.top', 'doc_date.month'],
      },
    }), 201);
    await mustOk(r.run(rep.id)); // warm-up (catalogue, plans)
    const t0 = performance.now();
    const res = await mustOk(r.run(rep.id));
    const ms = performance.now() - t0;
    console.log(`grouped report over 100k lines: ${ms.toFixed(0)} ms, ${res.rows.length} groups`);
    expect(ms).toBeLessThan(2000);
    expect(res.totals[5]).toBe(10_000);
    expect(res.totals[3]).toBe(String(10_000 * 100 * 55) + '.00'); // Σ n·100 for n = 1..10 per doc
  }, 120_000);
});
