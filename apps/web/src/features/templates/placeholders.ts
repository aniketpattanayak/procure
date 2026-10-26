import type { ContextField } from '@/features/notify/api';

/** The fixed helper set (packages/schema/src/notify.ts). `snippet` is what the picker inserts. */
export const HELPERS = [
  { name: 'formatDate', signature: "formatDate date 'DD-MMM-YYYY'", snippet: "{{formatDate document.docDate 'DD-MMM-YYYY'}}" },
  { name: 'formatMoney', signature: "formatMoney amount 'INR'", snippet: "{{formatMoney document.totalAmount 'INR'}}" },
  { name: 'formatNumber', signature: 'formatNumber value places', snippet: '{{formatNumber qty 2}}' },
  { name: 'amountInWords', signature: "amountInWords amount 'INR'", snippet: "{{amountInWords totals.grand 'INR'}}" },
  { name: 'upper', signature: 'upper text', snippet: '{{upper document.number}}' },
  { name: 'lower', signature: 'lower text', snippet: '{{lower document.party.name}}' },
  { name: 'eq', signature: 'eq a b', snippet: "{{#if (eq document.statusLabel 'Approved')}}…{{/if}}" },
  { name: 'ifEq', signature: 'ifEq a b', snippet: "{{#ifEq document.statusLabel 'Approved'}}…{{/ifEq}}" },
  { name: 'qrCode', signature: 'qrCode text', snippet: '{{{qrCode document.url}}}' },
] as const;

export type PlaceholderGroup = 'document' | 'party' | 'lines' | 'totals' | 'tenant' | 'other';

export function groupOf(path: string): PlaceholderGroup {
  if (path === 'lines' || path.startsWith('lines.')) return 'lines';
  if (path.startsWith('document.party')) return 'party';
  if (path.startsWith('document.')) return 'document';
  if (path.startsWith('totals.')) return 'totals';
  if (path.startsWith('tenant.')) return 'tenant';
  return 'other';
}

export const GROUP_ORDER: PlaceholderGroup[] = ['document', 'party', 'lines', 'totals', 'tenant', 'other'];

/**
 * Text to insert for a field. Line fields inside a `{{#each lines}}` block insert the bare name; outside one
 * they insert a whole loop so the result is valid straight away.
 */
export function snippetFor(f: ContextField, insideLines: boolean): { text: string; caret?: number } {
  if (f.path === 'lines') {
    const text = '{{#each lines}}\n  {{lineNo}}. {{item.name}}  {{qty}} {{uom}}\n{{/each}}';
    return { text };
  }
  if (f.path.startsWith('lines.')) {
    const inner = `{{${f.path.slice(6)}}}`;
    if (insideLines) return { text: inner };
    const text = `{{#each lines}}\n  ${inner}\n{{/each}}`;
    return { text, caret: text.indexOf(inner) + inner.length };
  }
  return { text: `{{${f.path}}}` };
}

export function exampleText(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
  return String(v).slice(0, 40);
}
