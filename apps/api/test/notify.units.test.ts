/**
 * Notify (Phase 6) pure units: secrets crypto, SSRF guard, signatures (outgoing, Meta, SNS), addresses, renderer
 * fallback, channel adapters with mocked transports (retry vs fail-fast classification).
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BspWhatsAppAdapter, buildMime, decryptSecret, encryptSecret, isBlockedIp, LogEmailAdapter, LogWhatsAppAdapter, MetaWhatsAppAdapter, monthPeriod,
  normaliseAddress, normalisePhone, ProviderError, retryDelayMs, SesEmailAdapter, signWebhook, SmtpEmailAdapter, snsStringToSign, SsrfError, substitute,
  verifyMetaSignature, verifySnsMessage, verifyWebhookSignature, vetUrl,
} from '../src/modules/notify';
import { resetProviderKey } from '../src/modules/notify/util/crypto';
import { createHmac } from 'node:crypto';
import type { ResolvedProvider } from '../src/modules/notify/channels/types';

const provider = (p: Partial<ResolvedProvider>): ResolvedProvider => ({ id: null, tenantId: null, channel: 'email', provider: 'log', config: {}, secret: {}, ...p });
const email = { id: '00000000-0000-0000-0000-0000000000aa', tenantId: '00000000-0000-0000-0000-0000000000bb', to: 'v@vendor.test', toName: 'Vendor', subject: 'PO 1', html: '<p>Hi</p>', attachments: [{ filename: 'PO-1.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4 test') }] };

describe('provider secrets (AES-256-GCM)', () => {
  it('round-trips, uses a fresh IV, detects tampering and a wrong key', () => {
    const a = encryptSecret('{"accessToken":"t0k"}');
    const b = encryptSecret('{"accessToken":"t0k"}');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(decryptSecret(a)).toBe('{"accessToken":"t0k"}');
    const parts = a.split(':');
    const flipped = [...parts.slice(0, 3), Buffer.from('x' + Buffer.from(parts[3]!, 'base64').toString('latin1').slice(1), 'latin1').toString('base64')].join(':');
    expect(() => decryptSecret(flipped)).toThrow();
    expect(() => decryptSecret(a, Buffer.alloc(32, 7))).toThrow();
    expect(() => decryptSecret('v0:zz')).toThrow();
  });

  it('PROVIDER_KEY env (hex / any string) is honoured', () => {
    const prev = process.env.PROVIDER_KEY;
    process.env.PROVIDER_KEY = 'a'.repeat(64);
    resetProviderKey();
    const c = encryptSecret('x');
    expect(decryptSecret(c, Buffer.from('a'.repeat(64), 'hex'))).toBe('x');
    process.env.PROVIDER_KEY = 'some passphrase';
    resetProviderKey();
    expect(decryptSecret(encryptSecret('y'))).toBe('y');
    if (prev === undefined) delete process.env.PROVIDER_KEY; else process.env.PROVIDER_KEY = prev;
    resetProviderKey();
  });
});

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1',
    '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::', 'ff02::1', '2001:db8::1', 'not-an-ip',
  ])('blocks %s', ip => expect(isBlockedIp(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', ip => expect(isBlockedIp(ip)).toBe(false));

  it('vets URLs: https only, no credentials, no localhost, every resolved address public', async () => {
    const pub = async () => [{ address: '93.184.216.34', family: 4 }];
    await expect(vetUrl('http://example.com/x', pub)).rejects.toBeInstanceOf(SsrfError);
    await expect(vetUrl('https://u:p@example.com/x', pub)).rejects.toThrow(/credentials/);
    await expect(vetUrl('https://localhost/x', pub)).rejects.toThrow(/not allowed/);
    await expect(vetUrl('https://127.0.0.1/x', pub)).rejects.toThrow(/private/);
    await expect(vetUrl('https://[::1]/x', pub)).rejects.toThrow(/private/);
    await expect(vetUrl('not a url', pub)).rejects.toThrow(/not valid/);
    const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
    await expect(vetUrl('https://rebind.example/x', mixed)).rejects.toThrow(/10\.0\.0\.5/);
    await expect(vetUrl('https://nx.example/x', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/could not be resolved/);
    await expect(vetUrl('https://empty.example/x', async () => [])).rejects.toThrow(/could not be resolved/);
    const ok = await vetUrl('https://hooks.example.com/in?x=1', pub);
    expect(ok.addresses[0]!.address).toBe('93.184.216.34');
  });

  it('retry delays grow exponentially and cap at 6 h', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 120_000, 480_000, 1_920_000]);
    expect(retryDelayMs(8)).toBe(6 * 3600 * 1000);
  });
});

describe('signatures', () => {
  it('outgoing webhook signature t=…,v1=hmac(secret, t.body) verifies and rejects tampering / stale', () => {
    const h = signWebhook('whsec_1', '{"a":1}', 1_700_000_000);
    expect(h).toBe(`t=1700000000,v1=${createHmac('sha256', 'whsec_1').update('1700000000.{"a":1}').digest('hex')}`);
    expect(verifyWebhookSignature('whsec_1', '{"a":1}', h, 300, 1_700_000_010)).toBe(true);
    expect(verifyWebhookSignature('whsec_1', '{"a":2}', h, 300, 1_700_000_010)).toBe(false);
    expect(verifyWebhookSignature('other', '{"a":1}', h, 300, 1_700_000_010)).toBe(false);
    expect(verifyWebhookSignature('whsec_1', '{"a":1}', h, 300, 1_700_009_999)).toBe(false);
    expect(verifyWebhookSignature('whsec_1', '{"a":1}', 'garbage')).toBe(false);
  });

  it('Meta X-Hub-Signature-256 over the raw bytes', () => {
    const raw = Buffer.from('{"entry":[{"x":"\\u00e9\\/"}]}');
    const sig = `sha256=${createHmac('sha256', 'appsecret').update(raw).digest('hex')}`;
    expect(verifyMetaSignature(raw, sig, 'appsecret')).toBe(true);
    expect(verifyMetaSignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), sig, 'appsecret')).toBe(false);
    expect(verifyMetaSignature(raw, sig, 'wrong')).toBe(false);
    expect(verifyMetaSignature(raw, undefined, 'appsecret')).toBe(false);
    expect(verifyMetaSignature(raw, sig, '')).toBe(false);
  });

  describe('SNS', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const cert = async (url: string) => {
      expect(url).toBe('https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc.pem');
      return pem;
    };
    const sign = (m: Record<string, string>, v = '1') => {
      const msg = { SignatureVersion: v, SigningCertURL: 'https://sns.ap-south-1.amazonaws.com/SimpleNotificationService-abc.pem', ...m } as never;
      const s = createSign(v === '1' ? 'RSA-SHA1' : 'RSA-SHA256').update(snsStringToSign(msg)).sign(privateKey, 'base64');
      return { ...(msg as object), Signature: s } as never;
    };
    const base = { Type: 'Notification', MessageId: 'm1', TopicArn: 'arn:aws:sns:ap-south-1:1:ses', Message: '{"x":1}', Timestamp: new Date().toISOString() };

    it('accepts v1 and v2 signatures (with and without Subject) and rejects tampering', async () => {
      expect(await verifySnsMessage(sign(base), cert)).toBe(true);
      expect(await verifySnsMessage(sign({ ...base, Subject: 'Hello' }, '2'), cert)).toBe(true);
      const m = sign(base) as Record<string, string>;
      expect(await verifySnsMessage({ ...m, Message: '{"x":2}' } as never, cert)).toBe(false);
      expect(await verifySnsMessage({ ...m, SignatureVersion: '3' } as never, cert)).toBe(false);
    });

    it('rejects foreign certificate hosts, stale timestamps and bad subscribe URLs', async () => {
      const foreign = { ...(sign(base) as object), SigningCertURL: 'https://evil.example.com/cert.pem' };
      expect(await verifySnsMessage(foreign as never, cert)).toBe(false);
      expect(await verifySnsMessage(sign({ ...base, Timestamp: '2020-01-01T00:00:00Z' }), cert)).toBe(false);
      const sub = { ...base, Type: 'SubscriptionConfirmation', Token: 't', SubscribeURL: 'https://evil.example.com/confirm' };
      expect(await verifySnsMessage(sign(sub), cert)).toBe(false);
      expect(await verifySnsMessage(sign({ ...sub, SubscribeURL: 'https://sns.ap-south-1.amazonaws.com/?Action=ConfirmSubscription' }), cert)).toBe(true);
      expect(await verifySnsMessage(sign(base), async () => { throw new Error('down'); })).toBe(false);
      expect(await verifySnsMessage(null as never, cert)).toBe(false);
    });
  });
});

describe('addresses, periods, fallback renderer', () => {
  it('normalises phones to E.164 and validates emails', () => {
    expect(normalisePhone('98765 43210')).toBe('+919876543210');
    expect(normalisePhone('098765-43210')).toBe('+919876543210');
    expect(normalisePhone('0044 20 7946 0958')).toBe('+442079460958');
    expect(normalisePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalisePhone('12')).toBeNull();
    expect(normaliseAddress('email', ' A@B.test ')).toEqual({ address: 'a@b.test', valid: true });
    expect(normaliseAddress('email', 'nope').valid).toBe(false);
    expect(normaliseAddress('whatsapp', 'abc').valid).toBe(false);
  });

  it('month period is computed in the tenant time zone', () => {
    const at = new Date('2026-10-31T20:00:00Z'); // 1 Nov 01:30 in Kolkata
    expect(monthPeriod('Asia/Kolkata', at)).toBe('2026-11');
    expect(monthPeriod('America/New_York', at)).toBe('2026-10');
  });

  it('{{path}} substitution escapes HTML and never reads prototypes', () => {
    const ctx = { document: { number: 'PO/1', party: { name: '<b>Acme & Co</b>' } } };
    expect(substitute('{{document.number}} {{ document.party.name }} {{missing.x}}', ctx, true)).toBe('PO/1 &lt;b&gt;Acme &amp; Co&lt;/b&gt; ');
    expect(substitute('{{document.party.name}}', ctx, false)).toBe('<b>Acme & Co</b>');
    expect(substitute('{{constructor.name}}{{document.__proto__}}', ctx, false)).toBe('');
  });
});

describe('channel adapters (mocked transports)', () => {
  let dir: string;
  const prevDir = process.env.MAIL_LOG_DIR;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'notify-')); process.env.MAIL_LOG_DIR = dir; });
  afterAll(() => { if (prevDir === undefined) delete process.env.MAIL_LOG_DIR; else process.env.MAIL_LOG_DIR = prevDir; });

  it('log email adapter writes the message JSON + attachment bytes', async () => {
    const r = await new LogEmailAdapter().send(provider({ config: { fromAddress: 'no-reply@x.test', fromName: 'X' } }), email);
    expect(r.providerMessageId).toBe(`log-${email.id}`);
    const rec = JSON.parse(readFileSync(join(dir, email.tenantId, `${email.id}.json`), 'utf8'));
    expect(rec).toMatchObject({ subject: 'PO 1', to: { address: 'v@vendor.test' }, attachments: [{ filename: 'PO-1.pdf', contentType: 'application/pdf', size: 13 }] });
    expect(existsSync(join(dir, email.tenantId, rec.attachments[0].file))).toBe(true);
    const wa = await new LogWhatsAppAdapter().send(provider({ channel: 'whatsapp' }), { id: 'w1', tenantId: email.tenantId, to: '+919876543210', template: { name: 'po_issued', language: 'en', headerKind: 'document' }, variables: ['A'], document: { filename: 'a.pdf', content: Buffer.from('x') } });
    expect(wa.providerMessageId).toBe('log-w1');
  });

  it('MIME carries the PDF attachment', async () => {
    const mime = (await buildMime(provider({ config: { fromAddress: 'f@x.test' } }), email)).toString();
    expect(mime).toContain('Subject: PO 1');
    expect(mime).toContain('filename=PO-1.pdf');
    expect(mime).toContain('Content-Type: application/pdf');
  });

  it('SES: message id on success; 4xx fails fast; 5xx and throttling retry', async () => {
    const sent: unknown[] = [];
    const ok = new SesEmailAdapter(() => ({ send: async (c: unknown) => { sent.push(c); return { MessageId: 'ses-1' }; } }) as never);
    expect((await ok.send(provider({ provider: 'ses', config: { configurationSet: 'cs' } }), email)).providerMessageId).toBe('ses-1');
    expect((sent[0] as { input: { ConfigurationSetName: string } }).input.ConfigurationSetName).toBe('cs');
    const fail = (err: object) => new SesEmailAdapter(() => ({ send: async () => { throw Object.assign(new Error('x'), err); } }) as never);
    await expect(fail({ name: 'BadRequestException', $metadata: { httpStatusCode: 400 } }).send(provider({ provider: 'ses' }), email)).rejects.toMatchObject({ permanent: true, status: 400 });
    await expect(fail({ name: 'InternalFailure', $metadata: { httpStatusCode: 500 } }).send(provider({ provider: 'ses' }), email)).rejects.toMatchObject({ permanent: false });
    await expect(fail({ name: 'TooManyRequestsException', $metadata: { httpStatusCode: 429 } }).send(provider({ provider: 'ses' }), email)).rejects.toMatchObject({ permanent: false });
    await expect(new SesEmailAdapter(() => ({ send: async () => ({}) }) as never).send(provider({ provider: 'ses' }), email)).rejects.toMatchObject({ permanent: false });
    expect(SesEmailAdapter.defaultClient(provider({ provider: 'ses', config: { region: 'eu-west-1' }, secret: { accessKeyId: 'a', secretAccessKey: 'b' } }))).toBeTruthy();
  });

  it('SMTP: SMTP 5xx (bad mailbox) fails fast, 4xx / connection errors retry', async () => {
    const t = (err?: object) => (() => ({
      sendMail: async () => { if (err) throw Object.assign(new Error('smtp'), err); return { messageId: '<m@x>' }; }, close() {},
    })) as never;
    const p = provider({ provider: 'smtp', config: { host: 'smtp.x.test', port: 587, username: 'u' }, secret: { value: 'pw' } });
    expect((await new SmtpEmailAdapter(t()).send(p, email)).providerMessageId).toBe('<m@x>');
    await expect(new SmtpEmailAdapter(t({ responseCode: 550 })).send(p, email)).rejects.toMatchObject({ permanent: true });
    await expect(new SmtpEmailAdapter(t({ responseCode: 451 })).send(p, email)).rejects.toMatchObject({ permanent: false });
    await expect(new SmtpEmailAdapter(t({ code: 'ETIMEDOUT' })).send(p, email)).rejects.toMatchObject({ permanent: false });
  });

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const waMsg = { id: 'm1', tenantId: 't', to: '+919876543210', template: { name: 'po_issued', language: 'en', headerKind: 'document' as const }, variables: ['Acme', 'PO/1', '100'], document: { filename: 'PO-1.pdf', content: Buffer.from('%PDF'), url: 'https://api.x/f' } };
  const meta = provider({ channel: 'whatsapp', provider: 'meta', config: { phoneNumberId: '123' }, secret: { accessToken: 'tok' } });

  it('Meta: uploads the PDF as media, sends a template with document header + body variables', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith('/media') ? json(200, { id: 'media-1' }) : json(200, { messages: [{ id: 'wamid.1' }] });
    }) as typeof fetch;
    const r = await new MetaWhatsAppAdapter(f).send(meta, waMsg);
    expect(r.providerMessageId).toBe('wamid.1');
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/123/media');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(String(calls[1]!.init.body));
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'template', template: { name: 'po_issued', language: { code: 'en' } } });
    expect(body.template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'document', document: { id: 'media-1', filename: 'PO-1.pdf' } }] });
    expect(body.template.components[1].parameters.map((p: { text: string }) => p.text)).toEqual(['Acme', 'PO/1', '100']);
  });

  it('Meta: link mode, 4xx fail fast, 5xx / network retry, missing config permanent', async () => {
    let sent: { template: { components: { parameters: unknown[] }[] } } | null = null;
    const f = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return json(200, { messages: [{ id: 'w2' }] }); }) as typeof fetch;
    await new MetaWhatsAppAdapter(f).send(provider({ ...meta, config: { phoneNumberId: '123', documentMode: 'link' } }), waMsg);
    expect(sent!.template.components[0]!.parameters[0]).toEqual({ type: 'document', document: { link: 'https://api.x/f', filename: 'PO-1.pdf' } });
    const status = (s: number) => (async () => json(s, { error: { message: 'x' } })) as typeof fetch;
    await expect(new MetaWhatsAppAdapter(status(400)).send(meta, { ...waMsg, template: { ...waMsg.template, headerKind: 'none' } })).rejects.toMatchObject({ permanent: true, status: 400 });
    await expect(new MetaWhatsAppAdapter(status(503)).send(meta, { ...waMsg, template: { ...waMsg.template, headerKind: 'none' } })).rejects.toMatchObject({ permanent: false, status: 503 });
    await expect(new MetaWhatsAppAdapter(status(429)).send(meta, { ...waMsg, template: { ...waMsg.template, headerKind: 'none' } })).rejects.toMatchObject({ permanent: false });
    await expect(new MetaWhatsAppAdapter((async () => { throw new Error('ECONNRESET'); }) as never).send(meta, waMsg)).rejects.toMatchObject({ permanent: false });
    await expect(new MetaWhatsAppAdapter(f).send(provider({ channel: 'whatsapp', provider: 'meta' }), waMsg)).rejects.toMatchObject({ permanent: true });
    await expect(new MetaWhatsAppAdapter(f).send(meta, { ...waMsg, document: undefined })).rejects.toMatchObject({ permanent: true });
    await expect(new MetaWhatsAppAdapter((async () => json(200, {})) as never).send(meta, { ...waMsg, template: { ...waMsg.template, headerKind: 'none' } })).rejects.toBeInstanceOf(ProviderError);
  });

  it('BSP: posts JSON with auth header and reads the id path', async () => {
    let req: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => { req = { url, init }; return json(200, { data: { messageId: 77 } }); }) as typeof fetch;
    const p = provider({ channel: 'whatsapp', provider: 'bsp', config: { url: 'https://bsp.example/send', idPath: 'data.messageId', headers: { 'X-Account': 'a1' } }, secret: { token: 'k' } });
    expect((await new BspWhatsAppAdapter(f).send(p, waMsg)).providerMessageId).toBe('77');
    expect((req!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect((req!.init.headers as Record<string, string>)['X-Account']).toBe('a1');
    expect(JSON.parse(String(req!.init.body))).toMatchObject({ to: '+919876543210', template: { name: 'po_issued', variables: ['Acme', 'PO/1', '100'] }, document: { filename: 'PO-1.pdf', base64: Buffer.from('%PDF').toString('base64') } });
    await expect(new BspWhatsAppAdapter(f).send(provider({ ...p, config: { url: 'http://x' } }), waMsg)).rejects.toMatchObject({ permanent: true });
    await expect(new BspWhatsAppAdapter((async () => json(404, {})) as never).send(p, waMsg)).rejects.toMatchObject({ permanent: true });
    await expect(new BspWhatsAppAdapter((async () => json(200, {})) as never).send(p, waMsg)).rejects.toMatchObject({ permanent: false });
  });
});
