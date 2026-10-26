import { createHmac, timingSafeEqual } from 'node:crypto';

/** Outgoing webhook signature header: `t=<unix seconds>,v1=<hex hmac-sha256(secret, t + '.' + body)>`. */
export function signWebhook(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${mac}`;
}

/** Receiver-side check (documented for customers; used by tests). Rejects signatures older than `toleranceSec`. */
export function verifyWebhookSignature(secret: string, body: string, header: string, toleranceSec = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=') as [string, string]));
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || !parts.v1 || Math.abs(now - ts) > toleranceSec) return false;
  return safeEqualHex(createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'), parts.v1);
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Meta webhook: `X-Hub-Signature-256: sha256=<hex hmac-sha256(appSecret, rawBody)>`. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=') || !appSecret) return false;
  const mac = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqualHex(mac, header.slice(7).toLowerCase());
}
