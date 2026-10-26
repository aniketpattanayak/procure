import { Injectable } from '@nestjs/common';
import type { DataField, FormDefinition } from '@procure/schema';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import { config } from '../../core/config';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { type DocActor, DocStore, DocumentsService } from '../documents';
import { FilesService, isUuid } from '../files';
import { dataFields } from '../forms';
import { TemplateContextExtensions } from './extensions';
import { formatDate, formatMoney, formatNumber } from './format';
import { TenantProfile, TenantProfileRow } from './system/tenant-profile';

/**
 * Standard Handlebars context for any document type (contract in packages/schema/src/notify.ts):
 *   tenant, document (all header values, refs resolved, display strings, field list), lines (all line values, display
 *   strings, cells for generic tables, GST split when app.line_tax rows exist), lineColumns, totals, terms, approvals,
 *   app. Callers add `event` and `recipient`. Read-only; everything is computed here because Handlebars has no
 *   arithmetic.
 */
export interface DocumentContextResult {
  context: Record<string, unknown>;
  tenantId: string;
  documentId: string;
  docTypeKey: string;
  documentVersion: number;
  number: string | null;
}

/**
 * Field keys removed from a render context (QA47-BUG-006): the viewer's unreadable header / line fields
 * (DocStore.hiddenFields, incl. formulas computed from them). Empty = full access (system sends, workflow effects).
 */
export interface HiddenFields { header: string[]; line: string[] }
export interface ContextAccess {
  /** Render with this user's field access (preview, print, manual sends). Omit for the system (full) view. */
  viewer?: DocActor | null;
  /** Precomputed hidden keys (PDF worker: stored with the cache row). Ignored when `viewer` is given. */
  hidden?: HiddenFields | null;
}
export const NO_HIDDEN: HiddenFields = { header: [], line: [] };
/** Cache variant of a hidden-field set ('' = full access). */
export const accessKeyOf = (h: HiddenFields | null | undefined): string => (h && (h.header.length || h.line.length) ? `h:${[...h.header].sort().join(',')}|l:${[...h.line].sort().join(',')}` : '');
/** Money keys of a line whose value derives from the line amount: blanked when the amount (or rate) is hidden. */
const AMOUNT_KEYS = ['amount', 'rate'];

interface FieldInfo { key: string; label: string; type: string; align: 'left' | 'right' }

const NUMERIC = new Set(['number', 'decimal', 'currency', 'percentage']);
const SKIP_IN_LISTS = new Set(['grid', 'file', 'image', 'files', 'signature']);
const FILE_TYPES = new Set(['file', 'image', 'files', 'signature']);
const ENGINE = (tenantId: string) => ({ tenantId, userId: null, perms: null });

const dec = (v: unknown): Decimal => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return new Decimal(0);
  try {
    const d = new Decimal(String(v));
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};
const money = (d: Decimal) => d.toFixed(2, Decimal.ROUND_HALF_UP);
const pct = (v: unknown) => {
  const d = dec(v);
  return d.isInteger() ? d.toFixed(0) : d.toDecimalPlaces(2).toString();
};
const toIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isUuid) : isUuid(v) ? [v] : []);

/** Display string of a field value (lookups via refs, option labels, Indian number/money/date formats). */
export function displayValue(f: { type: string; options?: { value: string; label: string }[]; precision?: number; resultType?: string; currency?: string },
  v: unknown, refs: Record<string, string> | undefined, opts: { currency: string; timezone: string }): string {
  if (v === null || v === undefined || v === '') return '';
  switch (f.type) {
    case 'lookup': case 'multilookup':
      return toIds(v).map(id => refs?.[id] ?? '').filter(Boolean).join(', ');
    case 'select': case 'radio':
      return f.options?.find(o => o.value === v)?.label ?? String(v);
    case 'multiselect':
      return (Array.isArray(v) ? v : [v]).map(x => f.options?.find(o => o.value === x)?.label ?? String(x)).join(', ');
    case 'date':
      return formatDate(v, 'DD-MMM-YYYY', opts.timezone);
    case 'datetime':
      return formatDate(v, 'DD-MMM-YYYY HH:mm', opts.timezone);
    case 'daterange':
      return Array.isArray(v) ? v.map(x => formatDate(x, 'DD-MMM-YYYY', opts.timezone)).join(' – ') : String(v);
    case 'currency':
      return formatMoney(v, f.currency ?? opts.currency);
    case 'percentage':
      return `${formatNumber(v, f.precision ?? 2)}%`;
    case 'number':
      return formatNumber(v, 0);
    case 'decimal':
      return formatNumber(v, f.precision ?? 2);
    case 'formula':
      if ((f.resultType ?? 'number') === 'number') return formatNumber(v, f.precision ?? 2);
      if (f.resultType === 'boolean') return v === true ? 'Yes' : 'No';
      if (f.resultType === 'date') return formatDate(v, 'DD-MMM-YYYY', opts.timezone);
      return String(v);
    case 'checkbox': case 'toggle':
      return v === true || v === 'true' ? 'Yes' : 'No';
    case 'grid':
      return Array.isArray(v) ? `${v.length} row${v.length === 1 ? '' : 's'}` : '';
    case 'file': case 'image': case 'files': case 'signature':
      return '';
    default:
      return typeof v === 'object' ? '' : String(v);
  }
}

/** Visible data fields of a form (not hidden/removed), in form order. */
function visibleFields(def: FormDefinition | null): DataField[] {
  if (!def) return [];
  return dataFields(def).filter(f => !(f as { hidden?: boolean }).hidden);
}

const fieldInfo = (f: DataField): FieldInfo => ({
  key: f.key, label: (f as { label?: string }).label ?? f.key, type: f.type,
  align: NUMERIC.has(f.type) || (f.type === 'formula' && ((f as { resultType?: string }).resultType ?? 'number') === 'number') ? 'right' : 'left',
});

@Injectable()
export class DocumentContextBuilder {
  constructor(
    private readonly docs: DocumentsService,
    private readonly store: DocStore,
    private readonly files: FilesService,
    private readonly profile: TenantProfile,
    private readonly extensions: TemplateContextExtensions,
  ) {}

  async tenantIdOf(tx: Tx): Promise<string> {
    const r = await sql<{ t: string | null }>`select app.current_tenant_id()::text as t`.execute(tx);
    const t = r.rows[0]?.t;
    if (!t) throw new Error('template rendering needs a tenant transaction');
    return t;
  }

  /** Tenant letterhead block (logo as a fresh signed URL when it points at one of our files). */
  async tenantContext(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
    const t = await this.profile.get(tenantId);
    if (!t) throw AppError.notFound('Company');
    return { ...tenantBlock(t), logoUrl: await this.logoUrl(tx, tenantId, t.logoUrl) };
  }

  private async logoUrl(tx: Tx, tenantId: string, raw: string | null): Promise<string | null> {
    if (!raw) return null;
    if (raw.startsWith('data:image/')) return raw;
    const m = /\/files\/([0-9a-f-]{36})\/content/i.exec(raw);
    if (m && isUuid(m[1])) {
      const row = await this.files.loadOne(tx, tenantId, m[1]!);
      return row && row.scan_status === 'clean' ? this.files.signedUrl(tenantId, row.id) : null;
    }
    // External logo URLs are kept for emails; the PDF renderer blocks them (network locked).
    return /^https:\/\//.test(raw) ? raw : null;
  }

  /**
   * Context for a document. `sources` (template bodies) decide which context extensions run.
   * Loads as the engine, then removes what `access` hides (QA47-BUG-006): a user's preview / print / manual send
   * shows only fields that user can read; system renders (automatic sends, workflow effects) see every field.
   */
  async build(tx: Tx, documentId: string, sources: (string | null | undefined)[] = [], access: ContextAccess = {}): Promise<DocumentContextResult> {
    const tenantId = await this.tenantIdOf(tx);
    const doc = await this.store.loadDoc(tx, tenantId, documentId);
    const type = await this.store.types.loadById(tx, tenantId, doc.doc_type_id);
    const actor = ENGINE(tenantId);
    const row = await this.docs.toRow(tx, actor, type, doc);
    const bundle = await this.store.bundleFor(tx, tenantId, type, doc);
    // QA47-BUG-006: the viewer's unreadable fields never reach the template.
    const hiddenSpec = access.viewer ? this.hiddenOf(access.viewer, bundle) : access.hidden ?? NO_HIDDEN;
    const hidden = { header: new Set(hiddenSpec.header), line: new Set(hiddenSpec.line) };
    const amountHidden = AMOUNT_KEYS.some(k => hidden.line.has(k));
    if (hidden.header.size) {
      for (const k of hidden.header) {
        delete row.values[k];
        delete row.refs[k];
      }
    }
    if (hidden.line.size) {
      for (const l of row.lines) {
        for (const k of hidden.line) {
          delete l.values[k];
          delete l.refs[k];
        }
      }
    }
    const tenant = await this.tenantContext(tx, tenantId);
    const fmt = { currency: String(doc.currency ?? tenant.currency ?? 'INR'), timezone: String(tenant.timezone ?? 'Asia/Kolkata') };

    // ---- header
    const headerDefs = visibleFields(bundle.header).filter(f => !hidden.header.has(f.key));
    const display: Record<string, string> = {};
    for (const f of dataFields(bundle.header)) if (!hidden.header.has(f.key)) display[f.key] = displayValue(f as never, row.values[f.key], row.refs[f.key], fmt);
    const fields = headerDefs.filter(f => !SKIP_IN_LISTS.has(f.type))
      .map(f => ({ ...fieldInfo(f), value: display[f.key] ?? '', raw: row.values[f.key] ?? null }));
    const images: Record<string, string | null> = {};
    for (const f of dataFields(bundle.header).filter(x => FILE_TYPES.has(x.type) && !hidden.header.has(x.key))) {
      const id = toIds(row.values[f.key])[0];
      const meta = id ? (row.files[id] as { url?: string | null } | undefined) : undefined;
      images[f.key] = meta?.url ?? null;
    }

    // ---- party (vendor) with its master fields; lookup ids inside resolved to names
    let party: Record<string, unknown> | null = null;
    if (doc.party_id) {
      const p = await tx.selectFrom('app.master_record').select(['id', 'code', 'name', 'data']).where('tenant_id', '=', tenantId).where('id', '=', doc.party_id).executeTakeFirst();
      if (p) {
        const data = { ...((p.data ?? {}) as Record<string, unknown>) };
        const refIds = Object.values(data).flatMap(toIds);
        const names = await this.recordNames(tx, tenantId, refIds);
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) resolved[k] = isUuid(v) ? names.get(v) ?? v : v;
        party = { ...resolved, id: p.id, code: p.code, name: p.name, values: data, paymentTerms: isUuid(data.payment_terms) ? names.get(data.payment_terms) ?? null : null };
      }
    }
    const rev = await tx.selectFrom('app.document').select('rev_no').where('tenant_id', '=', tenantId).where('id', '=', doc.id).executeTakeFirst();
    const loc = await tx.selectFrom('app.location_node').select(['id', 'code', 'name', 'custom']).where('tenant_id', '=', tenantId).where('id', '=', doc.location_node_id).executeTakeFirst();

    // ---- lines
    const lineDefs = visibleFields(bundle.line).filter(f => !hidden.line.has(f.key));
    const lineColumns = lineDefs.filter(f => !SKIP_IN_LISTS.has(f.type)).map(fieldInfo);
    const itemIds = row.lines.map(l => l.values.item).filter(isUuid);
    const items = new Map((itemIds.length
      ? await tx.selectFrom('app.master_record').select(['id', 'code', 'name', 'data']).where('tenant_id', '=', tenantId).where('id', 'in', [...new Set(itemIds)]).execute()
      : []).map(i => [i.id, i]));
    const taxRows = await tx.selectFrom('app.line_tax').select(['line_id', 'component', 'rate_pct', 'taxable_amount', 'tax_amount'])
      .where('tenant_id', '=', tenantId).where('document_id', '=', doc.id).execute();
    const taxByLine = new Map<string, typeof taxRows>();
    for (const t of taxRows) taxByLine.set(t.line_id, [...(taxByLine.get(t.line_id) ?? []), t]);

    // `discountInTaxable`: header discount the tax engine already allocated into the taxable value of taxed lines
    // (net − taxable per line with app.line_tax rows) — QA47-BUG-007: never subtract it a second time.
    const sum = { sub: new Decimal(0), taxable: new Decimal(0), cgst: new Decimal(0), sgst: new Decimal(0), igst: new Decimal(0), cess: new Decimal(0), qty: new Decimal(0), discountInTaxable: new Decimal(0) };
    const breakup = new Map<string, { component: string; ratePct: string; taxable: Decimal; amount: Decimal }>();
    let sr = 0;
    const lines = row.lines.map(l => {
      const cancelled = l.statusKey === 'cancelled';
      const ldisplay: Record<string, string> = {};
      for (const f of bundle.line ? dataFields(bundle.line) : []) if (!hidden.line.has(f.key)) ldisplay[f.key] = displayValue(f as never, l.values[f.key], l.refs[f.key], fmt);
      const item = isUuid(l.values.item) ? items.get(l.values.item) : undefined;
      const itemData = (item?.data ?? {}) as Record<string, unknown>;
      const amount = dec(l.values.amount ?? dec(l.values.qty).mul(dec(l.values.rate)));
      const taxes = (amountHidden ? [] : taxByLine.get(l.id) ?? []).map(t => ({ component: t.component, ratePct: pct(t.rate_pct), taxableAmount: money(dec(t.taxable_amount)), taxAmount: money(dec(t.tax_amount)) }));
      const taxable = taxes.length ? dec(taxes[0]!.taxableAmount) : amount;
      const comp = (c: string) => taxes.find(t => t.component === c);
      const taxAmount = taxes.reduce((a, t) => a.add(dec(t.taxAmount)), new Decimal(0));
      if (!cancelled) {
        sr++;
        sum.sub = sum.sub.add(amount);
        sum.taxable = sum.taxable.add(taxable);
        if (taxes.length) {
          const allocated = dec(money(amount)).sub(taxable);
          if (allocated.gt(0)) sum.discountInTaxable = sum.discountInTaxable.add(allocated);
        }
        sum.qty = sum.qty.add(dec(l.values.qty));
        for (const t of taxes) {
          sum[t.component as 'cgst'] = sum[t.component as 'cgst'].add(dec(t.taxAmount));
          const k = `${t.component}:${t.ratePct}`;
          const b = breakup.get(k) ?? { component: t.component, ratePct: t.ratePct, taxable: new Decimal(0), amount: new Decimal(0) };
          b.taxable = b.taxable.add(dec(t.taxableAmount));
          b.amount = b.amount.add(dec(t.taxAmount));
          breakup.set(k, b);
        }
      }
      const gstRate = taxes.filter(t => t.component !== 'cess').reduce((a, t) => a.add(dec(t.ratePct)), new Decimal(0));
      return {
        id: l.id, lineNo: l.lineNo, sr: cancelled ? null : sr, cancelled, statusKey: l.statusKey,
        item: item ? { ...itemData, id: item.id, code: item.code, name: item.name, hsn: itemData.hsn_code ?? null } : null,
        uom: ldisplay.uom || null, qty: l.values.qty ?? null, rate: l.values.rate ?? null, amount: amountHidden ? null : money(amount),
        requiredDate: l.values.required_date ?? null, values: l.values, refs: l.refs, display: ldisplay,
        cells: lineColumns.map(c => ({ key: c.key, label: c.label, align: c.align, value: ldisplay[c.key] ?? '' })),
        taxes, taxable: amountHidden ? null : money(taxable), taxAmount: amountHidden ? null : money(taxAmount), total: amountHidden ? null : money(taxable.add(taxAmount)),
        gstRatePct: taxes.length ? pct(gstRate) : null,
        cgst: comp('cgst') ?? null, sgst: comp('sgst') ?? null, igst: comp('igst') ?? null, cess: comp('cess') ?? null,
      };
    });

    // ---- totals (PO header charges when present)
    const v = row.values;
    // Money totals derive from line amounts: withheld when the viewer cannot read them (or a header total).
    const totalsHidden = amountHidden || ['total_amount', 'grand_total', 'freight', 'other_charges', 'discount_amount'].some(k => hidden.header.has(k));
    const freight = dec(v.freight);
    const other = dec(v.other_charges);
    const discount = dec(v.discount_amount);
    const tax = sum.cgst.add(sum.sgst).add(sum.igst).add(sum.cess);
    // Discount already inside `taxable` (before tax) vs the rest (taken off the grand total after tax).
    const discountBeforeTax = Decimal.min(Decimal.max(discount, new Decimal(0)), sum.discountInTaxable);
    const discountAfterTax = Decimal.max(discount.sub(discountBeforeTax), new Decimal(0));
    const grand = sum.taxable.add(tax).add(freight).add(other).sub(discountAfterTax);
    const shown = {
      lineTotal: money(sum.sub), qty: sum.qty.toString(), taxable: money(sum.taxable), cgst: money(sum.cgst), sgst: money(sum.sgst), igst: money(sum.igst),
      cess: money(sum.cess), tax: money(tax), freight: money(freight), otherCharges: money(other), discount: money(discount),
      discountBeforeTax: money(discountBeforeTax), discountAfterTax: money(discountAfterTax), preDiscount: money(sum.taxable.add(discountBeforeTax)), grand: money(grand),
      hasTax: taxRows.length > 0, isInterState: sum.igst.gt(0), hasCharges: !freight.isZero() || !other.isZero() || !discount.isZero(),
      breakup: [...breakup.values()].sort((a, b) => a.component.localeCompare(b.component) || Number(a.ratePct) - Number(b.ratePct))
        .map(b => ({ component: b.component, label: `${b.component.toUpperCase()} @ ${b.ratePct}%`, ratePct: b.ratePct, taxable: money(b.taxable), amount: money(b.amount) })),
    };
    const totals = totalsHidden
      ? { ...Object.fromEntries(Object.keys(shown).map(k => [k, null])), qty: hidden.line.has('qty') ? null : shown.qty, hasTax: false, isInterState: false, hasCharges: false, breakup: [] }
      : shown;

    const document = {
      id: doc.id, docTypeKey: type.key, docTypeName: type.name, number: doc.number, statusKey: row.statusKey, statusLabel: row.statusLabel,
      isDraft: row.statusKey === 'draft', docDate: doc.doc_date, requiredBy: doc.required_by,
      location: loc ? { id: loc.id, code: loc.code, name: loc.name, values: loc.custom ?? {} } : null,
      party, currency: fmt.currency, totalAmount: totalsHidden ? null : doc.total_amount, revNo: rev?.rev_no ?? 0,
      url: documentUrl(type.key, doc.id), values: row.values, refs: row.refs, display, fields, images,
      createdBy: row.createdBy, createdAt: row.createdAt, submittedBy: row.submittedBy, submittedAt: row.submittedAt, version: doc.version,
    };

    const context: Record<string, unknown> = {
      tenant, document, lines, lineColumns, totals,
      terms: await this.terms(tx, tenantId, row.values),
      approvals: await this.approvals(tx, tenantId, doc.id),
      app: { url: config.webOrigin[0] ?? '', generatedAt: new Date().toISOString() },
    };
    await this.extensions.apply(tx, sources, { tenantId, documentId: doc.id, docTypeKey: type.key, context });
    return { context, tenantId, documentId: doc.id, docTypeKey: type.key, documentVersion: doc.version, number: doc.number };
  }

  private hiddenOf(viewer: DocActor, bundle: Awaited<ReturnType<DocStore['bundleFor']>>): HiddenFields {
    const h = this.store.hiddenFields(viewer, bundle);
    return { header: [...h.header].sort(), line: [...h.line].sort() };
  }

  /** Hidden field keys of a document for a viewer (null viewer / engine = none). Used as the PDF cache variant. */
  async hiddenFor(tx: Tx, viewer: DocActor | null | undefined, documentId: string): Promise<HiddenFields> {
    if (!viewer?.perms) return NO_HIDDEN;
    const tenantId = await this.tenantIdOf(tx);
    const doc = await this.store.loadDoc(tx, tenantId, documentId);
    const type = await this.store.types.loadById(tx, tenantId, doc.doc_type_id);
    return this.hiddenOf(viewer, await this.store.bundleFor(tx, tenantId, type, doc));
  }

  private async recordNames(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const rows = await tx.selectFrom('app.master_record').select(['id', 'name']).where('tenant_id', '=', tenantId).where('id', 'in', uniq).execute();
    return new Map(rows.map(r => [r.id, r.name]));
  }

  /** T&C: the PO snapshot (`terms_snapshot` [{code,name,body}]) when present, else the picked `terms` master records. */
  private async terms(tx: Tx, tenantId: string, values: Record<string, unknown>): Promise<{ code: string; name: string; body: string }[]> {
    const snap = values.terms_snapshot;
    if (Array.isArray(snap)) {
      return snap.filter(x => x && typeof x === 'object').map(x => {
        const t = x as Record<string, unknown>;
        return { code: String(t.code ?? ''), name: String(t.name ?? ''), body: String(t.body ?? '') };
      });
    }
    const ids = toIds(values.terms);
    if (!ids.length) return [];
    const rows = await tx.selectFrom('app.master_record').select(['id', 'code', 'name', 'data']).where('tenant_id', '=', tenantId).where('id', 'in', ids).execute();
    const byId = new Map(rows.map(r => [r.id, r]));
    return ids.map(id => byId.get(id)).filter(r => !!r).map(r => ({ code: r!.code, name: r!.name, body: String((r!.data as Record<string, unknown>)?.body ?? '') }));
  }

  /** Workflow decisions in order: stage name, who, when, outcome, comment. */
  private async approvals(tx: Tx, tenantId: string, documentId: string) {
    const acts = await tx.selectFrom('app.wf_action as a').innerJoin('app.wf_instance as i', 'i.id', 'a.instance_id')
      .leftJoin('app.tenant_user as u', 'u.id', 'a.actor_id')
      .select(['a.stage_key', 'a.action', 'a.at', 'a.comment', 'a.decisions', 'u.name as actor_name', 'i.workflow_version_id'])
      .where('a.tenant_id', '=', tenantId).where('a.document_id', '=', documentId).where('a.action', '=', 'decide')
      .orderBy('a.at').orderBy('a.id').execute();
    if (!acts.length) return [];
    const versionIds = [...new Set(acts.map(a => a.workflow_version_id))];
    const versions = await tx.selectFrom('app.workflow_version').select(['id', 'definition']).where('tenant_id', '=', tenantId).where('id', 'in', versionIds).execute();
    const stageNames = new Map<string, string>();
    for (const v of versions) {
      for (const s of ((v.definition as { stages?: { key: string; name: string }[] })?.stages ?? [])) stageNames.set(`${v.id}:${s.key}`, s.name);
    }
    return acts.filter(a => a.actor_name).map(a => {
      const ds = (Array.isArray(a.decisions) ? a.decisions : []) as { approve?: string; hold?: string; reject?: string }[];
      const t = ds.reduce((acc, d) => ({ a: acc.a.add(dec(d.approve)), h: acc.h.add(dec(d.hold)), r: acc.r.add(dec(d.reject)) }), { a: new Decimal(0), h: new Decimal(0), r: new Decimal(0) });
      const outcome = t.a.gt(0) ? (t.h.gt(0) || t.r.gt(0) ? 'Partially approved' : 'Approved') : t.r.gt(0) ? 'Rejected' : t.h.gt(0) ? 'On hold' : 'Decided';
      return { stage: stageNames.get(`${a.workflow_version_id}:${a.stage_key}`) ?? a.stage_key, stageKey: a.stage_key, by: a.actor_name, at: new Date(a.at).toISOString(), outcome, comment: a.comment };
    });
  }

  /**
   * Sample context for previews when no document is given: the latest document of the type, else a synthetic one
   * built from the type's forms (field labels as values) so every placeholder shows something.
   */
  async sample(tx: Tx, docTypeKey: string | null, sources: (string | null | undefined)[] = [], access: ContextAccess = {}): Promise<Record<string, unknown>> {
    const tenantId = await this.tenantIdOf(tx);
    const latest = await this.latestDocument(tx, tenantId, docTypeKey);
    if (latest) return (await this.build(tx, latest, sources, access)).context;
    return this.synthetic(tx, tenantId, docTypeKey);
  }

  async latestDocument(tx: Tx, tenantId: string, docTypeKey: string | null): Promise<string | null> {
    let q = tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select('d.id')
      .where('d.tenant_id', '=', tenantId).where('d.is_deleted', '=', false);
    if (docTypeKey) q = q.where('t.key', '=', docTypeKey);
    const r = await q.orderBy('d.created_at', 'desc').limit(1).executeTakeFirst();
    return r?.id ?? null;
  }

  private async synthetic(tx: Tx, tenantId: string, docTypeKey: string | null): Promise<Record<string, unknown>> {
    const tenant = await this.tenantContext(tx, tenantId);
    const type = docTypeKey ? await this.store.types.find(tx, tenantId, docTypeKey) : undefined;
    const bundle = type ? await this.store.bundle(tx, tenantId, type).catch(() => null) : null;
    const header = visibleFields(bundle?.header ?? null);
    const line = visibleFields(bundle?.line ?? null);
    const sampleOf = (f: DataField) => (NUMERIC.has(f.type) ? '1000.00' : f.type === 'date' ? new Date().toISOString().slice(0, 10) : `[${(f as { label?: string }).label ?? f.key}]`);
    const values = Object.fromEntries(header.map(f => [f.key, sampleOf(f)]));
    const lineValues = Object.fromEntries(line.map(f => [f.key, sampleOf(f)]));
    const lineColumns = line.filter(f => !SKIP_IN_LISTS.has(f.type)).map(fieldInfo);
    const id = '00000000-0000-0000-0000-000000000000';
    return {
      tenant,
      document: {
        id, docTypeKey: docTypeKey ?? 'document', docTypeName: type?.name ?? 'Document', number: 'SAMPLE/0001', statusKey: 'draft', statusLabel: 'Draft', isDraft: true,
        docDate: new Date().toISOString().slice(0, 10), requiredBy: null, location: { code: 'LOC', name: '[Location]', values: {} },
        party: { code: 'VEN-0001', name: '[Vendor name]', gstin: '27AAAAA0000A1Z5', address: '[Vendor address]', state_code: '27' },
        currency: tenant.currency ?? 'INR', totalAmount: '1000.00', revNo: 0, url: documentUrl(docTypeKey ?? 'document', id), values, refs: {},
        display: Object.fromEntries(header.map(f => [f.key, String(values[f.key])])), images: {},
        fields: header.filter(f => !SKIP_IN_LISTS.has(f.type)).map(f => ({ ...fieldInfo(f), value: String(values[f.key]), raw: values[f.key] })),
      },
      lines: [{
        id, lineNo: 1, sr: 1, cancelled: false, item: { code: 'ITM-00001', name: '[Item name]', hsn: '0000' }, uom: 'NOS', qty: '1', rate: '1000.00', amount: '1000.00',
        values: lineValues, refs: {}, display: Object.fromEntries(line.map(f => [f.key, String(lineValues[f.key])])),
        cells: lineColumns.map(c => ({ key: c.key, label: c.label, align: c.align, value: String(lineValues[c.key]) })),
        taxes: [], taxable: '1000.00', taxAmount: '0.00', total: '1000.00', gstRatePct: null, cgst: null, sgst: null, igst: null, cess: null,
      }],
      lineColumns,
      totals: { lineTotal: '1000.00', qty: '1', taxable: '1000.00', cgst: '0.00', sgst: '0.00', igst: '0.00', cess: '0.00', tax: '0.00', freight: '0.00', otherCharges: '0.00', discount: '0.00', discountBeforeTax: '0.00', discountAfterTax: '0.00', preDiscount: '1000.00', grand: '1000.00', hasTax: false, isInterState: false, hasCharges: false, breakup: [] },
      terms: [{ code: 'T1', name: '[Term]', body: '[Terms and conditions text]' }],
      approvals: [],
      app: { url: config.webOrigin[0] ?? '', generatedAt: new Date().toISOString() },
      sample: true,
    };
  }
}

export function tenantBlock(t: TenantProfileRow) {
  const a = t.address ?? {};
  const lines = [a.line1, a.line2, [a.city, a.postalCode].filter(Boolean).join(' - '), a.state].filter(x => x && String(x).trim());
  return {
    id: t.id, code: t.code, name: t.name, legalName: t.legalName ?? t.name, gstin: t.taxIds?.gstin ?? null, pan: t.taxIds?.pan ?? null,
    address: { ...a }, addressText: lines.join(', '), stateCode: a.stateCode ?? (t.taxIds?.gstin ? t.taxIds.gstin.slice(0, 2) : null),
    currency: t.currency, timezone: t.timezone, logoUrl: t.logoUrl,
  };
}

export function documentUrl(typeKey: string, id: string): string {
  return `${(config.webOrigin[0] ?? '').replace(/\/+$/, '')}/docs/${typeKey}/${id}`;
}
