import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { DOCUMENTS_PORT, DocumentsPort, RenderedMessage, TEMPLATE_RENDERER, TemplateRenderer } from '../../core/ports';

const PATH = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** `{{a.b.c}}` lookup over plain objects (own properties only). */
export function lookupPath(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function substitute(tpl: string, ctx: Record<string, unknown>, html: boolean): string {
  return tpl.replace(PATH, (_m, p: string) => {
    const v = lookupPath(ctx, p);
    const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return html ? esc(s) : s;
  });
}

/**
 * Minimal stand-in for the Templates module's renderer: plain `{{path}}` substitution (HTML-escaped for email/pdf
 * bodies), a document context from the DocumentsPort snapshot, and no PDFs (pdfForDocument reports no file).
 * Used only when TEMPLATE_RENDERER is not provided (templates module absent) — never in production builds that ship it.
 */
@Injectable()
export class FallbackRenderer implements TemplateRenderer {
  constructor(private readonly moduleRef: ModuleRef) {}

  async documentContext(tx: Tx, documentId: string): Promise<Record<string, unknown>> {
    const port = this.moduleRef.get<DocumentsPort>(DOCUMENTS_PORT, { strict: false });
    const s = await port.snapshot(tx, documentId, { lock: false });
    const party = s.values.party ? await tx.selectFrom('app.master_record').select(['code', 'name', 'data']).where('id', '=', String(s.values.party)).executeTakeFirst() : null;
    return {
      document: {
        id: s.id, number: s.number, statusLabel: s.statusKey, docTypeKey: s.docTypeKey, values: s.values,
        totalAmount: s.values.total_amount ?? null, party: party ? { code: party.code, name: party.name, ...(party.data as object) } : null,
      },
      lines: s.lines.filter(l => !l.isCancelled).map(l => ({ lineNo: l.lineNo, qty: l.qty, values: l.values })),
    };
  }

  async render(tx: Tx, templateId: string, context: Record<string, unknown>): Promise<RenderedMessage & { whatsappVariables?: string[] }> {
    const t = await tx.selectFrom('app.message_template').select(['channel', 'subject', 'body', 'version', 'whatsapp_variables']).where('id', '=', templateId).executeTakeFirst();
    if (!t) throw AppError.notFound('Template');
    const html = t.channel === 'email' || t.channel === 'pdf';
    const vars = (Array.isArray(t.whatsapp_variables) ? t.whatsapp_variables : []) as { index: number; expr: string }[];
    return {
      subject: t.subject ? substitute(t.subject, context, false) : null,
      body: substitute(t.body, context, html),
      templateVersion: t.version,
      ...(t.channel === 'whatsapp' ? { whatsappVariables: [...vars].sort((a, b) => a.index - b.index).map(v => substitute(v.expr, context, false)) } : {}),
    };
  }

  async pdfForDocument(): Promise<{ id: string; fileId: string | null }> {
    return { id: '', fileId: null };
  }
}

/** Resolves the Templates module's renderer lazily (no import-order dependency); falls back to FallbackRenderer. */
@Injectable()
export class RendererRef {
  private readonly log = new Logger('Notify');
  private override: TemplateRenderer | null = null;
  private cached: TemplateRenderer | null = null;
  private warned = false;
  constructor(private readonly moduleRef: ModuleRef, private readonly fallback: FallbackRenderer) {}

  get(): TemplateRenderer {
    if (this.override) return this.override;
    if (this.cached) return this.cached;
    try {
      this.cached = this.moduleRef.get<TemplateRenderer>(TEMPLATE_RENDERER, { strict: false });
      return this.cached;
    } catch {
      if (!this.warned) this.log.warn('TEMPLATE_RENDERER not provided; using the plain {{path}} fallback renderer');
      this.warned = true;
      return this.fallback;
    }
  }

  /** True when the real Templates renderer is wired. */
  isReal(): boolean {
    return this.get() !== this.fallback;
  }

  /** Test seam (null restores normal resolution). */
  use(r: TemplateRenderer | null) {
    this.override = r;
  }
}
