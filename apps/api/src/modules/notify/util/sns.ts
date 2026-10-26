import { createPublicKey, createVerify } from 'node:crypto';

/**
 * Amazon SNS message signature verification (SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA).
 * The signing certificate must come from an https://sns.<region>.amazonaws.com(.cn)/…pem URL; it is fetched once and
 * cached. `fetchCert` is injectable for tests (returns a PEM certificate or public key).
 */
export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation' | string;
  MessageId: string;
  Token?: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  SubscribeURL?: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isSnsUrl(raw: string | undefined, pem = false): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && SNS_HOST.test(u.hostname) && (!pem || u.pathname.endsWith('.pem'));
  } catch {
    return false;
  }
}

/** Canonical string-to-sign (field order fixed by AWS). */
export function snsStringToSign(m: SnsMessage): string {
  const keys = m.Type === 'Notification'
    ? ['Message', 'MessageId', ...(m.Subject !== undefined && m.Subject !== null ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map(k => `${k}\n${(m as unknown as Record<string, string>)[k]}\n`).join('');
}

export type CertFetcher = (url: string) => Promise<string>;
const certCache = new Map<string, string>();
export const httpCertFetcher: CertFetcher = async url => {
  const hit = certCache.get(url);
  if (hit) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!res.ok) throw new Error(`certificate fetch failed (${res.status})`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
};

export async function verifySnsMessage(m: SnsMessage, fetchCert: CertFetcher = httpCertFetcher, maxAgeMs = 60 * 60 * 1000): Promise<boolean> {
  if (!m || typeof m !== 'object' || typeof m.Signature !== 'string' || typeof m.Message !== 'string') return false;
  if (!isSnsUrl(m.SigningCertURL, true)) return false;
  if (m.Type === 'SubscriptionConfirmation' && !isSnsUrl(m.SubscribeURL)) return false;
  const algo = m.SignatureVersion === '1' ? 'RSA-SHA1' : m.SignatureVersion === '2' ? 'RSA-SHA256' : null;
  if (!algo) return false;
  const at = Date.parse(m.Timestamp);
  if (!Number.isFinite(at) || Math.abs(Date.now() - at) > maxAgeMs) return false;
  try {
    const key = createPublicKey(await fetchCert(m.SigningCertURL));
    return createVerify(algo).update(snsStringToSign(m), 'utf8').verify(key, m.Signature, 'base64');
  } catch {
    return false;
  }
}
