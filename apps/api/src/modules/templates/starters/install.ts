import { Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../../../core/db.service';
import { EntitlementsService } from '../../../core/entitlements.service';
import { DOC_ACTIONS } from '../../documents';
import { TemplateContextExtensions } from '../extensions';
import { TemplatesInstaller } from '../installer';
import {
  APPROVAL_PENDING_BODY, APPROVAL_PENDING_TITLE, COMPARISON_BODY, GENERIC_BODY, GENERIC_FOOTER, INDENT_BODY, INDENT_FOOTER, PO_BODY, PO_BODY_PREVIOUS, PO_EMAIL_BODY,
  PO_EMAIL_SUBJECT, PO_FOOTER, RTV_DEBIT_NOTE_BODY, RTV_DEBIT_NOTE_FOOTER,
} from './bodies';

export interface StarterTemplate {
  channel: 'pdf' | 'email' | 'whatsapp' | 'inapp';
  docTypeKey: string | null;
  key: string;
  name: string;
  subject?: string;
  body: string;
  pdfOptions?: Record<string, unknown>;
  isDefault: boolean;
  /** Installed only when this context extension is registered (e.g. procurement's `comparison`). */
  requiresExtension?: string;
  /**
   * Bodies this starter shipped with before. An installed row whose body still equals one of them was never edited by
   * the tenant and is upgraded to `body` by the installer (edited rows are never touched).
   */
  previousBodies?: string[];
}

const A4 = (footerHtml: string) => ({ format: 'A4', landscape: false, marginMm: { top: 12, right: 12, bottom: 16, left: 12 }, footerHtml });

/** Keys agreed with the Notify agent: email `po_approved_vendor`, in-app `approval_pending`, PO PDF `po_standard`. */
export const STARTER_KEYS = {
  poPdf: 'po_standard', indentPdf: 'indent_standard', genericPdf: 'document_standard', comparisonPdf: 'comparison_sheet',
  poApprovedEmail: 'po_approved_vendor', approvalPendingInapp: 'approval_pending',
  // Phase 5 (GRN agent): debit note of a return to vendor.
  rtvDebitNote: 'rtv_debit_note',
} as const;

export const STARTER_TEMPLATES: StarterTemplate[] = [
  { channel: 'pdf', docTypeKey: 'po', key: STARTER_KEYS.poPdf, name: 'Purchase order (standard)', body: PO_BODY, pdfOptions: A4(PO_FOOTER), isDefault: true, previousBodies: PO_BODY_PREVIOUS },
  { channel: 'pdf', docTypeKey: 'indent', key: STARTER_KEYS.indentPdf, name: 'Indent (standard)', body: INDENT_BODY, pdfOptions: A4(INDENT_FOOTER), isDefault: true },
  { channel: 'pdf', docTypeKey: null, key: STARTER_KEYS.genericPdf, name: 'Any document (standard)', body: GENERIC_BODY, pdfOptions: A4(GENERIC_FOOTER), isDefault: true },
  // Needs procurement's `comparison` context extension (procurement/quotes/comparison.extension.ts).
  {
    channel: 'pdf', docTypeKey: 'indent', key: STARTER_KEYS.comparisonPdf, name: 'Comparison sheet', body: COMPARISON_BODY,
    pdfOptions: { ...A4(INDENT_FOOTER), landscape: true }, isDefault: false, requiresExtension: 'comparison',
  },
  {
    channel: 'email', docTypeKey: 'po', key: STARTER_KEYS.poApprovedEmail, name: 'PO approved → email vendor', subject: PO_EMAIL_SUBJECT,
    body: PO_EMAIL_BODY, isDefault: true,
  },
  {
    channel: 'inapp', docTypeKey: null, key: STARTER_KEYS.approvalPendingInapp, name: 'Approval pending', subject: APPROVAL_PENDING_TITLE,
    body: APPROVAL_PENDING_BODY, isDefault: true,
  },
  // Phase 5 (GRN agent)
  { channel: 'pdf', docTypeKey: 'rtv', key: STARTER_KEYS.rtvDebitNote, name: 'Debit note (return to vendor)', body: RTV_DEBIT_NOTE_BODY, pdfOptions: A4(RTV_DEBIT_NOTE_FOOTER), isDefault: true },
];

/**
 * Installs the starter templates for a tenant (idempotent: ON CONFLICT (tenant_id, channel, key) DO NOTHING; a
 * starter becomes default only when its (channel, doc type) has no default yet). Never overwrites tenant edits.
 * Also backfills the generated `doc.<type>:action.print` registry key for doc types created before Phase 6.
 */
@Injectable()
export class StarterTemplates implements OnModuleInit {
  private readonly ensured = new Set<string>();

  constructor(
    private readonly installer: TemplatesInstaller,
    private readonly extensions: TemplateContextExtensions,
    private readonly ent: EntitlementsService,
  ) {}

  onModuleInit() {
    this.installer.register({ key: 'templates.print_key', order: 50, run: async (tx, c) => { await this.backfillPrintKey(tx, c.tenantId); } });
    this.installer.register({ key: 'templates.starters', order: 100, run: (tx, c) => this.install(tx, c.tenantId, c.actorId) });
  }

  /** Lazy safety net: runs every installer step once per tenant per process. */
  async ensureOnce(tx: Tx, tenantId: string) {
    if (this.ensured.has(tenantId)) return;
    await this.installer.ensure(tx, tenantId);
    this.ensured.add(tenantId);
  }

  async install(tx: Tx, tenantId: string, actorId: string | null = null): Promise<void> {
    for (const s of STARTER_TEMPLATES) {
      if (s.requiresExtension && !this.extensions.has(s.requiresExtension)) continue;
      const docKeyCond = s.docTypeKey === null ? sql`doc_type_key is null` : sql`doc_type_key = ${s.docTypeKey}`;
      await sql`
        insert into app.message_template (tenant_id, channel, doc_type_key, key, name, subject, body, pdf_options, is_default, created_by, updated_by)
        select ${tenantId}::uuid, ${s.channel}, ${s.docTypeKey}, ${s.key}, ${s.name}, ${s.subject ?? null}, ${s.body}, ${JSON.stringify(s.pdfOptions ?? {})}::jsonb,
          ${s.isDefault} and not exists (
            select 1 from app.message_template where tenant_id = ${tenantId}::uuid and channel = ${s.channel} and ${docKeyCond} and is_default and is_active),
          ${actorId}::uuid, ${actorId}::uuid
        on conflict do nothing`.execute(tx);
      const previous = (s.previousBodies ?? []).filter(b => b !== s.body);
      if (previous.length) {
        // Idempotent upgrade of unmodified starters (QA47-BUG-007): only rows whose body is byte-equal to a shipped
        // earlier version; the version bump (touch trigger) invalidates cached PDFs.
        await sql`
          update app.message_template set body = ${s.body}
          where tenant_id = ${tenantId}::uuid and channel = ${s.channel} and key = ${s.key} and body = any(${previous}::text[])`.execute(tx);
      }
    }
  }

  /** Adds `doc.<type>:action.print` for every doc type that lacks it (types created before Phase 6). */
  async backfillPrintKey(tx: Tx, tenantId: string): Promise<number> {
    const print = DOC_ACTIONS.find(a => a.name === 'print');
    if (!print) return 0;
    const sort = DOC_ACTIONS.indexOf(print) + 1;
    const r = await sql`
      insert into app.permission_def (tenant_id, key, kind, tab_key, label, description, group_label, requires_feature, requires_setting, sort_order, source, source_id)
      select t.tenant_id, 'doc.' || t.key || ':action.print', 'action', 'doc.' || t.key, ${print.label('', '')}, null, null, t.module_key, null, ${sort}, 'form', t.id
      from app.doc_type t where t.tenant_id = ${tenantId}::uuid
      on conflict do nothing`.execute(tx);
    const n = Number(r.numAffectedRows ?? 0);
    if (n > 0) await this.ent.bumpPermissions(tenantId);
    return n;
  }
}
