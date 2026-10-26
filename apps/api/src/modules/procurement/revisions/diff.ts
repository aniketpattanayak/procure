import type { RevisionDiff } from '@procure/schema';

/**
 * Raw revision snapshot (stored in app.document_revision.snapshot): the document's columns + custom values and its
 * lines. Restoring a rejected amendment writes these back as they were.
 */
export interface SnapHeader {
  location_node_id: string; doc_date: string; required_by: string | null; party_id: string | null; currency: string | null;
  total_amount: string | null; custom: Record<string, unknown>;
}
export interface SnapLine {
  id: string; line_no: number; item_id: string | null; uom_id: string | null; qty: string; rate: string | null; amount: string | null;
  required_date: string | null; location_node_id: string; custom: Record<string, unknown>;
}
export interface Snapshot { number: string | null; revNo: number; header: SnapHeader; lines: SnapLine[] }

const HEADER_COLS: Record<string, keyof SnapHeader> = {
  location: 'location_node_id', doc_date: 'doc_date', required_by: 'required_by', party: 'party_id',
};
const LINE_COLS: Record<string, keyof SnapLine> = {
  item: 'item_id', uom: 'uom_id', qty: 'qty', rate: 'rate', required_date: 'required_date',
};

/** Keys never shown in a diff: reserved (`__…`) and values the engine derives from others. */
const DERIVED = new Set([
  'terms_snapshot', 'total_amount', 'amount', 'expected_date', 'currency', 'taxable_amount', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'tax_amount', 'grand_total',
]);
const skip = (k: string) => k.startsWith('__') || DERIVED.has(k);

/** Canonical comparable form: numeric strings without trailing zeros, sorted arrays of ids, dates as YYYY-MM-DD. */
export function canon(v: unknown): unknown {
  if (v === undefined || v === '') return null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
    const [i, f = ''] = v.split('.');
    const frac = f.replace(/0+$/, '');
    return frac ? `${i}.${frac}` : String(BigInt(i!));
  }
  if (typeof v === 'number') return canon(String(v));
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]));
  return v;
}
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

function headerValues(h: SnapHeader): Record<string, unknown> {
  const out: Record<string, unknown> = { ...h.custom };
  for (const [k, c] of Object.entries(HEADER_COLS)) out[k] = h[c];
  return out;
}
export function lineValues(l: SnapLine): Record<string, unknown> {
  const out: Record<string, unknown> = { ...l.custom };
  for (const [k, c] of Object.entries(LINE_COLS)) out[k] = l[c];
  return out;
}

/** Field-level diff between two snapshots (lines matched by id). `labels` maps field keys to form labels. */
export function diffSnapshots(before: Snapshot, after: Snapshot, labels: { header: Record<string, string>; line: Record<string, string> }): RevisionDiff {
  const diff: RevisionDiff = { header: [], lines: [] };
  const hb = headerValues(before.header);
  const ha = headerValues(after.header);
  for (const k of [...new Set([...Object.keys(hb), ...Object.keys(ha)])].sort()) {
    if (skip(k) || same(hb[k], ha[k])) continue;
    diff.header.push({ field: k, label: labels.header[k] ?? k, before: hb[k] ?? null, after: ha[k] ?? null });
  }
  const prev = new Map(before.lines.map(l => [l.id, l]));
  const next = new Map(after.lines.map(l => [l.id, l]));
  for (const l of after.lines) {
    const p = prev.get(l.id);
    const va = lineValues(l);
    if (!p) {
      diff.lines.push({
        lineNo: l.line_no, change: 'added',
        fields: Object.keys(va).filter(k => !skip(k) && va[k] !== null && va[k] !== undefined).sort().map(k => ({ field: k, label: labels.line[k] ?? k, before: null, after: va[k] })),
      });
      continue;
    }
    const vb = lineValues(p);
    const fields = [...new Set([...Object.keys(vb), ...Object.keys(va)])].sort().filter(k => !skip(k) && !same(vb[k], va[k]))
      .map(k => ({ field: k, label: labels.line[k] ?? k, before: vb[k] ?? null, after: va[k] ?? null }));
    if (fields.length) diff.lines.push({ lineNo: l.line_no, change: 'changed', fields });
  }
  for (const p of before.lines) {
    if (!next.has(p.id)) diff.lines.push({ lineNo: p.line_no, change: 'removed', fields: [] });
  }
  diff.lines.sort((a, b) => a.lineNo - b.lineNo);
  return diff;
}

export const isEmptyDiff = (d: RevisionDiff) => !d.header.length && !d.lines.length;
