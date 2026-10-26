/**
 * Templates & PDF (Phase 6): end-to-end PDF rendering with real headless Chromium (worker inline), the
 * generated_pdf cache keyed by template + document versions, network lock-down, print permissions, PDF jobs and the
 * generate_pdf workflow effect.
 */
import { execFileSync } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/core/db.service';
import { EFFECT_REGISTRY, EffectRegistry, TEMPLATE_RENDERER, TemplateRenderer } from '../src/core/ports';
import { FilesService } from '../src/modules/files';
import { PdfJobs } from '../src/modules/templates';
import { PdfRenderer, RENDER_ORIGIN } from '../src/modules/templates/pdf.renderer';
import { PO_BODY, PO_FOOTER } from '../src/modules/templates/starters/bodies';
import { bootApp, closeApp, Ctx, startWorkers, uid } from './helpers';
import { api, mustOk, userWithKeys } from './forms-helpers';
import { poxDoc, TplFixture, tplTenant } from './templates-helpers';

const hasPdftotext = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function pdfText(buf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-pdf-'));
  const file = join(dir, 'x.pdf');
  writeFileSync(file, buf);
  return execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
}

describe('PDF rendering (real Chromium)', () => {
  let c: Ctx;
  let f: TplFixture;
  let poLayoutId: string;
  let doc: Awaited<ReturnType<typeof poxDoc>>;
  let hits = 0;
  let server: Server;
  let port = 0;

  const waitReady = async (id: string) => {
    const r = await c.app.get(PdfJobs).waitFor(f.tenantId, id, 40_000);
    expect(r?.status, r?.error ?? '').toBe('ready');
    return r!;
  };
  const fileBytes = async (fileId: string) => c.app.get(DbService).tenantTx(f.tenantId, async tx => {
    const row = await c.app.get(FilesService).loadOne(tx, f.tenantId, fileId);
    return { row: row!, bytes: await c.app.get(FilesService).storage.get(row!.storage_key) };
  });

  beforeAll(async () => {
    process.env.PDF_CHROMIUM_PATH ??= '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    server = createServer((_req, res) => { hits++; res.end('x'); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    c = await bootApp();
    await startWorkers(c);
    f = await tplTenant(c);
    doc = await poxDoc(c, f);
    const layout = await mustOk(api(c, f.token).post('/config/templates', {
      channel: 'pdf', docTypeKey: 'pox', key: 'pox_standard', name: 'PO X', body: PO_BODY, isDefault: true,
      pdfOptions: { format: 'A4', marginMm: { top: 12, right: 12, bottom: 16, left: 12 }, footerHtml: PO_FOOTER },
    }), 201);
    poLayoutId = layout.id;
  }, 120_000);
  afterAll(async () => {
    await closeApp(c);
    await new Promise(r => server.close(r));
  });

  it('prints a PO-like document into a valid PDF with the expected content', async () => {
    const job = await mustOk(api(c, f.token).post(`/docs/pox/${doc.id}/print`, {}));
    expect(job).toMatchObject({ status: 'queued', fileUrl: null, error: null });
    const row = await waitReady(job.id);
    const { row: file, bytes } = await fileBytes(row.file_id!);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(file).toMatchObject({ mime: 'application/pdf', scan_status: 'clean' });
    expect(file.filename).toMatch(/^POX-.+\.pdf$/);
    expect(file.attached_to).toEqual({ kind: 'generated_pdf', id: job.id, field: 'pdf' });
    const polled = await mustOk(api(c, f.token).get(`/pdf-jobs/${job.id}`));
    expect(polled.status).toBe('ready');
    expect(polled.fileUrl).toMatch(new RegExp(`^/api/v1/files/${row.file_id}/content\\?`));
    const dl = await c.http.get(polled.fileUrl);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    if (hasPdftotext) {
      const text = pdfText(bytes);
      for (const s of ['PURCHASE ORDER', 'Acme Industries Private Limited', '27AABCA1234F1Z9', 'Deccan Steel Traders', '27AAFCD5678K1Z3', 'Laptop', '8471',
        '₹1,74,455.90', 'Rupees One Lakh Seventy Four Thousand Four Hundred Fifty Five and Ninety Paise Only', 'Delivery', 'Authorised Signatory',
        'Page 1 of 1', 'CGST', 'SGST', '13,275.45']) {
        expect(text, s).toContain(s);
      }
      expect(text).not.toContain('IGST');
    }
    // storage is not metered for generated PDFs (regenerable cache)
    const meter = await c.db.selectFrom('platform.usage_meter').select('used').where('tenant_id', '=', f.tenantId).where('limit_key', '=', 'storage_gb').executeTakeFirst();
    expect(Number(meter?.used ?? 0)).toBeLessThan(bytes.length + 50_000);
  });

  it('reuses the cached PDF until the document or the template changes', async () => {
    const a = api(c, f.token);
    const first = await mustOk(a.post(`/docs/pox/${doc.id}/print`, {}));
    expect(first.status).toBe('ready');
    const again = await mustOk(a.post(`/docs/pox/${doc.id}/print`, { templateId: poLayoutId }));
    expect(again.id).toBe(first.id);
    // template edit → new version → new PDF
    const t = await mustOk(a.get('/config/templates?channel=pdf&docType=pox'));
    const layout = t.find((x: { id: string }) => x.id === poLayoutId);
    await mustOk(a.put(`/config/templates/${poLayoutId}`, { ...layout, name: 'PO X v2', version: layout.version }));
    const afterTpl = await mustOk(a.post(`/docs/pox/${doc.id}/print`, {}));
    expect(afterTpl.id).not.toBe(first.id);
    await waitReady(afterTpl.id);
    // document change → new document version → new PDF
    await c.db.updateTable('app.document').set({ custom: JSON.stringify({ remarks: 'changed' }) }).where('id', '=', doc.id).execute();
    const afterDoc = await mustOk(a.post(`/docs/pox/${doc.id}/print`, {}));
    expect(afterDoc.id).not.toBe(afterTpl.id);
    await waitReady(afterDoc.id);
    const rows = await c.db.selectFrom('app.generated_pdf').select(['template_version', 'document_version']).where('document_id', '=', doc.id).execute();
    expect(new Set(rows.map(r => `${r.template_version}/${r.document_version}`)).size).toBe(rows.length);
  });

  it('blocks every network request except data: URLs and our own signed file URLs', async () => {
    const renderer = c.app.get(PdfRenderer);
    const files = c.app.get(FilesService);
    const logoUrl = files.signedUrl(f.tenantId, f.logoFileId);
    const html = `<html><body><h1>Net test</h1>
      <img src="http://127.0.0.1:${port}/a.png"><img src="http://example.com/x.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/s.css">
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==">
      <img src="${logoUrl}"><img src="/api/v1/files/${f.logoFileId}/content?t=${f.tenantId}&exp=9999999999&sig=forged">
      <iframe src="http://127.0.0.1:${port}/frame"></iframe><script>fetch('http://127.0.0.1:${port}/js')</script></body></html>`;
    const res = await renderer.render(html, { format: 'A4', landscape: false, marginMm: { top: 10, right: 10, bottom: 10, left: 10 } },
      q => (q.t === f.tenantId ? files.content(q).then(x => ({ body: x.body, mime: x.mime })) : Promise.resolve(null)));
    expect(res.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hits).toBe(0);
    expect(res.blocked).toEqual(expect.arrayContaining([`http://127.0.0.1:${port}/a.png`, `http://127.0.0.1:${port}/s.css`, `http://127.0.0.1:${port}/frame`]));
    expect(res.blocked.some(u => /^https?:\/\/example\.com\/x\.png$/.test(u))).toBe(true);
    expect(res.blocked.some(u => u.includes('sig=forged'))).toBe(true);
    expect(res.served).toEqual([`${RENDER_ORIGIN}${logoUrl}`]);
  });

  it('a template with an external image still renders (image blocked) through the print endpoint', async () => {
    const a = api(c, f.token);
    const t = await mustOk(a.post('/config/templates', { channel: 'pdf', docTypeKey: null, key: `net_${uid(4)}`, name: 'net', body: `<p>{{document.number}}</p><img src="http://127.0.0.1:${port}/logo.png">` }), 201)
      .catch(async () => {
        // generic layouts need pdf_templates beyond the first: enable it for this tenant
        await c.db.insertInto('platform.tenant_override').values({ tenant_id: f.tenantId, kind: 'feature', key: 'pdf_templates', value: JSON.stringify(true), reason: 'test' }).onConflict(oc => oc.doNothing()).execute();
        await c.app.get((await import('../src/core/entitlements.service')).EntitlementsService).invalidate(f.tenantId);
        return mustOk(a.post('/config/templates', { channel: 'pdf', docTypeKey: null, key: `net_${uid(4)}`, name: 'net', body: `<p>{{document.number}}</p><img src="http://127.0.0.1:${port}/logo.png">` }), 201);
      });
    const job = await mustOk(a.post(`/docs/pox/${doc.id}/print`, { templateId: t.id }));
    await waitReady(job.id);
    expect(hits).toBe(0);
  });

  it('test-pdf renders a layout against the latest visible document', async () => {
    const job = await mustOk(api(c, f.token).post(`/config/templates/${poLayoutId}/test-pdf`, {}));
    expect(['queued', 'ready']).toContain(job.status);
    await waitReady(job.id);
    const withDoc = await mustOk(api(c, f.token).post(`/config/templates/${poLayoutId}/test-pdf`, { documentId: doc.id }));
    expect(withDoc.id).toBe(job.id);
    const notPdf = await c.db.selectFrom('app.message_template').select('id').where('tenant_id', '=', f.tenantId).where('channel', '=', 'inapp').executeTakeFirstOrThrow();
    expect((await api(c, f.token).post(`/config/templates/${notPdf.id}/test-pdf`, {})).status).toBe(400);
    const indentLayout = await c.db.selectFrom('app.message_template').select('id').where('tenant_id', '=', f.tenantId).where('key', '=', 'indent_standard').executeTakeFirstOrThrow();
    const none = await api(c, f.token).post(`/config/templates/${indentLayout.id}/test-pdf`, {});
    if (none.status !== 200) expect(none.status).toBe(409);
  });

  it('marks a job failed when the template cannot render, and retries a failed job on the next request', async () => {
    const jobs = c.app.get(PdfJobs);
    const tid = (await c.db.insertInto('app.message_template').values({ tenant_id: f.tenantId, channel: 'pdf', doc_type_key: 'pox', key: `broken_${uid(4)}`, name: 'b', body: '{{#each x}}' })
      .returning('id').executeTakeFirstOrThrow()).id;
    const job = await mustOk(api(c, f.token).post(`/docs/pox/${doc.id}/print`, { templateId: tid }));
    const r = await jobs.waitFor(f.tenantId, job.id, 20_000);
    expect(r).toMatchObject({ status: 'failed' });
    expect(r!.error).toMatch(/template has an error/);
    const polled = await mustOk(api(c, f.token).get(`/pdf-jobs/${job.id}`));
    expect(polled).toMatchObject({ status: 'failed', fileUrl: null });
    const retry = await mustOk(api(c, f.token).post(`/docs/pox/${doc.id}/print`, { templateId: tid }));
    expect(retry).toMatchObject({ id: job.id, status: 'queued' });
    await jobs.waitFor(f.tenantId, job.id, 20_000);
    // wrong channel / other doc type layouts are rejected
    const email = await c.db.selectFrom('app.message_template').select('id').where('tenant_id', '=', f.tenantId).where('channel', '=', 'email').executeTakeFirstOrThrow();
    expect((await api(c, f.token).post(`/docs/pox/${doc.id}/print`, { templateId: email.id })).status).toBe(400);
    const poStd = await c.db.selectFrom('app.message_template').select('id').where('tenant_id', '=', f.tenantId).where('key', '=', 'po_standard').executeTakeFirstOrThrow();
    expect((await api(c, f.token).post(`/docs/pox/${doc.id}/print`, { templateId: poStd.id })).status).toBe(400);
  });

  it('needs view + print on the doc type and data scope; other users cannot poll the job', async () => {
    const base = ['doc.pox:action.view', 'doc.pox:view.approved'];
    const noPrint = await userWithKeys(c, f.token, f.code, base);
    await mustOk(api(c, f.token).put(`/roles/${noPrint.roleId}/scope`, { entries: [{ allNodes: true }] }));
    expect((await api(c, noPrint.token).post(`/docs/pox/${doc.id}/print`, {})).status).toBe(403);
    const printer = await userWithKeys(c, f.token, f.code, [...base, 'doc.pox:action.print']);
    await mustOk(api(c, f.token).put(`/roles/${printer.roleId}/scope`, { entries: [{ nodeId: f.chennai }] }));
    expect((await api(c, printer.token).post(`/docs/pox/${doc.id}/print`, {})).status).toBe(404); // out of scope
    await mustOk(api(c, f.token).put(`/roles/${printer.roleId}/scope`, { entries: [{ nodeId: f.pune }] }));
    const job = await mustOk(api(c, printer.token).post(`/docs/pox/${doc.id}/print`, {}));
    expect((await api(c, printer.token).get(`/pdf-jobs/${job.id}`)).status).toBe(200);
    expect((await api(c, noPrint.token).get(`/pdf-jobs/${job.id}`)).status).toBe(404);
    const stranger = await userWithKeys(c, f.token, f.code, ['admin.locations:action.view']);
    expect((await api(c, stranger.token).post(`/docs/pox/${doc.id}/print`, {})).status).toBe(404);
    expect((await api(c, f.token).post(`/docs/BAD-TYPE/${doc.id}/print`, {})).status).toBe(404);
    expect((await api(c, f.token).get('/pdf-jobs/0190a000-0000-7000-8000-00000000000b')).status).toBe(404);
  });

  it('generate_pdf effect queues the PDF idempotently; pdfForDocument can wait for the file', async () => {
    const d2 = await poxDoc(c, f);
    const reg = c.app.get<EffectRegistry>(EFFECT_REGISTRY);
    const db = c.app.get(DbService);
    for (let i = 0; i < 2; i++) {
      await db.tenantTx(f.tenantId, tx => reg.run({ effect: 'generate_pdf', template: 'pox_standard' }, {
        tx, tenantId: f.tenantId, documentId: d2.id, stageKey: 'approve', wfActionId: null, actorId: f.adminId,
      }));
    }
    const rows = await c.db.selectFrom('app.generated_pdf').select(['id', 'template_id']).where('document_id', '=', d2.id).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.template_id).toBe(poLayoutId);
    await waitReady(rows[0]!.id);
    // unknown template key falls back to the default; rolled back actions leave nothing
    await db.tenantTx(f.tenantId, async tx => {
      await reg.run({ effect: 'generate_pdf', template: 'nope' }, { tx, tenantId: f.tenantId, documentId: d2.id, stageKey: null, wfActionId: null, actorId: null });
      throw new Error('rollback');
    }).catch(() => undefined);
    expect(await c.db.selectFrom('app.generated_pdf').select('id').where('document_id', '=', d2.id).execute()).toHaveLength(1);

    const port = c.app.get<TemplateRenderer>(TEMPLATE_RENDERER);
    const cached = await db.tenantTx(f.tenantId, tx => port.pdfForDocument(tx, d2.id, null, { waitMs: 30_000 }));
    expect(cached).toEqual({ id: rows[0]!.id, fileId: expect.any(String) });
    const d3 = await poxDoc(c, f, { tax: 'none' });
    const fresh = await db.tenantTx(f.tenantId, tx => port.pdfForDocument(tx, d3.id, null, { waitMs: 40_000 }));
    expect(fresh.fileId).toEqual(expect.any(String));
    const queued = await db.tenantTx(f.tenantId, tx => port.pdfForDocument(tx, d3.id, null));
    expect(queued).toEqual(fresh);
  });

  it('reuses one browser across renders and caps concurrent pages', async () => {
    const renderer = c.app.get(PdfRenderer);
    const launches = renderer.launches;
    const opts = { format: 'A4' as const, landscape: false, marginMm: { top: 5, right: 5, bottom: 5, left: 5 } };
    let peak = 0;
    const timer = setInterval(() => { peak = Math.max(peak, renderer.inFlight); }, 5);
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => renderer.render(`<p>doc ${i}</p>`, opts, async () => null)));
    clearInterval(timer);
    expect(outs.every(o => o.pdf.subarray(0, 4).toString() === '%PDF')).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(renderer.launches).toBe(launches);
  });

  it('relaunches the browser after a crash and enforces the render timeout', async () => {
    const renderer = c.app.get(PdfRenderer);
    const b = (renderer as unknown as { browser: { close(): Promise<void> } | null }).browser;
    await b?.close();
    const out = await renderer.render('<p>after crash</p>', { format: 'A5', landscape: true, marginMm: { top: 5, right: 5, bottom: 5, left: 5 }, headerHtml: '<span>h</span>' }, async () => null);
    expect(out.pdf.subarray(0, 4).toString()).toBe('%PDF');
    await expect(renderer.render('<p>slow</p>', { format: 'A4', landscape: false, marginMm: { top: 5, right: 5, bottom: 5, left: 5 } }, async () => null, 1))
      .rejects.toThrow();
  });
});
