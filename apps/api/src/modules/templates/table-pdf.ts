import type { PdfRenderOptions } from './pdf.renderer';

/** One cell of a tabular PDF (same values the xlsx/csv export writers take). */
export type TableCell = string | number | boolean | null | Date;

export interface TablePdfInput {
  title: string;
  /** e.g. company name · generated at · row count. */
  subtitle?: string | null;
  header: string[];
  rows: TableCell[][];
  /** Footnote under the table (e.g. "first 5,000 rows"). */
  note?: string | null;
  /** Default: landscape when there are more than 6 columns. */
  landscape?: boolean;
}

/** Cap for one tabular PDF; larger exports should use xlsx/csv (the caller adds a note). */
export const TABLE_PDF_MAX_ROWS = 5000;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function cell(v: TableCell): { text: string; num: boolean } {
  if (v === null || v === undefined) return { text: '', num: false };
  if (v instanceof Date) return { text: v.toISOString().slice(0, 10), num: false };
  if (typeof v === 'boolean') return { text: v ? 'Yes' : 'No', num: false };
  if (typeof v === 'number') return { text: Number.isFinite(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 4 }) : '', num: true };
  return { text: v, num: false };
}

/**
 * Self-contained HTML for a simple report table: no scripts, no external resources (the PDF renderer's network lock
 * aborts everything except the page itself anyway). The header row repeats on every page; page numbers go in the
 * Chromium footer template.
 */
export function tableHtml(input: TablePdfInput): string {
  const head = input.header.map(h => `<th>${esc(h)}</th>`).join('');
  const body = input.rows.map(r => `<tr>${r.map(v => { const c = cell(v); return `<td${c.num ? ' class="n"' : ''}>${esc(c.text)}</td>`; }).join('')}</tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(input.title)}</title><style>
* { box-sizing: border-box; }
body { font-family: "Noto Sans", "DejaVu Sans", "Liberation Sans", Arial, sans-serif; font-size: 8.5pt; color: #111; margin: 0; }
h1 { font-size: 13pt; margin: 0 0 2pt; }
.sub { color: #555; margin: 0 0 8pt; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th { background: #f1f3f5; text-align: left; font-weight: 600; }
th, td { border: 0.5pt solid #ccd; padding: 2.5pt 4pt; vertical-align: top; word-break: break-word; }
td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.note { color: #555; margin-top: 6pt; }
.empty { color: #777; padding: 8pt 0; }
</style></head><body>
<h1>${esc(input.title)}</h1>${input.subtitle ? `<p class="sub">${esc(input.subtitle)}</p>` : ''}
${input.rows.length ? `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>` : '<p class="empty">No rows.</p>'}
${input.note ? `<p class="note">${esc(input.note)}</p>` : ''}
</body></html>`;
}

export function tablePdfOptions(input: TablePdfInput): PdfRenderOptions {
  return {
    format: 'A4', landscape: input.landscape ?? input.header.length > 6, marginMm: { top: 12, right: 10, bottom: 14, left: 10 },
    headerHtml: null,
    footerHtml: '<div style="font-size:7pt;color:#777;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  };
}
