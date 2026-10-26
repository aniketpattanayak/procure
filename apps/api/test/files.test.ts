import { createHash, createHmac } from 'node:crypto';
import { createServer, Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { ClamAvScanner, FilesCleanupJob, FilesService, parseClamReply, sniff } from '../src/modules/files';
import { API, bearer, bootApp, closeApp, Ctx } from './helpers';
import { addRecord, api, builderTenant, createMaster, mustOk, PNG_1PX } from './forms-helpers';

const ZIP = Buffer.from('504b0304140000000000000000000000000000000000000000000000000000', 'hex');
const EXE = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00', 'latin1'), Buffer.alloc(200)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('files: upload, sniffing, limits, signed URLs, record attachment', () => {
  let c: Ctx;
  let token: string;
  let tenantId: string;
  const up = (buf: Buffer, name: string, fields: Record<string, string> = {}, tok = token) => {
    let r = c.http.post(`${API}/files`).set(bearer(tok));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', buf, name);
  };
  const raw = (url: string) => c.http.get(url).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (d: Buffer) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  beforeAll(async () => {
    c = await bootApp();
    const t = await builderTenant(c);
    token = t.token;
    tenantId = t.tenant.tenantId;
    await createMaster(c, token, 'doc', [
      { key: 'photo', label: 'Photo', type: 'image', maxSizeMb: 0.1 },
      { key: 'papers', label: 'Papers', type: 'files', accept: ['application/pdf'], maxFiles: 2 },
    ]);
  });
  afterAll(async () => { await closeApp(c); });

  it('accepts a real PNG, measures it, returns signed URLs that serve the bytes and thumbnails', async () => {
    const meta = await mustOk(up(PNG_1PX, 'dot.png'), 201);
    expect(meta).toMatchObject({ filename: 'dot.png', mime: 'image/png', sizeBytes: PNG_1PX.length, width: 1, height: 1, scanStatus: 'clean' });
    expect(meta.url).toMatch(new RegExp(`^/api/v1/files/${meta.id}/content\\?t=${tenantId}&exp=\\d+&sig=`));
    const body = await raw(meta.url);
    expect(body.status).toBe(200);
    expect(body.headers['content-type']).toBe('image/png');
    expect(body.headers['content-disposition']).toMatch(/^inline/);
    expect(Buffer.compare(body.body, PNG_1PX)).toBe(0);
    const thumb = await raw(meta.thumbUrl);
    expect(thumb.status).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect((await raw(meta.thumbUrl)).status).toBe(200); // cached on disk
    const row = await c.db.selectFrom('app.file_object').select(['sha256', 'attached_to']).where('id', '=', meta.id).executeTakeFirstOrThrow();
    expect(row.sha256).toBe(createHash('sha256').update(PNG_1PX).digest('hex'));
    expect(row.attached_to).toBeNull();
    const again = await mustOk(api(c, token).get(`/files/${meta.id}`));
    expect(again.id).toBe(meta.id);
  });

  it('signed URLs: tampered, expired or wrong-width signatures are 403', async () => {
    const meta = await mustOk(up(PDF, 'a.pdf'), 201);
    const u = new URL(meta.url, 'http://x');
    const sig = u.searchParams.get('sig')!;
    expect((await raw(meta.url.replace(sig, sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA')))).status).toBe(403);
    expect((await raw(`${meta.url}&w=100`)).status).toBe(403);
    const secret = createHash('sha256').update(`file-url:${process.env.JWT_SECRET}`).digest('hex');
    const exp = Math.floor(Date.now() / 1000) - 10;
    const s = createHmac('sha256', secret).update(`${meta.id}|${exp}|`).digest('base64url');
    expect((await raw(`/api/v1/files/${meta.id}/content?t=${tenantId}&exp=${exp}&sig=${s}`)).status).toBe(403);
    const pdf = await raw(meta.url);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-disposition']).toMatch(/^attachment/);
    // signature valid but another tenant id: nothing found
    expect((await raw(meta.url.replace(tenantId, '00000000-0000-7000-8000-000000000000'))).status).toBe(404);
  });

  it('sniffs content: .png that is an exe or a zip, unknown binary and mismatched names are rejected', async () => {
    for (const [buf, name] of [[EXE, 'photo.png'], [ZIP, 'photo.png'], [EXE, 'setup.exe'], [Buffer.from([0, 1, 2, 3, 0, 9]), 'x.bin'], [PDF, 'x.png']] as const) {
      const r = await up(buf, name);
      expect(r.status, name).toBe(400);
      expect(r.body.errors[0].path).toBe('file');
    }
    expect((await up(Buffer.from('a,b\n1,2\n'), 'data.csv')).body.mime).toBe('text/csv');
    expect((await up(Buffer.from('hello'), 'notes.txt')).body.mime).toBe('text/plain');
    expect((await sniff(PNG_1PX, 'x.PNG')).ok).toBe(true);
  });

  it('per-field accept and size rules; absolute 25 MB cap', async () => {
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(150 * 1024)]);
    expect((await up(big, 'big.png', { formKey: 'doc', fieldKey: 'photo' })).status).toBe(400);
    expect((await up(PDF, 'a.pdf', { formKey: 'doc', fieldKey: 'photo' })).body.errors[0].message).toMatch(/accepts only/);
    expect((await up(PDF, 'a.pdf', { formKey: 'doc', fieldKey: 'papers' })).status).toBe(201);
    expect((await up(PDF, 'a.pdf', { formKey: 'doc', fieldKey: 'nope' })).status).toBe(400);
    expect((await up(Buffer.alloc(26 * 1024 * 1024), 'huge.pdf')).status).toBe(413);
  });

  it('storage limit: a 0 GB plan cannot store anything', async () => {
    const t = await builderTenant(c, { storage_gb: 0 });
    const r = await up(PNG_1PX, 'dot.png', {}, t.token);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('LIMIT_EXCEEDED.storage_gb');
    const n = await c.db.selectFrom('app.file_object').select(eb => eb.fn.countAll<string>().as('n')).where('tenant_id', '=', t.tenant.tenantId).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(0);
  });

  it('record saves: attach clean files, reject pending/infected, cross-tenant and already-attached files', async () => {
    const a = api(c, token);
    const img = await mustOk(up(PNG_1PX, 'p.png'), 201);
    const pdf = await mustOk(up(PDF, 'p.pdf'), 201);
    const rec = await addRecord(c, token, 'doc', { code: 'D1', name: 'Doc', data: { photo: img.id, papers: [pdf.id] } });
    expect(rec.files[img.id]).toMatchObject({ mime: 'image/png', url: expect.any(String) });
    const att = await c.db.selectFrom('app.file_object').select('attached_to').where('id', '=', img.id).executeTakeFirstOrThrow();
    expect(att.attached_to).toEqual({ kind: 'master_record', id: rec.id, field: 'photo' });
    // the same file cannot be put on another record
    const reuse = await a.post('/masters/doc/records', { code: 'D2', name: 'x', data: { photo: img.id } });
    expect(reuse.body.errors[0].message).toMatch(/already attached/);
    // pending
    const pending = await mustOk(up(PNG_1PX, 'q.png'), 201);
    await c.db.updateTable('app.file_object').set({ scan_status: 'pending' }).where('id', '=', pending.id).execute();
    const p = await a.post('/masters/doc/records', { code: 'D3', name: 'x', data: { photo: pending.id } });
    expect(p.body.errors[0].message).toMatch(/still being scanned/);
    expect((await raw((await mustOk(up(PDF, 'z.pdf'), 201)).url)).status).toBe(200);
    await c.db.updateTable('app.file_object').set({ scan_status: 'infected' }).where('id', '=', pdf.id).execute();
    expect((await raw(rec.files[pdf.id].url)).status).toBe(404); // never served once infected
    // wrong type for the field (png in a pdf-only field)
    const other = await mustOk(up(PNG_1PX, 'r.png'), 201);
    const typ = await a.post('/masters/doc/records', { code: 'D4', name: 'x', data: { papers: [other.id] } });
    expect(typ.body.errors[0].message).toMatch(/not an accepted file type/);
    // cross-tenant id
    const t2 = await builderTenant(c);
    const foreign = await mustOk(up(PNG_1PX, 'f.png', {}, t2.token), 201);
    const x = await a.post('/masters/doc/records', { code: 'D5', name: 'x', data: { photo: foreign.id } });
    expect(x.body.errors[0].message).toMatch(/not found/);
    expect((await a.get(`/files/${foreign.id}`)).status).toBe(404);
    // replacing the photo orphans the old one
    const got = await mustOk(a.get(`/masters/doc/records/${rec.id}`));
    await mustOk(a.put(`/masters/doc/records/${rec.id}`, { code: 'D1', name: 'Doc', data: { photo: other.id, papers: [] }, version: got.version }));
    const old = await c.db.selectFrom('app.file_object').select('attached_to').where('id', '=', img.id).executeTakeFirstOrThrow();
    expect(old.attached_to).toBeNull();
  });

  it('cleanupOrphans deletes old unattached files and credits the storage meter', async () => {
    const t = await builderTenant(c);
    const f = await mustOk(up(PDF, 'orphan.pdf', {}, t.token), 201);
    const svc = c.app.get(FilesService);
    expect(await svc.cleanupOrphans(t.tenant.tenantId, 1)).toBe(0); // too young
    const meter = () => c.db.selectFrom('platform.usage_meter').select('used').where('tenant_id', '=', t.tenant.tenantId).where('limit_key', '=', 'storage_gb').executeTakeFirstOrThrow();
    expect(Number((await meter()).used)).toBe(PDF.length);
    expect(await svc.cleanupOrphans(t.tenant.tenantId, 0)).toBe(1);
    const row = await c.db.selectFrom('app.file_object').select('is_deleted').where('id', '=', f.id).executeTakeFirstOrThrow();
    expect(row.is_deleted).toBe(true);
    expect(Number((await meter()).used)).toBe(0);
  });

  it('nightly FilesCleanupJob sweeps every tenant with orphans and keeps files referenced without attached_to', async () => {
    const t = await builderTenant(c);
    const logo = await mustOk(up(PNG_1PX, 'logo.png', {}, t.token), 201);
    const quoted = await mustOk(up(PDF, 'quote.pdf', {}, t.token), 201);
    const orphan = await mustOk(up(PDF, 'stale.pdf', {}, t.token), 201);
    await c.db.updateTable('platform.tenant').set({ logo_url: `/api/v1/files/${logo.id}/content` }).where('id', '=', t.tenant.tenantId).execute();
    // An outbound message carrying a file as attachment (notify keeps ids in attachment_file_ids, not attached_to).
    await sql`insert into app.outbound_message (tenant_id, channel, idempotency_key, recipient, attachment_file_ids, status)
      values (${t.tenant.tenantId}, 'email', ${`test:${quoted.id}`}, 'x@example.com', ${[quoted.id]}::uuid[], 'sent')`.execute(c.db);
    const job = c.app.get(FilesCleanupJob);
    expect((await job.runAll(1)).deleted).toBe(0); // all younger than an hour
    const r = await job.runAll(0);
    expect(r.tenants).toBeGreaterThanOrEqual(1);
    const del = async (id: string) => (await c.db.selectFrom('app.file_object').select('is_deleted').where('id', '=', id).executeTakeFirstOrThrow()).is_deleted;
    expect(await del(orphan.id)).toBe(true);
    expect(await del(logo.id)).toBe(false);
    expect(await del(quoted.id)).toBe(false);
  });
});

describe('ClamAV scanner (fake clamd)', () => {
  let server: Server;
  let port = 0;
  let received = Buffer.alloc(0);
  beforeAll(async () => {
    server = createServer(sock => {
      let buf = Buffer.alloc(0);
      sock.on('data', d => {
        buf = Buffer.concat([buf, d]);
        if (!buf.subarray(0, 10).equals(Buffer.from('zINSTREAM\0'))) return;
        // parse chunks until the zero-length terminator
        let off = 10;
        const parts: Buffer[] = [];
        while (off + 4 <= buf.length) {
          const len = buf.readUInt32BE(off);
          if (len === 0) {
            received = Buffer.concat(parts);
            sock.end(received.includes(Buffer.from('EICAR')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
            return;
          }
          if (off + 4 + len > buf.length) return;
          parts.push(buf.subarray(off + 4, off + 4 + len));
          off += 4 + len;
        }
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });

  it('streams in chunks and parses OK / FOUND / errors', async () => {
    const s = new ClamAvScanner('127.0.0.1', port, 2000, 7);
    expect(await s.scan(Buffer.from('hello world, clean file'))).toEqual({ status: 'clean' });
    expect(received.toString()).toBe('hello world, clean file');
    expect(await s.scan(Buffer.from('xxEICARxx'))).toEqual({ status: 'infected', signature: 'Eicar-Test-Signature' });
    expect((await new ClamAvScanner('127.0.0.1', 1, 500).scan(Buffer.from('x'))).status).toBe('error');
    expect(parseClamReply('stream: INSTREAM size limit exceeded. ERROR\0')).toEqual({ status: 'error', message: 'INSTREAM size limit exceeded. ERROR' });
    expect(parseClamReply('')).toMatchObject({ status: 'error' });
  });
});
