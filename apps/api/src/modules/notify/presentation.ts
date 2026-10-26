import { formatDate, formatMoney } from '../templates';
import { lookupPath } from './renderer';

/**
 * Presentation fixes applied by the notify module to rendered output:
 *  - WhatsApp variables mapped to a bare money / date path of the standard document context (e.g.
 *    `{{document.totalAmount}}`) are formatted like the templates' formatMoney / formatDate helpers, so a template
 *    variable never shows `173600.0000`. Expressions that already use a helper are left as rendered.
 *  - Images in email HTML that point at our own file URLs become inline (CID) attachments: signed URLs are relative
 *    and short-lived, so they would be broken links in a mailbox.
 */
const MONEY = new Set(['document.totalAmount', 'document.values.total_amount', 'totals.taxable', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.cess', 'totals.grand']);
const DATES = new Set(['document.docDate', 'document.requiredBy', 'document.values.doc_date', 'document.values.required_by', 'event.at']);
const BARE = /^\{\{\s*([A-Za-z_][\w.]*)\s*\}\}$/;

export function formatWhatsAppVariables(rendered: string[], mapping: { index: number; expr: string }[], ctx: Record<string, unknown>): string[] {
  const sorted = [...mapping].sort((a, b) => a.index - b.index);
  const currency = String(lookupPath(ctx, 'document.currency') ?? lookupPath(ctx, 'tenant.currency') ?? 'INR') || 'INR';
  const tz = String(lookupPath(ctx, 'tenant.timezone') ?? 'Asia/Kolkata') || 'Asia/Kolkata';
  return rendered.map((v, i) => {
    const path = BARE.exec(sorted[i]?.expr?.trim() ?? '')?.[1];
    if (!path) return v;
    const raw = lookupPath(ctx, path);
    if (raw === null || raw === undefined || raw === '') return v;
    if (MONEY.has(path)) return formatMoney(raw, currency);
    if (DATES.has(path)) return formatDate(raw, 'DD-MMM-YYYY', tz);
    return v;
  });
}

/** Our file ids referenced by <img src> in an email body (any prefix, signed or not). */
const FILE_IMG = /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']*\/files\/([0-9a-f-]{36})\/content[^"']*)(["'])/gi;

export function inlineImageIds(html: string): string[] {
  return [...new Set([...html.matchAll(FILE_IMG)].map(m => m[3]!.toLowerCase()))];
}

/** Rewrites matching <img src> to `cid:<fileId>@procure` for the given (loaded, clean image) file ids. */
export function rewriteInlineImages(html: string, ids: Set<string>): string {
  return html.replace(FILE_IMG, (all, pre: string, _src: string, id: string, post: string) => (ids.has(id.toLowerCase()) ? `${pre}cid:${id.toLowerCase()}@procure${post}` : all));
}
