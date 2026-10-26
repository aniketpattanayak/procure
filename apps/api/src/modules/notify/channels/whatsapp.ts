import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorText, httpFetch, isPermanentStatus, logDir, ProviderError, ResolvedProvider, SendResult, str, WhatsAppAdapter, WhatsAppMessage } from './types';

/** Dev/test driver: writes the template message to .data/mail/<tenant>/wa-<id>.json and reports success. */
export class LogWhatsAppAdapter implements WhatsAppAdapter {
  async send(_p: ResolvedProvider, m: WhatsAppMessage): Promise<SendResult> {
    const dir = join(logDir(), m.tenantId);
    await mkdir(dir, { recursive: true });
    const rec = {
      id: m.id, provider: 'log', at: new Date().toISOString(), to: m.to, template: m.template, variables: m.variables,
      document: m.document ? { filename: m.document.filename, size: m.document.content.length } : null,
    };
    await writeFile(join(dir, `wa-${m.id}.json`), JSON.stringify(rec, null, 2));
    return { providerMessageId: `log-${m.id}` };
  }
}

async function check(res: Response, what: string): Promise<unknown> {
  if (!res.ok) throw new ProviderError(`${what} HTTP ${res.status}: ${await errorText(res)}`, isPermanentStatus(res.status), res.status);
  return res.json().catch(() => ({}));
}

/**
 * Meta WhatsApp Cloud API. config: { phoneNumberId, apiVersion?, documentMode?: 'upload' | 'link', graphBase? };
 * secret: { accessToken, appSecret (webhook signatures), verifyToken? }. Template messages only; a PDF goes into the
 * document header, uploaded as media (default) or passed as a signed link.
 */
export class MetaWhatsAppAdapter implements WhatsAppAdapter {
  constructor(private readonly f: typeof fetch = (...a) => fetch(...a)) {}

  async send(p: ResolvedProvider, m: WhatsAppMessage): Promise<SendResult> {
    const phoneId = str(p.config.phoneNumberId);
    const token = p.secret.accessToken ?? '';
    if (!phoneId || !token) throw new ProviderError('Meta provider is missing phoneNumberId or accessToken', true);
    const base = `${str(p.config.graphBase, 'https://graph.facebook.com')}/${str(p.config.apiVersion, 'v21.0')}/${encodeURIComponent(phoneId)}`;
    const auth = { Authorization: `Bearer ${token}` };
    const components: unknown[] = [];
    if (m.template.headerKind === 'document') {
      if (!m.document) throw new ProviderError('This WhatsApp template needs a document (PDF) header', true);
      let document: Record<string, string>;
      if (str(p.config.documentMode) === 'link' && m.document.url) document = { link: m.document.url, filename: m.document.filename };
      else {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'application/pdf');
        form.append('file', new Blob([new Uint8Array(m.document.content)], { type: 'application/pdf' }), m.document.filename);
        const up = await check(await httpFetch(this.f, `${base}/media`, { method: 'POST', headers: auth, body: form }), 'media upload') as { id?: string };
        if (!up.id) throw new ProviderError('media upload returned no id', false);
        document = { id: up.id, filename: m.document.filename };
      }
      components.push({ type: 'header', parameters: [{ type: 'document', document }] });
    }
    if (m.variables.length) components.push({ type: 'body', parameters: m.variables.map(text => ({ type: 'text', text })) });
    const body = {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: m.to.replace(/^\+/, ''), type: 'template',
      template: { name: m.template.name, language: { code: m.template.language }, ...(components.length ? { components } : {}) },
    };
    const out = await check(await httpFetch(this.f, `${base}/messages`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), 'send') as { messages?: { id?: string }[] };
    const id = out.messages?.[0]?.id;
    if (!id) throw new ProviderError('Meta returned no message id', false);
    return { providerMessageId: id };
  }
}

/**
 * Generic BSP (Gupshup/Twilio-style HTTP gateway). config: { url, headers?, authHeader? ('Authorization'),
 * authScheme? ('Bearer'), idPath? ('id'), documentMode? ('base64' | 'link') }; secret: { token } (or a bare string).
 * POST JSON { to, template: { name, language, variables }, document?: { filename, url | base64 } }.
 */
export class BspWhatsAppAdapter implements WhatsAppAdapter {
  constructor(private readonly f: typeof fetch = (...a) => fetch(...a)) {}

  async send(p: ResolvedProvider, m: WhatsAppMessage): Promise<SendResult> {
    const url = str(p.config.url);
    if (!/^https:\/\//.test(url)) throw new ProviderError('BSP provider needs an https url', true);
    const token = p.secret.token ?? p.secret.value ?? '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries((p.config.headers as Record<string, unknown>) ?? {})) headers[k] = String(v);
    if (token) headers[str(p.config.authHeader, 'Authorization')] = str(p.config.authScheme, 'Bearer') === 'none' ? token : `${str(p.config.authScheme, 'Bearer')} ${token}`;
    const doc = m.document
      ? (str(p.config.documentMode) === 'link' && m.document.url
        ? { filename: m.document.filename, url: m.document.url }
        : { filename: m.document.filename, base64: m.document.content.toString('base64') })
      : undefined;
    const body = { to: m.to, template: { name: m.template.name, language: m.template.language, variables: m.variables }, ...(doc ? { document: doc } : {}) };
    const out = await check(await httpFetch(this.f, url, { method: 'POST', headers, body: JSON.stringify(body) }), 'BSP send');
    const id = str(p.config.idPath, 'id').split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), out);
    if (typeof id !== 'string' && typeof id !== 'number') throw new ProviderError('BSP returned no message id', false);
    return { providerMessageId: String(id) };
  }
}
