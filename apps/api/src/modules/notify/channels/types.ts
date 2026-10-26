import { resolve } from 'node:path';

export type ProviderKind = 'ses' | 'smtp' | 'meta' | 'bsp' | 'log';

/** A provider credential resolved for one send (secret already decrypted; never logged or returned by the API). */
export interface ResolvedProvider {
  id: string | null;
  tenantId: string | null;
  channel: 'email' | 'whatsapp';
  provider: ProviderKind;
  config: Record<string, unknown>;
  secret: Record<string, string>;
}

/** Provider failure. `permanent` = do not retry (bad address / 4xx); otherwise the queue retries with backoff. */
export class ProviderError extends Error {
  constructor(message: string, readonly permanent: boolean, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** HTTP status → retry policy: 408/425/429 and 5xx retry; every other 4xx fails fast. */
export const isPermanentStatus = (s: number) => s >= 400 && s < 500 && ![408, 425, 429].includes(s);

export interface Attachment { filename: string; contentType: string; content: Buffer; /** inline image referenced as cid:<cid> */ cid?: string }

export interface EmailMessage {
  id: string;
  tenantId: string;
  to: string;
  toName: string | null;
  subject: string;
  html: string;
  attachments: Attachment[];
}

export interface WhatsAppMessage {
  id: string;
  tenantId: string;
  to: string;
  template: { name: string; language: string; headerKind: 'none' | 'text' | 'document' | 'image' };
  variables: string[];
  /** Document header (PDF). `url` is a signed file URL usable by the provider when configured for links. */
  document?: { filename: string; content: Buffer; url?: string | null };
}

export interface SendResult { providerMessageId: string }

export interface EmailAdapter { send(p: ResolvedProvider, m: EmailMessage): Promise<SendResult> }
export interface WhatsAppAdapter { send(p: ResolvedProvider, m: WhatsAppMessage): Promise<SendResult> }

/** Directory of the `log` providers (dev/test): `<repo>/.data/mail` unless MAIL_LOG_DIR is set. */
export const logDir = () => process.env.MAIL_LOG_DIR ?? resolve(__dirname, '../../../../../../.data/mail');
export const str = (v: unknown, d = ''): string => (typeof v === 'string' && v.trim() ? v.trim() : d);

/** Fetch with a timeout; network errors/timeouts become retryable ProviderErrors. */
export async function httpFetch(f: typeof fetch, url: string, init: RequestInit, timeoutMs = 15000): Promise<Response> {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderError(`network error: ${(e as Error).message}`, false);
  }
}

export async function errorText(res: Response): Promise<string> {
  const t = await res.text().catch(() => '');
  return t.slice(0, 300);
}
