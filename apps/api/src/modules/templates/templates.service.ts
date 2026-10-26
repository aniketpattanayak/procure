import { Injectable } from '@nestjs/common';
import { ErrorCode, TemplateInput, TemplateRow } from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';
import { type DocActor, DocStore } from '../documents';
import { dataFields } from '../forms';
import { DocumentContextBuilder } from './context.service';
import { TemplateEngine } from './engine';
import { StarterTemplates } from './starters/install';

export const TemplateUpdate = TemplateInput.extend({ version: z.number().int() });
export const TemplateListQuery = z.object({
  channel: z.enum(['pdf', 'email', 'whatsapp', 'inapp']).optional(),
  docType: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(),
});

export interface TemplateDbRow {
  id: string; channel: 'pdf' | 'email' | 'whatsapp' | 'inapp'; doc_type_key: string | null; key: string; name: string; subject: string | null; body: string;
  whatsapp_template_id: string | null; whatsapp_variables: unknown; pdf_options: unknown; is_default: boolean; is_active: boolean; updated_at: Date; version: number;
}
export const TEMPLATE_COLS = [
  'id', 'channel', 'doc_type_key', 'key', 'name', 'subject', 'body', 'whatsapp_template_id', 'whatsapp_variables', 'pdf_options', 'is_default',
  'is_active', 'updated_at', 'version',
] as const;

export type PdfOptions = z.infer<typeof TemplateInput>['pdfOptions'];
const PdfOptionsSchema = TemplateInput.shape.pdfOptions;

export function toTemplateRow(r: TemplateDbRow): TemplateRow {
  return {
    id: r.id, channel: r.channel, docTypeKey: r.doc_type_key, key: r.key, name: r.name, subject: r.subject ?? undefined, body: r.body,
    whatsappTemplateId: r.whatsapp_template_id ?? undefined, whatsappVariables: (r.whatsapp_variables ?? []) as TemplateRow['whatsappVariables'],
    pdfOptions: pdfOptionsOf(r), isDefault: r.is_default, isActive: r.is_active, version: r.version, updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export function pdfOptionsOf(r: Pick<TemplateDbRow, 'pdf_options'>): PdfOptions {
  const parsed = PdfOptionsSchema.safeParse(r.pdf_options ?? {});
  return parsed.success ? parsed.data : PdfOptionsSchema.parse({});
}

const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#x60;': '`', '&#x3D;': '=' };
/** Text channels (in-app, WhatsApp) render escaped like HTML; turn the entities back into characters. */
export const unescapeText = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#x60|#x3D);/g, m => HTML_ENTITIES[m] ?? m);

/** Wraps a body fragment into a full HTML document (A4 print defaults) unless it already is one. */
export function htmlDocument(body: string, title: string): string {
  if (/<html[\s>]/i.test(body)) return body;
  const esc = title.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc}</title></head><body>${body}</body></html>`;
}

export interface RenderedTemplate { subject: string | null; html: string; text: string; headerHtml: string | null; footerHtml: string | null; whatsappVariables: string[] }

/**
 * Template CRUD (contract "Templates & PDF"): one default per (channel, doc type), PDF templates beyond the first
 * per doc type need feature `pdf_templates`, syntax checked on save, soft delete (rows stay referenced by sends and
 * generated PDFs).
 */
@Injectable()
export class TemplatesService {
  readonly engine = new TemplateEngine();

  constructor(
    private readonly audit: AuditService,
    private readonly ent: EntitlementsService,
    private readonly contexts: DocumentContextBuilder,
    private readonly store: DocStore,
    private readonly starters: StarterTemplates,
  ) {}

  async list(tx: Tx, tenantId: string, q: z.infer<typeof TemplateListQuery>): Promise<TemplateRow[]> {
    await this.starters.ensureOnce(tx, tenantId);
    let qb = tx.selectFrom('app.message_template').select([...TEMPLATE_COLS]).where('tenant_id', '=', tenantId);
    if (q.channel) qb = qb.where('channel', '=', q.channel);
    if (q.docType) qb = qb.where(eb => eb.or([eb('doc_type_key', '=', q.docType!), eb('doc_type_key', 'is', null)]));
    const rows = await qb.orderBy('channel').orderBy('doc_type_key').orderBy('is_default', 'desc').orderBy('name').execute();
    return (rows as TemplateDbRow[]).map(toTemplateRow);
  }

  async load(tx: Tx, tenantId: string, id: string, lock = false): Promise<TemplateDbRow> {
    let q = tx.selectFrom('app.message_template').select([...TEMPLATE_COLS]).where('tenant_id', '=', tenantId).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw AppError.notFound('Template');
    return r as TemplateDbRow;
  }

  async byKey(tx: Tx, tenantId: string, channel: TemplateDbRow['channel'], key: string): Promise<TemplateDbRow | undefined> {
    return (await tx.selectFrom('app.message_template').select([...TEMPLATE_COLS]).where('tenant_id', '=', tenantId).where('channel', '=', channel)
      .where('key', '=', key).executeTakeFirst()) as TemplateDbRow | undefined;
  }

  /** Default active template of a channel for a doc type, falling back to the generic (doc type NULL) default. */
  async defaultFor(tx: Tx, tenantId: string, channel: TemplateDbRow['channel'], docTypeKey: string | null): Promise<TemplateDbRow | undefined> {
    await this.starters.ensureOnce(tx, tenantId);
    const rows = (await tx.selectFrom('app.message_template').select([...TEMPLATE_COLS]).where('tenant_id', '=', tenantId).where('channel', '=', channel)
      .where('is_active', '=', true).where('is_default', '=', true)
      .where(eb => (docTypeKey ? eb.or([eb('doc_type_key', '=', docTypeKey), eb('doc_type_key', 'is', null)]) : eb('doc_type_key', 'is', null)))
      .execute()) as TemplateDbRow[];
    return rows.find(r => r.doc_type_key === docTypeKey) ?? rows.find(r => r.doc_type_key === null);
  }

  // ------------------------------------------------------------------ validation
  private async validate(tx: Tx, tenantId: string, input: z.infer<typeof TemplateInput>, selfId: string | null) {
    const errors: { path: string; message: string }[] = [];
    const tryCompile = (src: string | undefined, path: string) => {
      if (!src) return;
      try {
        this.engine.check(src, path);
      } catch (e) {
        errors.push(...((e as AppError).errors ?? [{ path, message: (e as Error).message }]));
      }
    };
    tryCompile(input.body, 'body');
    tryCompile(input.subject, 'subject');
    tryCompile(input.pdfOptions?.headerHtml, 'pdfOptions.headerHtml');
    tryCompile(input.pdfOptions?.footerHtml, 'pdfOptions.footerHtml');
    input.whatsappVariables.forEach((v, i) => tryCompile(v.expr, `whatsappVariables.${i}.expr`));
    if (input.docTypeKey && !(await this.store.types.find(tx, tenantId, input.docTypeKey))) {
      errors.push({ path: 'docTypeKey', message: `Unknown document type "${input.docTypeKey}".` });
    }
    if (input.channel === 'email' && !input.subject) errors.push({ path: 'subject', message: 'Emails need a subject.' });
    if (input.channel === 'whatsapp') {
      if (!input.whatsappTemplateId) errors.push({ path: 'whatsappTemplateId', message: 'Pick an approved WhatsApp template.' });
      else {
        const ok = await sql<{ id: string }>`select id from app.my_whatsapp_templates() where id = ${input.whatsappTemplateId}::uuid`.execute(tx);
        if (!ok.rows.length) errors.push({ path: 'whatsappTemplateId', message: 'This WhatsApp template is not available for your company.' });
      }
    }
    const dupKey = await tx.selectFrom('app.message_template').select('id').where('tenant_id', '=', tenantId).where('channel', '=', input.channel)
      .where('key', '=', input.key).$if(!!selfId, q => q.where('id', '<>', selfId!)).executeTakeFirst();
    if (dupKey) errors.push({ path: 'key', message: `The key "${input.key}" is already used by another ${input.channel} template.` });
    if (errors.length) throw new AppError(400, ErrorCode.VALIDATION, 'The template has problems.', undefined, errors);

    // Extra PDF layouts per doc type are a plan feature.
    if (input.channel === 'pdf' && input.isActive) {
      const others = await tx.selectFrom('app.message_template').select(sql<string>`count(*)::text`.as('n')).where('tenant_id', '=', tenantId)
        .where('channel', '=', 'pdf').where('is_active', '=', true)
        .where(eb => (input.docTypeKey ? eb('doc_type_key', '=', input.docTypeKey) : eb('doc_type_key', 'is', null)))
        .$if(!!selfId, q => q.where('id', '<>', selfId!)).executeTakeFirstOrThrow();
      if (Number(others.n) >= 1 && !(await this.ent.hasFeature(tenantId, 'pdf_templates'))) {
        throw new AppError(403, ErrorCode.FEATURE_NOT_IN_PLAN, 'Your plan includes one PDF layout per document type. Ask for the "PDF templates" feature to add more.', { feature: 'pdf_templates' });
      }
    }
  }

  /** Clears other defaults of the same (channel, doc type) so the new default is unique. */
  private async clearDefault(tx: Tx, tenantId: string, channel: string, docTypeKey: string | null, exceptId: string | null) {
    await tx.updateTable('app.message_template').set({ is_default: false }).where('tenant_id', '=', tenantId).where('channel', '=', channel as never)
      .where('is_default', '=', true).where(eb => (docTypeKey ? eb('doc_type_key', '=', docTypeKey) : eb('doc_type_key', 'is', null)))
      .$if(!!exceptId, q => q.where('id', '<>', exceptId!)).execute();
  }

  private values(input: z.infer<typeof TemplateInput>) {
    return {
      channel: input.channel, doc_type_key: input.docTypeKey, key: input.key, name: input.name, subject: input.subject ?? null, body: input.body,
      whatsapp_template_id: input.whatsappTemplateId ?? null, whatsapp_variables: JSON.stringify(input.whatsappVariables),
      pdf_options: JSON.stringify(input.pdfOptions), is_default: input.isDefault && input.isActive, is_active: input.isActive,
    };
  }

  async create(tx: Tx, tenantId: string, userId: string | null, input: z.infer<typeof TemplateInput>): Promise<TemplateRow> {
    await this.starters.ensureOnce(tx, tenantId);
    await this.validate(tx, tenantId, input, null);
    if (input.isDefault && input.isActive) await this.clearDefault(tx, tenantId, input.channel, input.docTypeKey, null);
    const row = (await tx.insertInto('app.message_template').values({ ...this.values(input), created_by: userId, updated_by: userId })
      .returning([...TEMPLATE_COLS]).executeTakeFirstOrThrow()) as TemplateDbRow;
    await this.audit.tenant(tx, { action: 'create', entity: 'message_template', entityId: row.id, actorId: userId, after: auditView(row) });
    return toTemplateRow(row);
  }

  async update(tx: Tx, tenantId: string, userId: string | null, id: string, input: z.infer<typeof TemplateUpdate>): Promise<TemplateRow> {
    const before = await this.load(tx, tenantId, id, true);
    if (before.version !== input.version) throw AppError.versionConflict();
    await this.validate(tx, tenantId, input, id);
    if (input.isDefault && input.isActive) await this.clearDefault(tx, tenantId, input.channel, input.docTypeKey, id);
    const row = (await tx.updateTable('app.message_template').set({ ...this.values(input), updated_by: userId })
      .where('tenant_id', '=', tenantId).where('id', '=', id).returning([...TEMPLATE_COLS]).executeTakeFirstOrThrow()) as TemplateDbRow;
    await this.audit.tenant(tx, { action: 'update', entity: 'message_template', entityId: id, actorId: userId, before: auditView(before), after: auditView(row) });
    return toTemplateRow(row);
  }

  /** Soft delete: deactivates (and un-defaults) the template; sends and generated PDFs keep referencing it. */
  async remove(tx: Tx, tenantId: string, userId: string | null, id: string): Promise<TemplateRow> {
    const before = await this.load(tx, tenantId, id, true);
    const row = (await tx.updateTable('app.message_template').set({ is_active: false, is_default: false, updated_by: userId })
      .where('tenant_id', '=', tenantId).where('id', '=', id).returning([...TEMPLATE_COLS]).executeTakeFirstOrThrow()) as TemplateDbRow;
    await this.audit.tenant(tx, { action: 'delete', entity: 'message_template', entityId: id, actorId: userId, before: auditView(before) });
    return toTemplateRow(row);
  }

  // ------------------------------------------------------------------ rendering
  /** Renders a template (stored row or unsaved input) with a context. Pure CPU; no I/O. */
  renderWith(t: { channel: string; subject?: string | null; body: string; pdfOptions?: PdfOptions; whatsappVariables?: { index: number; expr: string }[]; name?: string },
    context: Record<string, unknown>): RenderedTemplate {
    const subject = t.subject ? this.engine.render(t.subject, context, 'subject') : null;
    const body = this.engine.render(t.body, context, 'body');
    const text = t.channel === 'inapp' || t.channel === 'whatsapp';
    const header = t.pdfOptions?.headerHtml ? this.engine.render(t.pdfOptions.headerHtml, context, 'pdfOptions.headerHtml') : null;
    const footer = t.pdfOptions?.footerHtml ? this.engine.render(t.pdfOptions.footerHtml, context, 'pdfOptions.footerHtml') : null;
    const vars = [...(t.whatsappVariables ?? [])].sort((a, b) => a.index - b.index).map(v => unescapeText(this.engine.render(v.expr, context, `whatsappVariables.${v.index}`)).trim());
    const title = subject ?? String((context.document as { number?: string } | undefined)?.number ?? t.name ?? 'Document');
    return {
      subject: subject === null ? null : unescapeText(subject).trim(),
      html: text ? body : htmlDocument(body, unescapeText(title)),
      text: text ? unescapeText(body) : body,
      headerHtml: header, footerHtml: footer, whatsappVariables: vars,
    };
  }

  /** POST /config/templates/preview: renders against the given document or a sample of the doc type. */
  async preview(tx: Tx, input: z.infer<typeof TemplateInput>, documentId: string | null, viewer?: DocActor | null): Promise<{ subject: string | null; html: string }> {
    const sources = [input.body, input.subject, input.pdfOptions?.headerHtml, input.pdfOptions?.footerHtml];
    // QA47-BUG-006: rendered with the viewer's field access.
    const context = documentId ? (await this.contexts.build(tx, documentId, sources, { viewer })).context : await this.contexts.sample(tx, input.docTypeKey, sources, { viewer });
    const out = this.renderWith({ ...input, name: input.name }, { ...context, event: sampleEvent(), recipient: { name: 'Recipient name' } });
    return { subject: out.subject, html: input.channel === 'inapp' || input.channel === 'whatsapp' ? out.text : out.html };
  }

  /** Placeholder picker: every standard path plus each header/line field of the doc type, with an example value. */
  async contextFields(tx: Tx, tenantId: string, docTypeKey: string | null): Promise<{ path: string; label: string; example: string }[]> {
    const ctx = await this.contexts.sample(tx, docTypeKey);
    const doc = (ctx.document ?? {}) as Record<string, unknown>;
    const line = ((ctx.lines as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
    const ex = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v).slice(0, 80));
    const get = (o: unknown, path: string) => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);
    const out: { path: string; label: string; example: string }[] = [];
    const std: [string, string][] = [
      ['tenant.name', 'Company name'], ['tenant.legalName', 'Company legal name'], ['tenant.gstin', 'Company GSTIN'], ['tenant.pan', 'Company PAN'],
      ['tenant.addressText', 'Company address'], ['tenant.logoUrl', 'Company logo URL'],
      ['document.number', 'Document number'], ['document.docTypeName', 'Document type'], ['document.statusLabel', 'Status'], ['document.docDate', 'Document date'],
      ['document.requiredBy', 'Required by'], ['document.location.name', 'Location name'], ['document.location.code', 'Location code'],
      ['document.party.name', 'Vendor name'], ['document.party.code', 'Vendor code'], ['document.party.gstin', 'Vendor GSTIN'], ['document.party.address', 'Vendor address'],
      ['document.totalAmount', 'Total amount'], ['document.currency', 'Currency'], ['document.revNo', 'Revision number'], ['document.url', 'Link to the document'],
      ['document.submittedBy.name', 'Submitted by'], ['document.createdBy.name', 'Created by'],
      ['totals.taxable', 'Taxable value'], ['totals.cgst', 'CGST total'], ['totals.sgst', 'SGST total'], ['totals.igst', 'IGST total'], ['totals.grand', 'Grand total'],
      ['event.type', 'Event type'], ['event.actor.name', 'Event actor'], ['event.comment', 'Event comment'], ['recipient.name', 'Recipient name'],
    ];
    for (const [path, label] of std) out.push({ path, label, example: ex(get(ctx, path)) });
    const type = docTypeKey ? await this.store.types.find(tx, tenantId, docTypeKey) : undefined;
    if (type) {
      const b = await this.store.bundle(tx, tenantId, type);
      for (const f of dataFields(b.header)) {
        const label = (f as { label?: string }).label ?? f.key;
        out.push({ path: `document.values.${f.key}`, label: `${label} (raw)`, example: ex((doc.values as Record<string, unknown> | undefined)?.[f.key]) });
        out.push({ path: `document.display.${f.key}`, label, example: ex((doc.display as Record<string, unknown> | undefined)?.[f.key]) });
      }
      for (const f of b.line ? dataFields(b.line) : []) {
        const label = (f as { label?: string }).label ?? f.key;
        out.push({ path: `lines[].values.${f.key}`, label: `Line › ${label} (raw)`, example: ex((line.values as Record<string, unknown> | undefined)?.[f.key]) });
        out.push({ path: `lines[].display.${f.key}`, label: `Line › ${label}`, example: ex((line.display as Record<string, unknown> | undefined)?.[f.key]) });
      }
    }
    for (const [path, label] of [['lines[].sr', 'Line › Sr. no.'], ['lines[].item.code', 'Line › Item code'], ['lines[].item.name', 'Line › Item name'],
      ['lines[].item.hsn', 'Line › HSN / SAC'], ['lines[].uom', 'Line › Unit'], ['lines[].qty', 'Line › Quantity'], ['lines[].rate', 'Line › Rate'],
      ['lines[].amount', 'Line › Amount'], ['lines[].taxAmount', 'Line › Tax amount'], ['lines[].total', 'Line › Total incl. tax']] as [string, string][]) {
      out.push({ path, label, example: ex(get(line, path.slice(8))) });
    }
    return out;
  }
}

function auditView(r: TemplateDbRow) {
  return { channel: r.channel, docTypeKey: r.doc_type_key, key: r.key, name: r.name, isDefault: r.is_default, isActive: r.is_active, version: r.version };
}

export const sampleEvent = () => ({ type: 'document.approved', at: new Date().toISOString(), actor: { name: 'Approver name' }, comment: 'Looks good' });
