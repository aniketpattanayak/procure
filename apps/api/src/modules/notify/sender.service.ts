import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { sql } from 'kysely';
import { DbService } from '../../core/db.service';
import type { RenderHiddenFields } from '../../core/ports';
import { EntitlementsService } from '../../core/entitlements.service';
import { QueueService } from '../../core/queue.service';
import { FilesService } from '../files';
import { BspWhatsAppAdapter, LogWhatsAppAdapter, MetaWhatsAppAdapter } from './channels/whatsapp';
import { LogEmailAdapter, SesEmailAdapter, SmtpEmailAdapter } from './channels/email';
import { Attachment, EmailAdapter, ProviderError, ProviderKind, WhatsAppAdapter } from './channels/types';
import { SEND_QUEUE, SendJob } from './outbound.service';
import { ProviderStore } from './platform/providers.store';
import { RendererRef } from './renderer';
import { formatWhatsAppVariables, inlineImageIds, rewriteInlineImages } from './presentation';

/** How long a send waits for its PDF attachment to render before retrying later. */
const PDF_WAIT_MS = 20_000;

/**
 * Processors of `send-email` / `send-whatsapp` (concurrency 5). Each job sends one outbound_message:
 *   queued → sending → sent | failed (4xx / permanent: fail fast) | queued again (5xx / timeout: retried by BullMQ
 *   with exponential backoff; the last attempt marks it failed). Rows not in queued/sending are left alone, so a
 *   redelivered job never sends twice. Provider + feature + WhatsApp template approval are re-checked at send time.
 */
@Injectable()
export class SenderService implements OnModuleInit {
  private readonly log = new Logger('Notify');
  /** Adapters by provider kind — replaceable in tests (mocked transports). */
  readonly email: Record<Exclude<ProviderKind, 'meta' | 'bsp'>, EmailAdapter> = { log: new LogEmailAdapter(), smtp: new SmtpEmailAdapter(), ses: new SesEmailAdapter() };
  readonly whatsapp: Record<Exclude<ProviderKind, 'ses' | 'smtp'>, WhatsAppAdapter> = { log: new LogWhatsAppAdapter(), meta: new MetaWhatsAppAdapter(), bsp: new BspWhatsAppAdapter() };

  constructor(
    private readonly db: DbService,
    private readonly queue: QueueService,
    private readonly providers: ProviderStore,
    private readonly ent: EntitlementsService,
    private readonly files: FilesService,
    private readonly renderer: RendererRef,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor(SEND_QUEUE.email, job => this.process('email', job), 5);
    this.queue.registerProcessor(SEND_QUEUE.whatsapp, job => this.process('whatsapp', job), 5);
  }

  /** One attempt. Exposed for tests (pass a job-like object with attemptsMade / opts.attempts). */
  async process(channel: 'email' | 'whatsapp', job: Pick<Job<SendJob>, 'data' | 'attemptsMade' | 'opts'>): Promise<{ status: string }> {
    const { messageId, tenantId } = job.data;
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const msg = await this.db.tenantTx(tenantId, async tx => {
      const m = await tx.selectFrom('app.outbound_message').selectAll().where('id', '=', messageId).forUpdate().executeTakeFirst();
      if (!m || m.channel !== channel || (m.status !== 'queued' && m.status !== 'sending')) return null;
      await tx.updateTable('app.outbound_message').set(eb => ({ status: 'sending', attempts: eb('attempts', '+', 1) })).where('id', '=', m.id).execute();
      return m;
    });
    if (!msg) return { status: 'skipped' };

    const finish = (patch: Record<string, unknown>) => this.db.tenantTx(tenantId, tx => tx.updateTable('app.outbound_message').set(patch).where('id', '=', messageId).execute());
    try {
      const provider = await this.providers.resolve(tenantId, channel);
      const featureOn = await this.ent.hasFeature(tenantId, channel);
      if (!provider || !featureOn) {
        await finish({ status: 'blocked_config', error: !featureOn ? `${channel === 'email' ? 'Email' : 'WhatsApp'} is not included in your plan` : 'No provider is configured' });
        return { status: 'blocked_config' };
      }
      let providerMessageId: string;
      if (channel === 'email') {
        const attachments = await this.attachments(tenantId, msg.id, msg.document_id, job.data.attachPdfTemplateId, msg.attachment_file_ids, false, msg.render_hidden);
        const inline = await this.inlineImages(tenantId, msg.body_preview ?? '');
        const adapter = this.email[provider.provider as keyof SenderService['email']];
        if (!adapter) throw new ProviderError(`"${provider.provider}" cannot send email`, true);
        ({ providerMessageId } = await adapter.send(provider, {
          id: msg.id, tenantId, to: msg.recipient, toName: msg.recipient_name, subject: msg.subject ?? '', html: inline.html, attachments: [...attachments, ...inline.attachments],
        }));
      } else {
        const wa = await this.whatsappPayload(tenantId, msg.template_id, msg.document_id, msg.recipient_name, msg.render_hidden);
        if (!wa) {
          await finish({ status: 'blocked_config', error: 'The WhatsApp template is not approved for your company' });
          return { status: 'blocked_config' };
        }
        let document: { filename: string; content: Buffer; url: string | null } | undefined;
        if (wa.template.headerKind === 'document') {
          const files = await this.attachments(tenantId, msg.id, msg.document_id, job.data.attachPdfTemplateId, msg.attachment_file_ids, true, msg.render_hidden);
          const f = files[0];
          if (!f) throw new ProviderError('This WhatsApp template needs a PDF of the document', true);
          document = { filename: f.filename, content: f.content, url: f.url ?? null };
        }
        const adapter = this.whatsapp[provider.provider as keyof SenderService['whatsapp']];
        if (!adapter) throw new ProviderError(`"${provider.provider}" cannot send WhatsApp messages`, true);
        ({ providerMessageId } = await adapter.send(provider, { id: msg.id, tenantId, to: msg.recipient, template: wa.template, variables: wa.variables, document }));
      }
      await finish({ status: 'sent', sent_at: new Date(), provider: provider.provider, provider_message_id: providerMessageId, error: null });
      return { status: 'sent' };
    } catch (e) {
      const permanent = e instanceof ProviderError && e.permanent;
      const text = (e as Error).message.slice(0, 1000);
      if (permanent || lastAttempt) {
        await finish({ status: 'failed', error: text });
        this.log.warn(`${channel} ${messageId} failed${permanent ? ' (permanent)' : ''}: ${text}`);
        throw new UnrecoverableError(text);
      }
      await finish({ status: 'queued', error: text });
      throw e;
    }
  }

  /**
   * PDF attachment(s): files already rendered for this message, else `pdfForDocument` (waits up to 20 s). A PDF that
   * is not ready yet throws a retryable error; the file ids are stored so retries reuse the same file.
   */
  private async attachments(tenantId: string, messageId: string, documentId: string | null, pdfTemplateId: string | null, fileIds: string[], forWhatsApp = false,
    hidden: RenderHiddenFields | null = null): Promise<(Attachment & { url?: string })[]> {
    if (!documentId || (!pdfTemplateId && !forWhatsApp && !fileIds.length)) return [];
    return this.db.tenantTx(tenantId, async tx => {
      let ids = fileIds;
      if (!ids.length) {
        const pdf = await this.renderer.get().pdfForDocument(tx, documentId, pdfTemplateId, { waitMs: PDF_WAIT_MS, hidden });
        if (!pdf.fileId) throw new ProviderError('The PDF attachment is not ready yet', false);
        ids = [pdf.fileId];
        await tx.updateTable('app.outbound_message').set({ attachment_file_ids: ids }).where('id', '=', messageId).execute();
      }
      const rows = await this.files.loadMany(tx, tenantId, ids);
      const out: (Attachment & { url?: string })[] = [];
      for (const r of rows) {
        if (r.scan_status !== 'clean') throw new ProviderError(`Attachment ${r.filename} is not available`, false);
        out.push({ filename: r.filename, contentType: r.mime, content: await this.files.storage.get(r.storage_key), url: this.files.signedUrl(tenantId, r.id, null) });
      }
      return out;
    });
  }

  /** Our own file images in the HTML (logo, signatures) → inline CID attachments (signed URLs expire in mailboxes). */
  private async inlineImages(tenantId: string, html: string): Promise<{ html: string; attachments: Attachment[] }> {
    const ids = inlineImageIds(html);
    if (!ids.length) return { html, attachments: [] };
    return this.db.tenantTx(tenantId, async tx => {
      const rows = (await this.files.loadMany(tx, tenantId, ids)).filter(r => r.scan_status === 'clean' && r.mime.startsWith('image/'));
      const attachments: Attachment[] = [];
      for (const r of rows) attachments.push({ filename: r.filename, contentType: r.mime, content: await this.files.storage.get(r.storage_key), cid: `${r.id.toLowerCase()}@procure` });
      return { html: rewriteInlineImages(html, new Set(rows.map(r => r.id.toLowerCase()))), attachments };
    });
  }

  /** Template name/language/header + rendered variables; null when the template is no longer allowed. */
  private async whatsappPayload(tenantId: string, templateId: string | null, documentId: string | null, recipientName: string | null, hidden: RenderHiddenFields | null = null) {
    if (!templateId) return null;
    return this.db.tenantTx(tenantId, async tx => {
      const t = await tx.selectFrom('app.message_template').select(['whatsapp_template_id', 'whatsapp_variables']).where('id', '=', templateId).executeTakeFirst();
      if (!t?.whatsapp_template_id) return null;
      const wa = (await sql<{ name: string; language: string; header_kind: string }>`
        select name, language, header_kind from app.my_whatsapp_templates() where id = ${t.whatsapp_template_id}::uuid`.execute(tx)).rows[0];
      if (!wa) return null;
      const ctx = documentId ? await this.renderer.get().documentContext(tx, documentId, { hidden }) : {};
      const full = { ...ctx, recipient: { name: recipientName ?? '' } };
      const r = await this.renderer.get().render(tx, templateId, full);
      return {
        template: { name: wa.name, language: wa.language, headerKind: wa.header_kind as 'none' | 'text' | 'document' | 'image' },
        variables: formatWhatsAppVariables(r.whatsappVariables ?? [], (t.whatsapp_variables ?? []) as { index: number; expr: string }[], full),
      };
    });
  }
}

