/**
 * Comparison-sheet PDF starter: procurement registers the `comparison` template context extension, so the starter
 * layout is installed (idempotently, also for tenants that existed before) and renders the quotes of an indent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService, Tx } from '../src/core/db.service';
import { DocumentContextBuilder, StarterTemplates, STARTER_KEYS, TemplateContextExtensions, TemplateRendererService, TemplatesInstaller } from '../src/modules/templates';
import { COMPARISON_BODY } from '../src/modules/templates/starters/bodies';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { approvedIndent, proc, procTenant, ProcFixture, quote } from './procurement-helpers';

describe('comparison sheet starter (procurement `comparison` context extension)', () => {
  let c: Ctx;
  let f: ProcFixture;
  const tx = <T>(fn: (t: Tx) => Promise<T>) => c.app.get(DbService).tenantTx(f.tenantId, fn);
  beforeAll(async () => {
    c = await bootApp();
    f = await procTenant(c);
  });
  afterAll(async () => closeApp(c));

  const installed = () => c.db.selectFrom('app.message_template').select(['id', 'key', 'is_default', 'version', 'doc_type_key'])
    .where('tenant_id', '=', f.tenantId).where('key', '=', STARTER_KEYS.comparisonPdf).execute();

  it('the extension is registered and the layout is installed once (non-default), also on a re-run for an existing tenant', async () => {
    expect(c.app.get(TemplateContextExtensions).has('comparison')).toBe(true);
    await tx(t => c.app.get(TemplatesInstaller).ensure(t, f.tenantId));
    // An existing tenant that never had it (e.g. created before this release): delete, re-run the installer.
    await c.db.deleteFrom('app.message_template').where('tenant_id', '=', f.tenantId).where('key', '=', STARTER_KEYS.comparisonPdf).execute();
    await tx(t => c.app.get(StarterTemplates).install(t, f.tenantId));
    await tx(t => c.app.get(StarterTemplates).install(t, f.tenantId));
    const rows = await installed();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ doc_type_key: 'indent', is_default: false, version: 1 });
  });

  it('renders the vendors of each item with landed cost and the best quote marked', async () => {
    const ind = await approvedIndent(c, f, ['100', '5']);
    const p = proc(c, f.buyer.token);
    await mustOk(p.logQuote(ind.lines[0].id, quote(f.vendors[0]!, { quotedRate: '50' })), 201);
    await mustOk(p.logQuote(ind.lines[0].id, quote(f.vendors[1]!, { quotedRate: '40' })), 201);
    const ctx = await tx(t => c.app.get(DocumentContextBuilder).build(t, ind.id, [COMPARISON_BODY]));
    const sheets = ctx.context.comparison as { itemName: string; qty: string; vendors: { vendor: { name: string }; isBest: boolean }[] }[];
    expect(sheets.map(s => s.itemName)).toEqual(['Steel rod', 'Copper wire']);
    expect(sheets[0]!.qty).toBe('100');
    expect(sheets[0]!.vendors.map(v => [v.vendor.name, v.isBest])).toEqual([['Vendor B', true], ['Vendor A', false]]);
    expect(sheets[1]!.vendors).toEqual([]);
    const [tpl] = await installed();
    const out = await tx(t => c.app.get(TemplateRendererService).render(t, tpl!.id, ctx.context));
    expect(out.body).toContain('Vendor B');
    expect(out.body).toContain('Best');
    expect(out.body).toContain('Copper wire');
  });

  it('templates that do not mention `comparison` never compute it', async () => {
    const ind = await approvedIndent(c, f, ['1']);
    const ctx = await tx(t => c.app.get(DocumentContextBuilder).build(t, ind.id, ['{{document.number}}']));
    expect('comparison' in ctx.context).toBe(false);
  });
});
