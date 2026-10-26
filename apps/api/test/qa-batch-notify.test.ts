/**
 * QA batch (Phases 4/6/7) — Phase 6 templates, PDF and notifications, black-box where possible:
 *   template injection safety (Handlebars helpers only, no prototype / constructor access, no partials), PDF network
 *   lock (more vectors than templates.pdf: CSS @import / @font-face / background, meta refresh, prefetch, object,
 *   SVG image, srcset, file:// frames, header/footer templates), PDF context totals vs the PO's GST totals, field
 *   access in print/preview, trigger rules firing exactly once (replays + concurrent consumers), quota exhaustion
 *   (concurrent consumers, manual send), webhook HMAC + SSRF guard (IP literal tricks, DNS answers, redirects with the
 *   real HTTPS transport), permissions (403) and cross-tenant isolation on every Phase 6 endpoint.
 *
 * Known bugs are `it.fails` with their QA47-BUG id (docs/qa/phase-4-6-7-report.md).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, Server } from 'node:http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { FilesService } from '../src/modules/files';
import { EntitlementsService } from '../src/core/entitlements.service';
import { httpsTransport, WebhooksService } from '../src/modules/notify';
import { verifyWebhookSignature } from '../src/modules/notify/util/signature';
import { StarterTemplates, STARTER_KEYS } from '../src/modules/templates';
import { PdfJobs } from '../src/modules/templates/pdf.service';
import { PdfRenderer, stripNavigation } from '../src/modules/templates/pdf.renderer';
import { PO_BODY, PO_BODY_PREVIOUS } from '../src/modules/templates/starters/bodies';
import { createCapexType, docsApi, docsTenant, DocsFixture } from './documents-helpers';
import { api, mustOk, userWithKeys } from './forms-helpers';
import { bootApp, closeApp, Ctx, uid } from './helpers';
import {
  cleanQueues, engine, event, makeNotifyDoc, messagesOf, notifyDocType, notifyTenant, NotifyTenant, provider, rule, stubPdf, templates, Templates, vendor,
} from './notify-helpers';
import { approvedSelection, poApi, poTenant } from './procurement-po-helpers';
import { DocType, submitDoc } from './workflow-helpers';

const CAPEX_VIEWS = ['draft', 'on_hold', 'partially_approved', 'approved', 'rejected', 'cancelled', 'closed'].map(v => `doc.capex:view.${v}`);

let c: Ctx;
beforeAll(async () => {
  process.env.PDF_CHROMIUM_PATH ??= '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  c = await bootApp();
}, 60_000);
afterAll(async () => {
  await cleanQueues(c);
  await closeApp(c);
});

// ===================================================================================================== templates
describe('template injection safety', () => {
  let f: DocsFixture;
  let docId: string;
  beforeAll(async () => {
    f = await docsTenant(c);
    await createCapexType(c, f.token);
    const d = await mustOk(docsApi(c, f.token).create({
      values: { location: f.pune, purpose: '<img src=x onerror=alert(1)>{{7*7}}', doc_date: '2026-10-01' },
      lines: [{ values: { item: f.items[0], qty: '2', est_rate: '50000' } }],
    }), 201);
    docId = d.id;
  });
  const tpl = (body: string, channel = 'email') => ({ channel, docTypeKey: 'capex', key: `q_${uid(6)}`, name: 'QA', subject: 'S', body });

  const PAYLOADS: [string, string][] = [
    ['constructor chain', '{{constructor.constructor "return process.env"}}'],
    ['lookup constructor', '{{#with (lookup this "constructor") as |k|}}{{lookup k "name"}}{{/with}}'],
    ['__proto__ lookup', '{{lookup document "__proto__"}}{{document.__proto__.constructor}}'],
    ['classic split/apply RCE', `{{#with "s" as |string|}}{{#with "e"}}{{#with split as |conslist|}}{{this.pop}}{{this.push (lookup string.sub "constructor")}}{{this.pop}}{{#with string.split as |codelist|}}{{this.pop}}{{this.push "return require('child_process').execSync('id').toString();"}}{{this.pop}}{{#each conslist}}{{#with (string.sub.apply 0 codelist)}}RCE:{{this}}{{/with}}{{/each}}{{/with}}{{/with}}{{/with}}{{/with}}`],
    ['each over prototype', '{{#each (lookup this "__proto__")}}{{@key}}{{/each}}'],
    ['valueOf/toString', '{{document.number.constructor.name}}{{document.toString}}{{document.valueOf}}'],
  ];
  for (const [name, body] of PAYLOADS) {
    it(`payload "${name}" never reaches JS internals (save refused or renders inert)`, async () => {
      const a = api(c, f.token);
      const pre = await a.post('/config/templates/preview', { template: tpl(body), documentId: docId });
      expect([200, 400]).toContain(pre.status);
      const out = JSON.stringify(pre.body);
      expect(out).not.toMatch(/RCE:|uid=\d|PATH=|NODE_|function Object|\[native code\]|Function|process/);
      const saved = await a.post('/config/templates', tpl(body));
      expect([201, 400]).toContain(saved.status);
    });
  }

  it('unknown helpers, partials, log, inline/decorator syntax are compile errors at save time', async () => {
    const a = api(c, f.token);
    for (const body of ['{{exec "id"}}', '{{> evil}}', '{{log "x"}}', '{{helperMissing "x"}}', '{{*inline "p"}}x{{/inline}}', '{{#blockHelperMissing x}}{{/blockHelperMissing}}']) {
      const r = await a.post('/config/templates', tpl(body));
      expect([body, r.status]).toEqual([body, 400]);
    }
    // a partial block with no registered partial only renders its own fallback content
    const pb = await a.post('/config/templates/preview', { template: tpl('{{#> layout}}fallback{{/layout}}'), documentId: docId });
    if (pb.status === 200) expect(pb.body.html).toContain('fallback');
  });

  it('document data with HTML / mustaches is escaped and never re-evaluated', async () => {
    const r = await mustOk(api(c, f.token).post('/config/templates/preview', { template: tpl('<p>{{document.values.purpose}}</p><p>{{lookup document.values "purpose"}}</p>'), documentId: docId }));
    expect(r.html).not.toContain('<img src=x');
    expect(r.html).toContain('&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;{{7*7}}');
    expect(r.html).not.toContain('49');
  });

  it('oversized and pathological templates are refused / time-boxed (no 500)', async () => {
    const a = api(c, f.token);
    expect((await a.post('/config/templates', tpl('x'.repeat(200_001)))).status).toBe(400);
    const nest = '{{#each document.lines}}'.repeat(60) + 'x' + '{{/each}}'.repeat(60);
    expect([200, 400]).toContain((await a.post('/config/templates/preview', { template: tpl(nest), documentId: docId })).status);
  });

  // QA47-BUG-006: the render context is built as the system (no field access): a user whose role hides a line field
  // gets it back through preview (and the PDF / email built from the same context).
  it('QA47-BUG-006: preview/print respect field access — a hidden line field (est_rate) is not rendered for that user', async () => {
    const u = await userWithKeys(c, f.token, f.code, ['doc.capex:action.view', 'doc.capex:action.print', ...CAPEX_VIEWS, 'config.templates:action.view'], {
      'doc.capex': { fieldAccess: [{ formKey: 'capex_line', fieldKey: 'est_rate', mode: 'hidden' }] },
    });
    await mustOk(api(c, f.token).put(`/roles/${u.roleId}/scope`, { entries: [{ allNodes: true }] }));
    await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
    // control: the document API hides it
    const det = await mustOk(docsApi(c, u.token).get(docId));
    expect(det.lines[0].values.est_rate).toBeUndefined();
    const r = await mustOk(api(c, u.token).post('/config/templates/preview', { template: tpl('{{#each lines}}R={{values.est_rate}};{{/each}}'), documentId: docId }));
    expect(r.html).not.toContain('50000');
  });

  it('QA47-BUG-006 regression: hidden fields are gone from every context path (cells, display, columns, amounts) and the PDF; the admin still sees them', async () => {
    const u = await userWithKeys(c, f.token, f.code, ['doc.capex:action.view', 'doc.capex:action.print', 'doc.capex:action.send_email', ...CAPEX_VIEWS, 'config.templates:action.view'], {
      'doc.capex': { fieldAccess: [{ formKey: 'capex_line', fieldKey: 'est_rate', mode: 'hidden' }] },
    });
    await mustOk(api(c, f.token).put(`/roles/${u.roleId}/scope`, { entries: [{ allNodes: true }] }));
    await c.app.get(EntitlementsService).bumpPermissions(f.tenantId);
    // manual send preview (vendor-facing): rendered with the sender's access
    const mail = await mustOk(api(c, f.token).post('/config/templates', tpl('<p>{{#each lines}}R={{values.est_rate}};{{/each}}</p>')), 201);
    const sp = await mustOk(api(c, u.token).post(`/docs/capex/${docId}/send/preview`, { channel: 'email', templateId: mail.id, recipients: ['x@vendor.test'] }));
    expect(sp.body).toContain('R=;');
    const spa = await mustOk(api(c, f.token).post(`/docs/capex/${docId}/send/preview`, { channel: 'email', templateId: mail.id, recipients: ['x@vendor.test'] }));
    expect(spa.body).toMatch(/R=50000(\.00)?;/);
    const body = '{{#each lines}}D={{display.est_rate}};A={{amount}};{{#each cells}}[{{key}}={{value}}]{{/each}}{{/each}}{{#each lineColumns}}<{{key}}>{{/each}}T={{totals.lineTotal}};G={{totals.grand}};V={{lookup document "totalAmount"}}';
    const mine = await mustOk(api(c, u.token).post('/config/templates/preview', { template: tpl(body), documentId: docId }));
    expect(mine.html).not.toMatch(/50,?000|1,?00,?000|100000/);
    expect(mine.html).not.toContain('est_rate');
    const admin = await mustOk(api(c, f.token).post('/config/templates/preview', { template: tpl(body), documentId: docId }));
    expect(admin.html).toMatch(/50,?000/);

    // print: the user's PDF is a separate cache variant without the field; the admin's PDF is not theirs to fetch
    const jobs = c.app.get(PdfJobs);
    const pu = await mustOk(api(c, u.token).post(`/docs/capex/${docId}/print`, {}));
    const pa = await mustOk(api(c, f.token).post(`/docs/capex/${docId}/print`, {}));
    expect(pu.id).not.toBe(pa.id);
    for (const id of [pu.id, pa.id]) {
      await jobs.process({ data: { tenantId: f.tenantId, id }, attemptsMade: 0, opts: { attempts: 1 } });
      expect((await jobs.waitFor(f.tenantId, id, 1000))?.status).toBe('ready');
    }
    const text = async (id: string) => {
      const row = await jobs.waitFor(f.tenantId, id, 1000);
      const bytes = await c.app.get(DbService).tenantTx(f.tenantId, async tx => {
        const fo = await c.app.get(FilesService).loadOne(tx, f.tenantId, row!.file_id!);
        return c.app.get(FilesService).storage.get(fo!.storage_key);
      });
      const dir = mkdtempSync(join(tmpdir(), 'qa47-006-'));
      writeFileSync(join(dir, 'x.pdf'), bytes);
      return execFileSync('pdftotext', [join(dir, 'x.pdf'), '-'], { encoding: 'utf8' });
    };
    expect(await text(pu.id)).not.toMatch(/50,000/);
    expect(await text(pa.id)).toMatch(/50,000/);
    expect((await api(c, u.token).get(`/pdf-jobs/${pa.id}`)).status).toBe(404);
    expect((await api(c, f.token).get(`/pdf-jobs/${pu.id}`)).status).toBe(200);
    // the same user printing again reuses their variant
    expect((await mustOk(api(c, u.token).post(`/docs/capex/${docId}/print`, {}))).id).toBe(pu.id);
  }, 90_000);
});

// ===================================================================================================== PO PDF totals
describe('PO template context totals', () => {
  // QA47-BUG-007: context.totals.grand subtracts the PO header discount again although the GST engine already
  // allocated it into the taxable value → the PO PDF / email grand total (and amount in words) is short by the discount.
  it('QA47-BUG-007: totals.grand of a PO with a header discount equals the PO grand_total', async () => {
    const f = await poTenant(c);
    const { selection } = await approvedSelection(c, f, ['10'], [[0, 0, '10', '100']]);
    const [po] = await mustOk(poApi(c, f.po.token).fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '10' }], values: { discount_amount: '100', freight: '50' } }), 201);
    expect(po.values.grand_total).toBe('1112.00'); // (1000 − 100) × 1.18 + 50
    const r = await mustOk(api(c, f.token).post('/config/templates/preview', {
      template: { channel: 'email', docTypeKey: 'po', key: 'qa_tot', name: 'tot', subject: 's', body: '<p>G={{totals.grand}} T={{totals.taxable}} D={{totals.discount}}</p>' }, documentId: po.id,
    }));
    expect(r.html).toContain('T=900.00');
    expect(r.html).toContain('G=1112.00');
  });

  it('QA47-BUG-007 regression: the starter PO layout shows the discount once (before taxable) and the PO grand total', async () => {
    const f = await poTenant(c);
    const { selection } = await approvedSelection(c, f, ['10'], [[0, 0, '10', '100']]);
    const [po] = await mustOk(poApi(c, f.po.token).fromLines({ picks: [{ sourceLineId: selection.lines[0].id, qty: '10' }], values: { discount_amount: '100', freight: '50' } }), 201);
    const r = await mustOk(api(c, f.token).post('/config/templates/preview', {
      template: { channel: 'pdf', docTypeKey: 'po', key: 'qa_po_std', name: 'po', body: PO_BODY }, documentId: po.id,
    }));
    expect(r.html).toContain('1,112.00');
    expect(r.html).not.toContain('1,012.00');
    expect(r.html.match(/<td class="num">− /g)?.length).toBe(1); // one deduction row
    expect(r.html.indexOf('Less: discount')).toBeLessThan(r.html.indexOf('Taxable value</td>'));
    expect(r.html).toContain('1,000.00'); // amount before discount
  });

  it('QA47-BUG-007 regression: the installer upgrades an unmodified PO starter, never an edited one, and is idempotent', async () => {
    const f = await poTenant(c);
    const db = c.app.get(DbService);
    const run = () => db.tenantTx(f.tenantId, t => c.app.get(StarterTemplates).install(t, f.tenantId));
    await run();
    const row = () => c.db.selectFrom('app.message_template').select(['id', 'body', 'version']).where('tenant_id', '=', f.tenantId)
      .where('channel', '=', 'pdf').where('key', '=', STARTER_KEYS.poPdf).executeTakeFirstOrThrow();
    const set = (body: string) => c.db.updateTable('app.message_template').set({ body }).where('tenant_id', '=', f.tenantId).where('channel', '=', 'pdf').where('key', '=', STARTER_KEYS.poPdf).execute();
    expect(PO_BODY_PREVIOUS[0]).not.toBe(PO_BODY);
    await set(PO_BODY_PREVIOUS[0]!);
    const old = await row();
    await run();
    const upgraded = await row();
    expect(upgraded.body).toBe(PO_BODY);
    expect(upgraded.version).toBe(old.version + 1);
    await run();
    expect((await row()).version).toBe(upgraded.version);
    const edited = `${PO_BODY_PREVIOUS[0]}<!-- tenant edit -->`;
    await set(edited);
    await run();
    expect((await row()).body).toBe(edited);
  });
});

// ===================================================================================================== PDF lock
describe('PDF network lock (real Chromium)', () => {
  let server: Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createHttpServer((req, res) => { hits.push(req.url ?? ''); res.setHeader('content-type', 'text/css'); res.end('body{color:red}'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise(r => server.close(r)); });

  it('blocks CSS @import / @font-face / background, meta refresh, prefetch, object/embed, SVG image, srcset, file:// frames and header/footer images', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa47-'));
    const secret = join(dir, 'secret.html');
    const marker = `SECRET-${uid(10)}`;
    writeFileSync(secret, `<p>${marker}</p>`);
    const u = (p: string) => `http://127.0.0.1:${port}/${p}`;
    const html = `<html><head>
      <link rel="prefetch" href="${u('prefetch')}"><link rel="preload" as="image" href="${u('preload')}"><link rel="icon" href="${u('icon')}">
      <style>@import url("${u('import.css')}"); @font-face { font-family: X; src: url("${u('font.woff')}"); } body { font-family: X; background: url("${u('bg.png')}"); }</style>
      <base href="${u('base/')}"></head><body><h1>Lock</h1><p style="font-family:X">text</p>
      <object data="${u('object')}"></object><embed src="${u('embed')}"><video poster="${u('poster.png')}"></video>
      <svg width="10" height="10"><image href="${u('svg.png')}" width="10" height="10"/></svg>
      <img srcset="${u('srcset.png')} 1x"><img src="relative.png"><iframe src="file://${secret}"></iframe><iframe src="${u('frame')}"></iframe>
      <form action="${u('form')}"><input type="image" src="${u('input.png')}"></form></body></html>`;
    const res = await c.app.get(PdfRenderer).render(html, {
      format: 'A4', landscape: false, marginMm: { top: 20, right: 10, bottom: 20, left: 10 },
      headerHtml: `<div style="font-size:8px"><img src="${u('header.png')}">H</div>`, footerHtml: `<div style="font-size:8px;background:url(${u('footer.png')})">F</div>`,
    }, () => Promise.resolve(null));
    expect(res.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hits).toEqual([]);
    const pdfFile = join(dir, 'x.pdf');
    writeFileSync(pdfFile, res.pdf);
    const text = execFileSync('pdftotext', [pdfFile, '-'], { encoding: 'utf8' });
    expect(text).toContain('Lock');
    expect(text).not.toContain(marker);
  }, 60_000);

  // QA47-BUG-009 (Low, intermittent — not an it.fails because it is timing-dependent): a <meta http-equiv="refresh">
  // navigates the page to a blocked URL while it prints; with several blocked resources Chromium often fails with
  // "Printing failed" and the PDF job fails. The lock itself holds: no request ever leaves.
  it('meta refresh in a layout never leaks a request (render failures counted for QA47-BUG-009)', async () => {
    const u = (p: string) => `http://127.0.0.1:${port}/${p}`;
    const head = `<meta http-equiv="refresh" content="0;url=${u('refresh')}"><link rel="prefetch" href="${u('p')}"><base href="${u('b/')}">
      <style>@import url("${u('i.css')}"); @font-face{font-family:X;src:url("${u('f')}")} p{font-family:X}</style>`;
    const body = `<h1>x</h1><p>t</p><object data="${u('o')}"></object><embed src="${u('e')}"><video poster="${u('v')}"></video>
      <svg width="10" height="10"><image href="${u('s')}" width="10" height="10"/></svg><iframe src="file:///etc/hostname"></iframe>
      <form action="${u('f')}"><input type="image" src="${u('i')}"></form><img src="rel.png">`;
    let failed = 0;
    for (let i = 0; i < 3; i++) {
      try {
        await c.app.get(PdfRenderer).render(`<html><head>${head}</head><body>${body}</body></html>`,
          { format: 'A4', landscape: false, marginMm: { top: 20, right: 10, bottom: 20, left: 10 } }, () => Promise.resolve(null), 10_000);
      } catch (e) {
        failed++;
        expect((e as Error).message).toMatch(/Printing failed|navigat|Target|closed/i);
      }
    }
    console.info(`[QA47-BUG-009] meta-refresh renders failed ${failed}/3`);
    expect(failed).toBe(0); // fixed: navigation is stripped before rendering
    expect(hits).toEqual([]);
  }, 60_000);

  it('QA47-BUG-009 regression: stripNavigation removes every http-equiv meta (any case / quoting / entity-encoded) and keeps the rest', () => {
    const cases = [
      '<meta http-equiv="refresh" content="0;url=http://x/">',
      "<META HTTP-EQUIV='Refresh' CONTENT='1; URL=/'>",
      '<meta http-equiv=refresh content=0>',
      '<meta content="0;url=http://x/>y" http-equiv="&#114;efresh">',
      '<meta\nhttp-equiv="refresh"\ncontent="0">',
    ];
    for (const m of cases) {
      const out = stripNavigation(`<html><head>${m}<meta charset="utf-8"><meta name="x" content="y"></head><body>B</body></html>`);
      expect(out).not.toMatch(/http-equiv/i);
      expect(out).toContain('<meta charset="utf-8">');
      expect(out).toContain('<meta name="x" content="y">');
      expect(out).toContain('<body>B</body>');
    }
  });

  it('QA47-BUG-009 regression: a refresh back to the page itself cannot reload it while printing', async () => {
    const html = `<html><head><meta http-equiv="refresh" content="0"></head><body><h1>Once</h1></body></html>`;
    for (let i = 0; i < 3; i++) {
      const res = await c.app.get(PdfRenderer).render(html, { format: 'A4', landscape: false, marginMm: { top: 10, right: 10, bottom: 10, left: 10 } }, () => Promise.resolve(null), 10_000);
      expect(res.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  }, 60_000);
});

// ===================================================================================================== trigger rules + quotas
describe('trigger rules fire exactly once; quota exhaustion', () => {
  let t: NotifyTenant;
  let dt: DocType;
  let tpl: Templates;
  let pdf: ReturnType<typeof stubPdf>;
  beforeAll(async () => {
    t = await notifyTenant(c, { limits: { email_per_month: 3 } });
    dt = await notifyDocType(c, t);
    tpl = await templates(c, t, dt.key);
    await provider(c, t, 'email');
    pdf = stubPdf(c);
  });
  afterAll(() => pdf.restore());

  it('the same event replayed and consumed concurrently (5×) creates one message per recipient; two matching rules → one each', async () => {
    const ven = await vendor(c, t, { email: 'once@vendor.test' });
    const r1 = await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] });
    const r2 = await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, channel: 'inapp', templateId: tpl.inapp, recipients: [{ type: 'users', userIds: [t.adminId] }] });
    const d = await makeNotifyDoc(c, t, dt, { party: ven.id });
    await submitDoc(c, t, d, t.adminId);
    const evt = event(t, 'document.submitted', d.id);
    await Promise.all(Array.from({ length: 5 }, () => engine(c).handle(evt)));
    await engine(c).handle(evt);
    const rows = await messagesOf(c, t.tenantId, d.id);
    expect(rows.map(r => [r.trigger_rule_id, r.channel]).sort()).toEqual([[r1.id, 'email'], [r2.id, 'inapp']].sort());
    const notes = await c.db.selectFrom('app.notification').select('id').where('tenant_id', '=', t.tenantId).where('kind', '=', 'message')
      .where(eb => eb.ref('data', '->>').key('documentId' as never), '=', d.id as never).execute().catch(() => null);
    if (notes) expect(notes.length).toBe(1);
    // a NEW event (another outbox id) for the same document is a new message
    await engine(c).handle(event(t, 'document.submitted', d.id));
    expect((await messagesOf(c, t.tenantId, d.id)).filter(r => r.channel === 'email')).toHaveLength(2);
    await c.db.updateTable('app.trigger_rule').set({ is_active: false }).where('tenant_id', '=', t.tenantId).execute();
  });

  it('quota 3/month: the 4th email (concurrent consumers) is blocked_limit, never queued; manual send is blocked too; 80/100% notified once', async () => {
    // 2 emails already used above (one per new event); 1 left
    await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'fixed', address: 'q1@x.test' }] });
    const docs: { id: string; lineIds: string[] }[] = [];
    for (let i = 0; i < 4; i++) {
      const d = await makeNotifyDoc(c, t, dt);
      await submitDoc(c, t, d, t.adminId);
      docs.push(d);
    }
    await Promise.all(docs.map(d => engine(c).handle(event(t, 'document.submitted', d.id))));
    const rows = (await messagesOf(c, t.tenantId)).filter(r => docs.some(d => d.id === r.document_id));
    expect(rows.map(r => r.status).sort()).toEqual(['blocked_limit', 'blocked_limit', 'blocked_limit', 'queued']);
    const usage = await c.db.selectFrom('app.outbound_message').select('id').where('tenant_id', '=', t.tenantId).where('channel', '=', 'email').where('status', 'in', ['queued', 'sent', 'sending']).execute();
    expect(usage.length).toBe(3);
    const notes = await c.db.selectFrom('app.notification').select(['data']).where('tenant_id', '=', t.tenantId).where('kind', '=', 'limit_warning').execute();
    const th = notes.map(n => (n.data as { threshold: number; limitKey: string })).filter(n => n.limitKey === 'email_per_month').map(n => n.threshold).sort();
    // 66% → 100% in one step: the 100% notice supersedes 80% (exactly one notice per crossing, never duplicated)
    expect(th).toContain(100);
    expect(new Set(th).size).toBe(th.length);
    // manual send while exhausted
    const v = await vendor(c, t, { email: 'm@vendor.test' });
    const md = await makeNotifyDoc(c, t, dt, { party: v.id });
    await submitDoc(c, t, md, t.adminId);
    const sent = await api(c, t.token).post(`/docs/${dt.key}/${md.id}/send`, { channel: 'email', templateId: tpl.email, recipients: ['m@vendor.test'], idempotencyKey: `qa47-${uid(8)}` });
    expect([200, 201, 409, 429]).toContain(sent.status);
    const m = await messagesOf(c, t.tenantId, md.id);
    expect(m.every(x => x.status !== 'queued' && x.status !== 'sent')).toBe(true);
  });
});

// ===================================================================================================== webhooks
describe('webhooks: HMAC signature, SSRF guard, redirects', () => {
  let t: NotifyTenant;
  let hooks: WebhooksService;
  let orig: { transport: WebhooksService['transport']; resolver: WebhooksService['resolver'] };
  const dns: Record<string, string[]> = { 'hooks.example.test': ['93.184.216.34'], 'rebind.example.test': ['10.1.2.3'], 'mixed.example.test': ['93.184.216.34', '192.168.1.10'], 'meta.example.test': ['169.254.169.254'], 'v6.example.test': ['::ffff:127.0.0.1'] };
  const sent: { headers: Record<string, string>; body: string; address: string }[] = [];
  let reply: { status: number; body: string } = { status: 200, body: 'ok' };
  beforeAll(async () => {
    t = await notifyTenant(c);
    hooks = c.app.get(WebhooksService);
    orig = { transport: hooks.transport, resolver: hooks.resolver };
    hooks.resolver = async h => (dns[h] ? dns[h]!.map(a => ({ address: a, family: a.includes(':') ? 6 : 4 })) : Promise.reject(new Error('ENOTFOUND')));
    hooks.transport = async r => { sent.push({ headers: r.headers, body: r.body, address: r.address }); return reply; };
  });
  afterAll(() => { hooks.transport = orig.transport; hooks.resolver = orig.resolver; });

  it('SSRF: private / loopback / link-local / metadata / mapped IPv6 / numeric-encoded hosts / credentials / http / bad DNS answers → 400', async () => {
    const a = api(c, t.token);
    const bad = [
      'https://127.0.0.1/h', 'https://127.1/h', 'https://2130706433/h', 'https://0x7f.0.0.1/h', 'https://0177.0.0.1/h', 'https://0.0.0.0/h', 'https://10.0.0.1/h',
      'https://172.31.255.255/h', 'https://192.168.0.1/h', 'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/h', 'https://[::1]/h',
      'https://[::ffff:127.0.0.1]/h', 'https://[::ffff:a9fe:a9fe]/h', 'https://[fd00:ec2::254]/h', 'https://[fe80::1]/h', 'https://[64:ff9b::7f00:1]/h',
      'https://[2002:7f00:1::]/h', 'https://[::]/h', 'https://localhost/h', 'https://localhost./h', 'https://a.localhost/h', 'https://metadata.google.internal/h',
      'https://printer.local/h', 'https://user:pw@hooks.example.test/h', 'http://hooks.example.test/h', 'https://rebind.example.test/h',
      'https://mixed.example.test/h', 'https://meta.example.test/h', 'https://v6.example.test/h', 'https://nxdomain.example.test/h', 'ftp://hooks.example.test/h',
      'https://224.0.0.1/h', 'https://255.255.255.255/h',
    ];
    const out: string[] = [];
    for (const url of bad) {
      const r = await a.post('/config/webhooks', { url, events: ['document.submitted'] });
      if (r.status !== 400) out.push(`${url} → ${r.status}`);
    }
    expect(out).toEqual([]);
    expect((await mustOk(a.get('/config/webhooks'))).length).toBe(0);
  });

  it('HMAC: secret shown once, encrypted at rest, never listed; signature verifies over t + body and fails when tampered', async () => {
    const a = api(c, t.token);
    const ep = await mustOk(a.post('/config/webhooks', { url: 'https://hooks.example.test/in', events: ['*'] }), 201);
    expect(ep.secret).toMatch(/^whsec_/);
    const row = await c.db.selectFrom('app.webhook_endpoint').select('secret').where('id', '=', ep.id).executeTakeFirstOrThrow();
    expect(row.secret).not.toContain(ep.secret);
    expect(JSON.stringify(await mustOk(a.get('/config/webhooks')))).not.toContain(ep.secret);
    expect(JSON.stringify(await mustOk(a.get(`/config/webhooks/${ep.id}`)))).not.toContain(ep.secret);
    const audit = await c.db.selectFrom('app.audit_log').select(['before', 'after']).where('tenant_id', '=', t.tenantId).where('entity_id', '=', ep.id).execute().catch(() => []);
    expect(JSON.stringify(audit)).not.toContain(ep.secret);
    sent.length = 0;
    reply = { status: 200, body: 'ok' };
    const del = await mustOk(a.post(`/config/webhooks/${ep.id}/test`));
    expect(del.status).toBe('delivered');
    const s = sent[0]!;
    expect(s.address).toBe('93.184.216.34');
    const sig = s.headers['X-Procure-Signature']!;
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(ep.secret, s.body, sig)).toBe(true);
    expect(verifyWebhookSignature(ep.secret, s.body.replace('test', 'tesT'), sig)).toBe(false);
    expect(verifyWebhookSignature('whsec_wrong', s.body, sig)).toBe(false);
    expect(verifyWebhookSignature(ep.secret, s.body, sig, 300, Math.floor(Date.now() / 1000) + 3600)).toBe(false); // replay window
    expect(JSON.parse(s.body)).toMatchObject({ type: 'webhook.test', tenant: { id: t.tenantId } });
    expect(s.headers['X-Procure-Delivery']).toBe(del.id);
    await mustOk(a.del(`/config/webhooks/${ep.id}`), 200, 204);
  });

  it('send-time re-check: an endpoint whose DNS later answers a private address is blocked before connecting; 3xx is a failure, not followed', async () => {
    const a = api(c, t.token);
    dns['later.example.test'] = ['93.184.216.34'];
    const ep = await mustOk(a.post('/config/webhooks', { url: 'https://later.example.test/in', events: ['document.submitted'] }), 201);
    dns['later.example.test'] = ['93.184.216.34', '127.0.0.1'];
    sent.length = 0;
    const d1 = await mustOk(a.post(`/config/webhooks/${ep.id}/test`));
    expect(d1.status).toBe('failed');
    expect(sent).toHaveLength(0);
    dns['later.example.test'] = ['93.184.216.34'];
    reply = { status: 302, body: '' };
    const d2 = await mustOk(a.post(`/config/webhooks/${ep.id}/test`));
    expect(d2).toMatchObject({ status: 'failed', responseCode: 302 });
    expect(sent).toHaveLength(1);
    reply = { status: 200, body: 'ok' };
    await mustOk(a.del(`/config/webhooks/${ep.id}`), 200, 204);
  });

  it('the real HTTPS transport does not follow redirects (one request, 302 returned)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa47tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=hooks.example.test'], { stdio: 'ignore' });
    const seen: string[] = [];
    const srv: HttpsServer = createHttpsServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/in') { res.statusCode = 302; res.setHeader('location', '/internal-admin'); }
      if (req.url === '/ok') res.statusCode = 204;
      res.end('x');
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed test server only
    try {
      // QA47-BUG-008 (fixed in QA): the pinned lookup must work with Node's autoSelectFamily (lookup { all: true })
      const ok = await httpsTransport({ url: new URL(`https://hooks.example.test:${port}/ok`), address: '127.0.0.1', family: 4, body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: 5000 });
      expect(ok.status).toBe(204);
      seen.length = 0;
      const r = await httpsTransport({ url: new URL(`https://hooks.example.test:${port}/in`), address: '127.0.0.1', family: 4, body: '{}', headers: { 'Content-Type': 'application/json' }, timeoutMs: 5000 });
      expect(r.status).toBe(302);
      expect(seen).toEqual(['/in']);
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
      await new Promise(r => srv.close(r));
    }
  });
});

// ===================================================================================================== permissions + cross-tenant
describe('Phase 6 permissions and cross-tenant isolation', () => {
  it('403 for each Phase 6 action key the caller lacks', async () => {
    const t = await notifyTenant(c);
    const dt = await notifyDocType(c, t);
    const tpl = await templates(c, t, dt.key);
    await provider(c, t, 'email');
    const d = await makeNotifyDoc(c, t, dt);
    const u = await userWithKeys(c, t.token, t.code, [`doc.${dt.key}:action.view`, ...['draft', 'approved'].map(v => `doc.${dt.key}:view.${v}`)]);
    await mustOk(api(c, t.token).put(`/roles/${u.roleId}/scope`, { entries: [{ allNodes: true }] }));
    const a = api(c, u.token);
    const r = await rule(c, t, { eventType: 'document.submitted', docTypeKey: dt.key, channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }], mode: 'manual' });
    const calls: [string, Promise<{ status: number }>][] = [
      ['templates list', a.get('/config/templates')],
      ['templates create', a.post('/config/templates', { channel: 'email', key: 'x_y', name: 'x', subject: 's', body: 'b' })],
      ['templates update', a.put(`/config/templates/${tpl.email}`, { channel: 'email', key: 'x_y', name: 'x', subject: 's', body: 'b', version: 1 })],
      ['templates delete', a.del(`/config/templates/${tpl.email}`)],
      ['templates preview', a.post('/config/templates/preview', { template: { channel: 'email', key: 'x_y', name: 'x', subject: 's', body: 'b' } })],
      ['templates test-pdf', a.post(`/config/templates/${tpl.pdf}/test-pdf`, {})],
      ['context fields', a.get('/config/templates/context-fields')],
      ['triggers list', a.get('/config/triggers')],
      ['triggers create', a.post('/config/triggers', { name: 'x', eventType: 'document.submitted', channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }] })],
      ['triggers update', a.put(`/config/triggers/${r.id}`, { name: 'x', eventType: 'document.submitted', channel: 'email', templateId: tpl.email, recipients: [{ type: 'party' }], version: r.version })],
      ['triggers delete', a.del(`/config/triggers/${r.id}`)],
      ['webhooks list', a.get('/config/webhooks')],
      ['webhooks create', a.post('/config/webhooks', { url: 'https://hooks.example.test/x', events: ['*'] })],
      ['messages', a.get('/messages')],
      ['messages retry', a.post(`/messages/${r.id}/retry`)],
      ['whatsapp templates', a.get('/config/whatsapp-templates')],
      ['print (no print key)', a.post(`/docs/${dt.key}/${d.id}/print`, {})],
      ['send preview (no send key)', a.post(`/docs/${dt.key}/${d.id}/send/preview`, { channel: 'email', templateId: tpl.email, recipients: ['a@b.test'] })],
      ['send (no send key)', a.post(`/docs/${dt.key}/${d.id}/send`, { channel: 'email', templateId: tpl.email, recipients: ['a@b.test'], idempotencyKey: 'qa47-perm-1' })],
    ];
    const out = await Promise.all(calls.map(async ([n, p]) => [n, (await p).status] as const));
    expect(out.filter(([, s]) => s !== 403)).toEqual([]);
    expect(await messagesOf(c, t.tenantId, d.id)).toHaveLength(0);
  });

  it("tenant A on B's template / rule / webhook / message / PDF job / document ids → 404, B unchanged", async () => {
    const A = await notifyTenant(c);
    const B = await notifyTenant(c, { saToken: A.saToken });
    const dtB = await notifyDocType(c, B);
    const tB = await templates(c, B, dtB.key);
    await provider(c, B, 'email');
    const hooks = c.app.get(WebhooksService);
    const prevResolver = hooks.resolver;
    hooks.resolver = async () => [{ address: '93.184.216.34', family: 4 }];
    try {
      const b = api(c, B.token);
      const rB = await rule(c, B, { eventType: 'document.submitted', docTypeKey: dtB.key, channel: 'email', templateId: tB.email, recipients: [{ type: 'fixed', address: 'b@b.test' }] });
      const epB = await mustOk(b.post('/config/webhooks', { url: 'https://hooks.example.test/b', events: ['*'] }), 201);
      const dB = await makeNotifyDoc(c, B, dtB);
      await submitDoc(c, B, dB, B.adminId);
      await engine(c).handle(event(B, 'document.submitted', dB.id));
      const [mB] = await messagesOf(c, B.tenantId, dB.id);
      await c.db.updateTable('app.outbound_message').set({ status: 'failed', error: 'x' }).where('id', '=', mB!.id).execute();
      const pdfRow = await c.db.insertInto('app.generated_pdf').values({ tenant_id: B.tenantId, document_id: dB.id, template_id: tB.pdf, template_version: 1, document_version: 1 }).returning('id').executeTakeFirstOrThrow();

      const a = api(c, A.token);
      const calls: [string, Promise<{ status: number; body: unknown }>][] = [
        ['template update', a.put(`/config/templates/${tB.email}`, { channel: 'email', key: 'stolen', name: 'x', subject: 's', body: 'b', version: 1 })],
        ['template delete', a.del(`/config/templates/${tB.email}`)],
        ['template test-pdf', a.post(`/config/templates/${tB.pdf}/test-pdf`, {})],
        ['preview with B doc', a.post('/config/templates/preview', { template: { channel: 'email', key: 'x_y', name: 'x', subject: 's', body: '{{document.number}}' }, documentId: dB.id })],
        ['rule get', a.get(`/config/triggers/${rB.id}`)],
        ['rule update', a.put(`/config/triggers/${rB.id}`, { name: 'x', eventType: 'document.submitted', channel: 'email', templateId: tB.email, recipients: [{ type: 'party' }], version: rB.version })],
        ['rule delete', a.del(`/config/triggers/${rB.id}`)],
        ['webhook get', a.get(`/config/webhooks/${epB.id}`)],
        ['webhook update', a.put(`/config/webhooks/${epB.id}`, { url: 'https://hooks.example.test/a', events: ['*'], version: 1 })],
        ['webhook delete', a.del(`/config/webhooks/${epB.id}`)],
        ['webhook deliveries', a.get(`/config/webhooks/${epB.id}/deliveries`)],
        ['webhook test', a.post(`/config/webhooks/${epB.id}/test`)],
        ['message retry', a.post(`/messages/${mB!.id}/retry`)],
        ['pdf job', a.get(`/pdf-jobs/${pdfRow.id}`)],
        ['doc print', a.post(`/docs/${dtB.key}/${dB.id}/print`, {})],
        ['doc messages', a.get(`/docs/${dtB.key}/${dB.id}/messages`)],
        ['doc send preview', a.post(`/docs/${dtB.key}/${dB.id}/send/preview`, { channel: 'email', templateId: tB.email, recipients: ['a@b.test'] })],
        ['doc send', a.post(`/docs/${dtB.key}/${dB.id}/send`, { channel: 'email', templateId: tB.email, recipients: ['a@b.test'], idempotencyKey: 'qa47-xt-1' })],
      ];
      const out = await Promise.all(calls.map(async ([n, p]) => { const r = await p; return [n, r.status, JSON.stringify(r.body)] as const; }));
      expect(out.filter(([, s]) => s !== 404 && s !== 400).map(([n, s]) => `${n}:${s}`)).toEqual([]);
      for (const [, , body] of out) expect(body).not.toContain('b@b.test');
      const msgs = await mustOk(a.get('/messages'));
      expect(JSON.stringify(msgs)).not.toContain(mB!.id);
      // B unchanged
      expect((await mustOk(b.get(`/config/triggers/${rB.id}`))).version).toBe(rB.version);
      expect((await mustOk(b.get(`/config/webhooks/${epB.id}`))).url).toBe('https://hooks.example.test/b');
      expect((await messagesOf(c, B.tenantId, dB.id))[0]!.status).toBe('failed');
      void DbService;
    } finally {
      hooks.resolver = prevResolver;
    }
  });
});
