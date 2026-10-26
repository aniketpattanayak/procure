import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { EmailAdapter, EmailMessage, isPermanentStatus, logDir, ProviderError, ResolvedProvider, SendResult, str } from './types';

const fromOf = (p: ResolvedProvider) => {
  const addr = str(p.config.fromAddress, str(p.config.from, 'no-reply@procure.local'));
  const name = str(p.config.fromName);
  return name ? { name, address: addr } : addr;
};
const toOf = (m: EmailMessage) => (m.toName ? { name: m.toName, address: m.to } : m.to);

function mailOptions(p: ResolvedProvider, m: EmailMessage) {
  return {
    from: fromOf(p), to: toOf(m), subject: m.subject, html: m.html,
    replyTo: str(p.config.replyTo) || undefined,
    headers: { 'X-Procure-Message': m.id },
    attachments: m.attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType, ...(a.cid ? { cid: a.cid } : {}) })),
  };
}

/** Builds the raw MIME message (used by SES; exported for tests). */
export async function buildMime(p: ResolvedProvider, m: EmailMessage): Promise<Buffer> {
  return new MailComposer(mailOptions(p, m)).compile().build();
}

/** Dev/test driver: writes the rendered email (+ attachment bytes) under .data/mail/<tenant>/ and reports success. */
export class LogEmailAdapter implements EmailAdapter {
  async send(p: ResolvedProvider, m: EmailMessage): Promise<SendResult> {
    const dir = join(logDir(), m.tenantId);
    await mkdir(dir, { recursive: true });
    const attachments = [];
    for (const a of m.attachments) {
      const safe = a.filename.replace(/[^\w.-]+/g, '_');
      const file = `${m.id}-${safe}`;
      await writeFile(join(dir, file), a.content);
      attachments.push({ filename: a.filename, contentType: a.contentType, size: a.content.length, sha256: createHash('sha256').update(a.content).digest('hex'), file, ...(a.cid ? { cid: a.cid } : {}) });
    }
    const rec = { id: m.id, provider: 'log', at: new Date().toISOString(), from: fromOf(p), to: toOf(m), subject: m.subject, html: m.html, attachments };
    await writeFile(join(dir, `${m.id}.json`), JSON.stringify(rec, null, 2));
    return { providerMessageId: `log-${m.id}` };
  }
}

/** SMTP (nodemailer). SMTP 5xx replies are permanent (bad mailbox), 4xx and connection errors are retried. */
export class SmtpEmailAdapter implements EmailAdapter {
  constructor(private readonly factory: typeof nodemailer.createTransport = nodemailer.createTransport) {}

  async send(p: ResolvedProvider, m: EmailMessage): Promise<SendResult> {
    const port = Number(p.config.port ?? 587);
    const user = str(p.config.username, str(p.secret.username));
    const pass = p.secret.password ?? p.secret.value ?? '';
    const t = this.factory({
      host: str(p.config.host), port, secure: p.config.secure === true || port === 465,
      auth: user ? { user, pass } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    try {
      const info = await t.sendMail(mailOptions(p, m));
      return { providerMessageId: String(info.messageId ?? `smtp-${m.id}`) };
    } catch (e) {
      const err = e as { responseCode?: number; code?: string; message: string };
      const permanent = (err.responseCode !== undefined && err.responseCode >= 500) || err.code === 'EENVELOPE' || err.code === 'EAUTH';
      throw new ProviderError(`SMTP: ${err.message}`.slice(0, 500), permanent, err.responseCode);
    } finally {
      t.close?.();
    }
  }
}

/** Amazon SES v2 (raw MIME so PDFs attach). Credentials from the secret, else the default AWS chain (IAM role). */
export class SesEmailAdapter implements EmailAdapter {
  constructor(private readonly clientFactory: (p: ResolvedProvider) => Pick<SESv2Client, 'send'> = SesEmailAdapter.defaultClient) {}

  static defaultClient(p: ResolvedProvider): SESv2Client {
    const { accessKeyId, secretAccessKey } = p.secret;
    return new SESv2Client({
      region: str(p.config.region, 'ap-south-1'),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      maxAttempts: 1,
    });
  }

  async send(p: ResolvedProvider, m: EmailMessage): Promise<SendResult> {
    const raw = await buildMime(p, m);
    try {
      const out = await this.clientFactory(p).send(new SendEmailCommand({
        Content: { Raw: { Data: raw } },
        ...(str(p.config.configurationSet) ? { ConfigurationSetName: str(p.config.configurationSet) } : {}),
        EmailTags: [{ Name: 'procure_message', Value: m.id }],
      }));
      if (!out.MessageId) throw new ProviderError('SES returned no message id', false);
      return { providerMessageId: out.MessageId };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const err = e as { name?: string; message: string; $metadata?: { httpStatusCode?: number }; $retryable?: unknown };
      const status = err.$metadata?.httpStatusCode;
      const throttled = err.name === 'TooManyRequestsException' || err.name === 'ThrottlingException' || !!err.$retryable;
      throw new ProviderError(`SES: ${err.name ?? 'Error'}: ${err.message}`.slice(0, 500), !throttled && status !== undefined && isPermanentStatus(status), status);
    }
  }
}
