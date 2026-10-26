/**
 * Templates & PDF (Phase 6): template CRUD, defaults, plan gate, preview, context fields, the document context
 * builder (custom doc type + PO-like fixture with GST rows), TEMPLATE_RENDERER, starter templates, print permission
 * key and the generate_pdf effect registration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DbService } from '../src/core/db.service';
import { EFFECT_REGISTRY, EffectRegistry, TEMPLATE_RENDERER, TemplateRenderer } from '../src/core/ports';
import { StarterTemplates, STARTER_KEYS, TemplateContextExtensions, TemplatesInstaller } from '../src/modules/templates';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import { api, mustOk, userWithKeys } from './forms-helpers';
import { createCapexType, capexBody, docsApi } from './documents-helpers';
import { poxDoc, TplFixture, tplTenant } from './templates-helpers';

const PDF = (over: Record<string, unknown> = {}) => ({
  channel: 'pdf', docTypeKey: 'pox', key: `pox_${uid(6)}`, name: 'PO X layout', body: '<h1>{{document.number}}</h1><p>{{document.party.name}}</p>', ...over,
});

describe('templates API', () => {
  let c: Ctx;
  let f: TplFixture;
  let poxId: string;
  const tx = <T>(fn: Parameters<DbService['tenantTx']>[1] extends (t: infer X) => Promise<unknown> ? (t: X) => Promise<T> : never) => c.app.get(DbService).tenantTx(f.tenantId, fn);

  beforeAll(async () => {
    c = await bootApp();
    f = await tplTenant(c);
    poxId = (await poxDoc(c, f)).id;
  });
  afterAll(async () => { await closeApp(c); });

  describe('starter templates', () => {
    it('are installed per tenant with the agreed keys and one default per (channel, doc type)', async () => {
      const rows = await mustOk(api(c, f.token).get('/config/templates'));
      const keys = rows.map((r: { channel: string; key: string }) => `${r.channel}:${r.key}`);
      expect(keys).toEqual(expect.arrayContaining([
        `pdf:${STARTER_KEYS.poPdf}`, `pdf:${STARTER_KEYS.indentPdf}`, `pdf:${STARTER_KEYS.genericPdf}`, `email:${STARTER_KEYS.poApprovedEmail}`,
        `inapp:${STARTER_KEYS.approvalPendingInapp}`,
      ]));
      // comparison sheet: installed because procurement registers the `comparison` context extension (never default)
      expect(keys).toContain(`pdf:${STARTER_KEYS.comparisonPdf}`);
      expect(rows.find((r: { key: string }) => r.key === STARTER_KEYS.comparisonPdf)).toMatchObject({ docTypeKey: 'indent', isDefault: false });
      const po = rows.find((r: { key: string }) => r.key === STARTER_KEYS.poPdf);
      expect(po).toMatchObject({ channel: 'pdf', docTypeKey: 'po', isDefault: true, isActive: true, version: 1 });
      expect(po.pdfOptions.format).toBe('A4');
      const inapp = rows.find((r: { key: string }) => r.key === STARTER_KEYS.approvalPendingInapp);
      expect(inapp).toMatchObject({ channel: 'inapp', docTypeKey: null, isDefault: true });
      const email = rows.find((r: { key: string }) => r.key === STARTER_KEYS.poApprovedEmail);
      expect(email.subject).toContain('{{document.number}}');
    });

    it('installation is idempotent and never overwrites tenant edits', async () => {
      const before = await c.db.selectFrom('app.message_template').select(['key', 'version', 'is_default']).where('tenant_id', '=', f.tenantId).orderBy('key').execute();
      await tx(t => c.app.get(TemplatesInstaller).ensure(t, f.tenantId));
      await tx(t => c.app.get(StarterTemplates).install(t, f.tenantId));
      const after = await c.db.selectFrom('app.message_template').select(['key', 'version', 'is_default']).where('tenant_id', '=', f.tenantId).orderBy('key').execute();
      expect(after).toEqual(before);
    });

    it('a filtered list includes generic templates', async () => {
      const rows = await mustOk(api(c, f.token).get('/config/templates?channel=pdf&docType=pox'));
      expect(rows.map((r: { key: string }) => r.key)).toEqual([STARTER_KEYS.genericPdf]);
    });
  });

  describe('CRUD, defaults and plan gate', () => {
    it('creates the first PDF layout of a doc type without the pdf_templates feature, blocks the second', async () => {
      const a = api(c, f.token);
      const t = await mustOk(a.post('/config/templates', PDF({ isDefault: true })), 201);
      expect(t).toMatchObject({ channel: 'pdf', docTypeKey: 'pox', isDefault: true, version: 1 });
      const res = await a.post('/config/templates', PDF());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FEATURE_NOT_IN_PLAN');
      // inactive drafts don't count
      await mustOk(a.post('/config/templates', PDF({ isActive: false })), 201);
    });

    it('allows extra PDF layouts with the feature and keeps one default per (channel, doc type)', async () => {
      await c.db.insertInto('platform.tenant_override').values({ tenant_id: f.tenantId, kind: 'feature', key: 'pdf_templates', value: JSON.stringify(true), reason: 'test' }).execute();
      await c.app.get((await import('../src/core/entitlements.service')).EntitlementsService).invalidate(f.tenantId);
      const a = api(c, f.token);
      const second = await mustOk(a.post('/config/templates', PDF({ isDefault: true })), 201);
      const third = await mustOk(a.post('/config/templates', PDF({ isDefault: true })), 201);
      const defaults = await c.db.selectFrom('app.message_template').select('id').where('tenant_id', '=', f.tenantId).where('channel', '=', 'pdf')
        .where('doc_type_key', '=', 'pox').where('is_default', '=', true).execute();
      expect(defaults.map(d => d.id)).toEqual([third.id]);
      // switching the default back
      const cur = await c.db.selectFrom('app.message_template').select('version').where('id', '=', second.id).executeTakeFirstOrThrow();
      expect(cur.version).toBe(2); // un-defaulted by the third
      const upd = await mustOk(a.put(`/config/templates/${second.id}`, { ...PDF({ key: second.key, isDefault: true }), version: cur.version }));
      expect(upd).toMatchObject({ isDefault: true, version: 3 });
      const list = await mustOk(a.get('/config/templates?channel=pdf&docType=pox'));
      expect(list.filter((r: { isDefault: boolean; docTypeKey: string }) => r.isDefault && r.docTypeKey === 'pox')).toHaveLength(1);
      // the DB index enforces it too
      await expect(c.db.updateTable('app.message_template').set({ is_default: true }).where('id', '=', third.id).execute()).rejects.toThrow(/message_template_default/);
    });

    it('validates syntax, helpers, key uniqueness, doc type, email subject and WhatsApp template', async () => {
      const a = api(c, f.token);
      const bad = await a.post('/config/templates', PDF({ body: '{{#each lines}}' }));
      expect(bad.status).toBe(400);
      expect(bad.body.errors[0].path).toBe('body');
      const helper = await a.post('/config/templates', PDF({ body: '{{fetch "http://x"}}', pdfOptions: { footerHtml: '{{#if}}' } }));
      expect(helper.status).toBe(400);
      expect(helper.body.errors.map((e: { path: string }) => e.path)).toEqual(['body', 'pdfOptions.footerHtml']);
      const big = await a.post('/config/templates', PDF({ body: 'x'.repeat(200_001) }));
      expect(big.status).not.toBe(201);
      const dupKey = await a.post('/config/templates', { channel: 'inapp', key: STARTER_KEYS.approvalPendingInapp, name: 'dup', body: 'x' });
      expect(dupKey.status).toBe(400);
      expect(dupKey.body.errors[0].path).toBe('key');
      const badType = await a.post('/config/templates', { channel: 'email', docTypeKey: 'nope', key: `e_${uid(4)}`, name: 'x', body: 'x' });
      expect(badType.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['docTypeKey', 'subject']);
      const wa = await a.post('/config/templates', { channel: 'whatsapp', key: `w_${uid(4)}`, name: 'x', body: 'x', whatsappTemplateId: '0190a000-0000-7000-8000-000000000009' });
      expect(wa.status).toBe(400);
      expect(wa.body.errors[0].path).toBe('whatsappTemplateId');
      const wa2 = await a.post('/config/templates', { channel: 'whatsapp', key: `w_${uid(4)}`, name: 'x', body: 'x' });
      expect(wa2.body.errors[0].path).toBe('whatsappTemplateId');
    });

    it('updates with optimistic locking and soft-deletes', async () => {
      const a = api(c, f.token);
      const t = await mustOk(a.post('/config/templates', { channel: 'email', docTypeKey: 'pox', key: `mail_${uid(4)}`, name: 'Mail', subject: 'PO {{document.number}}', body: '<p>Hi</p>', isDefault: true }), 201);
      const stale = await a.put(`/config/templates/${t.id}`, { channel: 'email', docTypeKey: 'pox', key: t.key, name: 'Mail 2', subject: 's', body: 'b', version: 99 });
      expect(stale.status).toBe(409);
      const ok = await mustOk(a.put(`/config/templates/${t.id}`, { channel: 'email', docTypeKey: 'pox', key: t.key, name: 'Mail 2', subject: 's', body: 'b', isDefault: true, version: 1 }));
      expect(ok).toMatchObject({ name: 'Mail 2', version: 2 });
      const del = await mustOk(a.del(`/config/templates/${t.id}`));
      expect(del).toMatchObject({ isActive: false, isDefault: false });
      expect((await a.put(`/config/templates/0190a000-0000-7000-8000-00000000000a`, { ...PDF(), version: 1 })).status).toBe(404);
      expect((await a.del('/config/templates/not-a-uuid')).status).toBe(404);
      const audit = await c.db.selectFrom('app.audit_log').select('action').where('tenant_id', '=', f.tenantId).where('entity', '=', 'message_template').where('entity_id', '=', t.id).execute();
      expect(audit.map(x => x.action).sort()).toEqual(['create', 'delete', 'update']);
    });
  });

  describe('preview and context fields', () => {
    it('renders against a document with escaping, Indian formats and the letterhead', async () => {
      const a = api(c, f.token);
      const out = await mustOk(a.post('/config/templates/preview', {
        documentId: poxId,
        template: {
          channel: 'email', docTypeKey: 'pox', key: 'preview_x', name: 'Preview', subject: 'PO {{document.number}} — {{tenant.legalName}}',
          body: '<p>{{document.party.name}} | {{document.party.gstin}} | {{formatMoney totals.grand}} | {{document.values.remarks}} | {{document.display.priority}} | {{recipient.name}} | {{amountInWords totals.grand}}</p>',
        },
      }));
      expect(out.subject).toMatch(/^PO POX\/.+ — Acme Industries Private Limited$/);
      expect(out.html).toContain('Deccan Steel Traders | 27AAFCD5678K1Z3 | ₹1,74,455.90');
      expect(out.html).toContain('&lt;b&gt;Rush&lt;/b&gt; &lt;script&gt;alert(1)&lt;/script&gt;');
      expect(out.html).not.toContain('<script>');
      expect(out.html).toContain('| Urgent |');
      expect(out.html).toContain('Rupees One Lakh Seventy Four Thousand Four Hundred Fifty Five and Ninety Paise Only');
    });

    it('uses a sample document (or synthetic data) without a documentId; in-app renders plain text', async () => {
      const a = api(c, f.token);
      const sample = await mustOk(a.post('/config/templates/preview', { template: { channel: 'inapp', docTypeKey: 'pox', key: 'p_y', name: 'x', subject: '{{document.docTypeName}}', body: 'A & B {{document.number}}' } }));
      expect(sample.subject).toBe('Purchase Order X');
      expect(sample.html).toMatch(/^A & B POX\//);
      await createCapexType(c, f.token, 'emptytype');
      const synth = await mustOk(a.post('/config/templates/preview', { template: { channel: 'pdf', docTypeKey: 'emptytype', key: 'p_z', name: 'x', body: '{{document.number}} {{#each lines}}{{#each cells}}[{{label}}={{value}}]{{/each}}{{/each}}' } }));
      expect(synth.html).toContain('SAMPLE/0001');
      expect(synth.html).toContain('[Estimated rate=1000.00]');
      const bad = await a.post('/config/templates/preview', { template: { channel: 'pdf', key: 'p_q', name: 'x', body: '{{#each}}' } });
      expect(bad.status).toBe(400);
    });

    it('preview of a document the caller cannot see is a 404; wrong type is a 400', async () => {
      const u = await userWithKeys(c, f.token, f.code, ['config.templates:action.view']);
      const res = await api(c, u.token).post('/config/templates/preview', { documentId: poxId, template: { channel: 'pdf', key: 'p_w', name: 'x', body: 'x' } });
      expect(res.status).toBe(404);
      const wrong = await api(c, f.token).post('/config/templates/preview', { documentId: poxId, template: { channel: 'pdf', docTypeKey: 'emptytype', key: 'p_v', name: 'x', body: 'x' } });
      expect(wrong.status).toBe(400);
    });

    it('lists placeholder paths including every custom header and line field', async () => {
      const fields = await mustOk(api(c, f.token).get('/config/templates/context-fields?docType=pox'));
      const paths = fields.map((x: { path: string }) => x.path);
      expect(paths).toEqual(expect.arrayContaining(['tenant.gstin', 'document.number', 'document.values.freight', 'document.display.payment_terms',
        'lines[].values.discount_pct', 'lines[].display.remarks', 'lines[].item.hsn', 'totals.cgst', 'event.actor.name']));
      expect(fields.find((x: { path: string }) => x.path === 'document.party.name').example).toBe('Deccan Steel Traders');
      expect(fields.find((x: { path: string }) => x.path === 'lines[].item.hsn').example).toBe('8471');
      const generic = await mustOk(api(c, f.token).get('/config/templates/context-fields'));
      expect(generic.length).toBeGreaterThan(20);
    });
  });

  describe('document context builder', () => {
    it('builds the PO-like context: party, lines with HSN + GST split, totals, terms, letterhead', async () => {
      const r = c.app.get<TemplateRenderer>(TEMPLATE_RENDERER);
      const ctx = await tx(t => r.documentContext(t, poxId)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(ctx.tenant).toMatchObject({ legalName: 'Acme Industries Private Limited', gstin: '27AABCA1234F1Z9', pan: 'AABCA1234F', stateCode: '27', currency: 'INR' });
      expect(ctx.tenant.addressText).toBe('Plot 14, MIDC Bhosari, Pune - 411026, Maharashtra');
      expect(ctx.tenant.logoUrl).toMatch(new RegExp(`^/api/v1/files/${f.logoFileId}/content\\?t=`));
      expect(ctx.document).toMatchObject({ docTypeKey: 'pox', docTypeName: 'Purchase Order X', statusKey: 'approved', docDate: '2026-10-05', currency: 'INR', revNo: 0 });
      expect(ctx.document.url).toMatch(new RegExp(`/docs/pox/${poxId}$`));
      expect(ctx.document.party).toMatchObject({ name: 'Deccan Steel Traders', gstin: '27AAFCD5678K1Z3', state_code: '27', email: 'sales@deccan.test' });
      expect(ctx.document.display.payment_terms).toContain('30 days credit');
      expect(ctx.document.display.terms).toContain('Delivery');
      expect(ctx.document.display.freight).toBe('₹500.00');
      expect(ctx.document.display.expected_date).toBe('20-Oct-2026');
      expect(ctx.document.location).toMatchObject({ name: 'Pune plant' });
      expect(ctx.document.fields.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['location', 'doc_date', 'party', 'freight', 'remarks']));
      expect(ctx.lines).toHaveLength(2);
      expect(ctx.lines[0]).toMatchObject({ sr: 1, qty: '10.000', amount: '12505.00', taxable: '12505.00', taxAmount: '2250.90', total: '14755.90', gstRatePct: '18' });
      expect(ctx.lines[0].item).toMatchObject({ name: 'Laptop', hsn: '8471' });
      expect(ctx.lines[0].cgst).toMatchObject({ ratePct: '9', taxAmount: '1125.45' });
      expect(ctx.lines[0].igst).toBeNull();
      expect(ctx.lines[0].display.remarks).toBe('Core i7 & 16 GB');
      expect(ctx.lines[0].uom).toBeTruthy();
      expect(ctx.lineColumns.map((x: { label: string }) => x.label)).toEqual(expect.arrayContaining(['Item', 'Quantity', 'Rate', 'Amount', 'Discount %', 'Line remarks']));
      expect(ctx.totals).toMatchObject({ taxable: '147505.00', cgst: '13275.45', sgst: '13275.45', igst: '0.00', tax: '26550.90', freight: '500.00', discount: '100.00', grand: '174455.90', hasTax: true, isInterState: false });
      expect(ctx.totals.breakup.map((b: { label: string }) => b.label)).toEqual(['CGST @ 9%', 'SGST @ 9%']);
      expect(ctx.terms.map((x: { name: string }) => x.name)).toEqual(['Delivery', 'Invoicing']);
      expect(ctx.terms[1].body).toContain('&');
      expect(ctx.approvals).toEqual([]);
    });

    it('prefers the T&C snapshot, handles inter-state IGST and drafts', async () => {
      const d = await poxDoc(c, f, { submit: false, tax: 'inter', over: { party: f.vendorIgstId, terms: [] } });
      await c.db.updateTable('app.document').set({ custom: sql`custom || ${JSON.stringify({ terms_snapshot: [{ code: 'S1', name: 'Snap', body: 'Frozen text' }] })}::jsonb` }).where('id', '=', d.id).execute();
      const ctx = await tx(t => c.app.get<TemplateRenderer>(TEMPLATE_RENDERER).documentContext(t, d.id)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(ctx.document.isDraft).toBe(true);
      expect(ctx.totals).toMatchObject({ isInterState: true, igst: '26550.90', cgst: '0.00' });
      expect(ctx.terms).toEqual([{ code: 'S1', name: 'Snap', body: 'Frozen text' }]);
      expect(ctx.document.party.name).toBe('Kaveri Polymers');
    });

    it('works for a custom doc type without party or taxes (generic tables, approvals from the workflow)', async () => {
      await createCapexType(c, f.token, 'capex');
      const d = docsApi(c, f.token);
      const doc = await mustOk(d.create(capexBody(f)), 201);
      await c.db.updateTable('app.document_line').set({ status_key: 'cancelled' }).where('id', '=', doc.lines[1].id).execute();
      const ctx = await tx(t => c.app.get<TemplateRenderer>(TEMPLATE_RENDERER).documentContext(t, doc.id)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(ctx.document.party).toBeNull();
      expect(ctx.document.number).toBeNull();
      expect(ctx.document.display.purpose).toBe('New laptops for the design team');
      const cols = ctx.lineColumns.map((x: { key: string }) => x.key);
      expect(cols).toEqual(expect.arrayContaining(['item', 'uom', 'qty', 'est_rate', 'amount', 'remarks']));
      expect(cols).not.toContain('rate'); // hidden field
      expect(ctx.lines[0].cells.find((x: { key: string }) => x.key === 'est_rate').value).toBe('₹50,000.00');
      expect(ctx.lines[1]).toMatchObject({ cancelled: true, sr: null });
      expect(ctx.totals).toMatchObject({ hasTax: false, lineTotal: '100000.00', grand: '100000.00' });
    });

    it('lists workflow decisions as approvals', async () => {
      const inst = await c.db.selectFrom('app.wf_instance').select(['id', 'workflow_version_id']).where('tenant_id', '=', f.tenantId).limit(1).executeTakeFirst();
      // pox has no workflow: write a fake instance/version/action pair as the DB owner to exercise the mapping
      const type = await c.db.selectFrom('app.doc_type').select('id').where('tenant_id', '=', f.tenantId).where('key', '=', 'pox').executeTakeFirstOrThrow();
      const wf = await c.db.selectFrom('app.workflow_def').select('id').where('doc_type_id', '=', type.id).executeTakeFirst()
        ?? await c.db.insertInto('app.workflow_def').values({ tenant_id: f.tenantId, doc_type_id: type.id, name: 'PO X flow' }).returning('id').executeTakeFirstOrThrow();
      const ver = await c.db.insertInto('app.workflow_version').values({ tenant_id: f.tenantId, workflow_id: wf.id, version: 900, definition: JSON.stringify({ stages: [{ key: 'hod', name: 'HOD approval' }] }) }).returning('id').executeTakeFirstOrThrow();
      const i = await c.db.insertInto('app.wf_instance').values({ tenant_id: f.tenantId, document_id: poxId, workflow_version_id: ver.id, status: 'completed' }).returning('id').executeTakeFirstOrThrow();
      const lines = await c.db.selectFrom('app.document_line').select('id').where('document_id', '=', poxId).execute();
      await c.db.insertInto('app.wf_action').values([
        { tenant_id: f.tenantId, instance_id: i.id, at: new Date(Date.UTC(2026, 9, 6, 10, 1)), document_id: poxId, stage_key: 'hod', action: 'decide', actor_id: f.adminId, comment: 'ok', decisions: JSON.stringify(lines.map(l => ({ lineId: l.id, pending: '1', approve: '1', hold: '0', reject: '0' }))) },
        { tenant_id: f.tenantId, instance_id: i.id, at: new Date(Date.UTC(2026, 9, 6, 10, 2)), document_id: poxId, stage_key: 'hod', action: 'decide', actor_id: f.adminId, comment: null, decisions: JSON.stringify([{ lineId: lines[0]!.id, approve: '1', reject: '1' }]) },
        { tenant_id: f.tenantId, instance_id: i.id, at: new Date(Date.UTC(2026, 9, 6, 10, 3)), document_id: poxId, stage_key: 'hod', action: 'decide', actor_id: f.adminId, comment: null, decisions: JSON.stringify([{ lineId: lines[0]!.id, reject: '1' }]) },
        { tenant_id: f.tenantId, instance_id: i.id, at: new Date(Date.UTC(2026, 9, 6, 10, 4)), document_id: poxId, stage_key: 'hod', action: 'decide', actor_id: f.adminId, comment: null, decisions: JSON.stringify([{ lineId: lines[0]!.id, hold: '1' }]) },
      ]).execute();
      const ctx = await tx(t => c.app.get<TemplateRenderer>(TEMPLATE_RENDERER).documentContext(t, poxId)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(ctx.approvals.map((x: { outcome: string }) => x.outcome)).toEqual(['Approved', 'Partially approved', 'Rejected', 'On hold']);
      expect(ctx.approvals[0]).toMatchObject({ stage: 'HOD approval', by: 'Tenant Admin', comment: 'ok' });
      expect(inst === undefined || typeof inst.id === 'string').toBe(true);
    });
  });

  describe('context extensions (comparison sheet hook)', () => {
    it('runs an extension only for templates that mention its key, and installs the comparison layout once registered', async () => {
      const ext = c.app.get(TemplateContextExtensions);
      let calls = 0;
      ext.register({ key: 'comparison', docTypeKeys: ['pox'], build: async () => { calls++; return [{ itemName: 'Laptop', qty: '2', uom: 'NOS', vendors: [] }]; } });
      expect(() => ext.register({ key: 'Bad Key', docTypeKeys: [], build: async () => null })).toThrow();
      expect(ext.keys()).toContain('comparison');
      const a = api(c, f.token);
      const out = await mustOk(a.post('/config/templates/preview', { documentId: poxId, template: { channel: 'pdf', docTypeKey: 'pox', key: 'cmp', name: 'x', body: '{{#each comparison}}[{{itemName}}]{{/each}}' } }));
      expect(out.html).toContain('[Laptop]');
      await mustOk(a.post('/config/templates/preview', { documentId: poxId, template: { channel: 'pdf', docTypeKey: 'pox', key: 'cmp', name: 'x', body: 'none' } }));
      expect(calls).toBe(1);
      await tx(t => c.app.get(StarterTemplates).install(t, f.tenantId));
      const cmp = await c.db.selectFrom('app.message_template').select(['doc_type_key', 'is_default']).where('tenant_id', '=', f.tenantId).where('key', '=', STARTER_KEYS.comparisonPdf).executeTakeFirst();
      expect(cmp).toEqual({ doc_type_key: 'indent', is_default: false });
    });
  });

  describe('TEMPLATE_RENDERER port and starter content', () => {
    it('renders the in-app and email starters', async () => {
      const r = c.app.get<TemplateRenderer>(TEMPLATE_RENDERER);
      const ids = await c.db.selectFrom('app.message_template').select(['id', 'key']).where('tenant_id', '=', f.tenantId)
        .where('key', 'in', [STARTER_KEYS.approvalPendingInapp, STARTER_KEYS.poApprovedEmail]).execute();
      const byKey = Object.fromEntries(ids.map(x => [x.key, x.id]));
      const out = await tx(async t => {
        const ctx = await r.documentContext(t, poxId);
        const inapp = await r.render(t, byKey[STARTER_KEYS.approvalPendingInapp]!, { ...ctx, event: { type: 'document.submitted', actor: { name: 'Riya & Co' } } });
        const email = await r.render(t, byKey[STARTER_KEYS.poApprovedEmail]!, { ...ctx, recipient: { name: 'Deccan Sales' } });
        return { inapp, email };
      });
      expect(out.inapp.subject).toMatch(/^Purchase Order X POX\/.+ is waiting for your approval$/);
      expect(out.inapp.body).toMatch(/^Riya & Co submitted Purchase Order X POX\/.+ for Pune plant \(₹1,74,455\.90\)\. Please review it\.$/);
      expect(out.inapp.templateVersion).toBe(1);
      expect(out.email.subject).toMatch(/^Purchase Order POX\/.+ from Tenant /);
      expect(out.email.body).toContain('Dear Deccan Sales');
      expect(out.email.body).toContain('₹1,74,455.90');
      expect(out.email.body).toMatch(/^<!doctype html>/);
    });

    it('renders WhatsApp variables in index order as plain text', async () => {
      const tmplId = (await c.db.insertInto('app.message_template').values({
        tenant_id: f.tenantId, channel: 'whatsapp', key: `wa_${uid(4)}`, name: 'wa', body: '-', whatsapp_variables: JSON.stringify([{ index: 2, expr: '{{formatMoney totals.grand}}' }, { index: 1, expr: '{{document.party.name}} & co' }]),
      }).returning('id').executeTakeFirstOrThrow()).id;
      const r = c.app.get<TemplateRenderer>(TEMPLATE_RENDERER);
      const out = await tx(async t => r.render(t, tmplId, await r.documentContext(t, poxId)));
      expect(out.whatsappVariables).toEqual(['Deccan Steel Traders & co', '₹1,74,455.90']);
    });
  });

  describe('permissions, print key and effect registration', () => {
    it('requires config.templates keys', async () => {
      const u = await userWithKeys(c, f.token, f.code, ['admin.locations:action.view']);
      expect((await api(c, u.token).get('/config/templates')).status).toBe(403);
      const viewer = await userWithKeys(c, f.token, f.code, ['config.templates:action.view']);
      expect((await api(c, viewer.token).get('/config/templates')).status).toBe(200);
      expect((await api(c, viewer.token).post('/config/templates', PDF())).status).toBe(403);
    });

    it('every doc type gets the generated "Print / PDF" key; the backfill restores it for old types', async () => {
      const def = await c.db.selectFrom('app.permission_def').select(['label', 'kind']).where('tenant_id', '=', f.tenantId).where('key', '=', 'doc.pox:action.print').executeTakeFirst();
      expect(def).toEqual({ label: 'Print / PDF', kind: 'action' });
      await c.db.deleteFrom('app.permission_def').where('tenant_id', '=', f.tenantId).where('key', '=', 'doc.pox:action.print').execute();
      const n = await tx(t => c.app.get(StarterTemplates).backfillPrintKey(t, f.tenantId));
      expect(n).toBeGreaterThanOrEqual(1);
      expect(await tx(t => c.app.get(StarterTemplates).backfillPrintKey(t, f.tenantId))).toBe(0);
    });

    it('registers the generate_pdf effect', () => {
      expect(c.app.get<EffectRegistry>(EFFECT_REGISTRY).available([])).toContain('generate_pdf');
    });

    it('another tenant cannot touch these templates', async () => {
      const g = await tplTenant(c);
      const mine = await mustOk(api(c, f.token).get('/config/templates?channel=inapp'));
      const res = await api(c, g.token).put(`/config/templates/${mine[0].id}`, { channel: 'inapp', key: 'x_y', name: 'x', body: 'x', version: 1 });
      expect(res.status).toBe(404);
      expect((await api(c, g.token).post('/config/templates/preview', { documentId: poxId, template: { channel: 'pdf', key: 'p_w', name: 'x', body: 'x' } })).status).toBe(404);
    });
  });
});
