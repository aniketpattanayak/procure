import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Provider secrets at rest (platform.provider_credential.secret): AES-256-GCM with PROVIDER_KEY.
 * Format: `v1:<iv b64>:<tag b64>:<ciphertext b64>`. PROVIDER_KEY is required in production; development and test
 * derive one from JWT_SECRET (like FILE_URL_SECRET) so local runs need no extra setup. Any string is accepted and
 * hashed to 32 bytes (a 64-char hex or 44-char base64 key is used as-is).
 */
function keyFrom(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) return Buffer.from(raw, 'base64');
  return createHash('sha256').update(raw).digest();
}

let cached: Buffer | null = null;
export function providerKey(): Buffer {
  if (cached) return cached;
  const raw = process.env.PROVIDER_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') throw new Error('PROVIDER_KEY is required in production');
    cached = createHash('sha256').update(`provider-key:${process.env.JWT_SECRET ?? 'dev'}`).digest();
  } else cached = keyFrom(raw);
  return cached;
}
/** Test seam: forget the cached key (after changing process.env.PROVIDER_KEY). */
export function resetProviderKey() { cached = null; }

export function encryptSecret(plain: string, key = providerKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(blob: string, key = providerKey()): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), { authTagLength: 16 }); // SEC8-006: refuse truncated tags
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/** Provider secrets are JSON objects (e.g. { accessToken, appSecret }) or a bare string (SMTP password). */
export function parseSecret(plain: string | null): Record<string, string> {
  if (!plain) return {};
  try {
    const v = JSON.parse(plain) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  } catch { /* bare string */ }
  return { value: plain };
}

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
