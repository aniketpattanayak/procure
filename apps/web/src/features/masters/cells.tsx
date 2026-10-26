'use client';
import type { DataField, RecordRow } from '@procure/schema';
import { Badge } from '@procure/ui';
import { Paperclip } from 'lucide-react';
import { t } from '@/i18n';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { formatDecimal } from '@/engines/form-renderer/values';
import { fileHref } from '@/components/file-upload/transport';

/** Compact list-cell rendering of a record value by field type (no extra calls: refs and files come with the row). */
export function RecordCell({ field, row, currency }: { field: DataField; row: RecordRow; currency: string }) {
  const v = row.data[field.key];
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return <span className="text-fg-subtle">—</span>;
  switch (field.type) {
    case 'lookup': return <span>{row.refs?.[field.key]?.[v as string] ?? <span className="text-fg-subtle">{t('masters.unknownRef')}</span>}</span>;
    case 'multilookup': return <span>{(v as string[]).map(id => row.refs?.[field.key]?.[id] ?? '…').join(', ')}</span>;
    case 'image': case 'signature': {
      const f = row.files?.[v as string];
      const src = fileHref(f?.thumbUrl ?? f?.url);
      return src ? (
        <img src={src} alt={f?.filename ?? ''} className="size-8 rounded border border-border object-cover" loading="lazy" />
      ) : <span className="inline-block size-8 rounded border border-dashed border-border bg-subtle" aria-label={t('files.scanning')} />;
    }
    case 'file': return <span className="inline-flex items-center gap-1"><Paperclip className="size-3.5 text-fg-subtle" aria-hidden />{row.files?.[v as string]?.filename ?? t('files.file')}</span>;
    case 'files': return <span className="inline-flex items-center gap-1"><Paperclip className="size-3.5 text-fg-subtle" aria-hidden />{(v as string[]).length}</span>;
    case 'number': return <span className="tabular-nums">{formatDecimal(v, 0)}</span>;
    case 'decimal': case 'formula': return <span className="tabular-nums">{typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? formatDecimal(v, field.precision ?? 2) : String(v)}</span>;
    case 'percentage': return <span className="tabular-nums">{formatDecimal(v, field.precision ?? 2, { percent: true })}</span>;
    case 'currency': return <span className="tabular-nums">{formatDecimal(v, field.precision ?? 2, { currency: field.currency ?? currency })}</span>;
    case 'checkbox': case 'toggle': return <span>{v === true ? t('fr.yes') : t('fr.no')}</span>;
    case 'date': return <span>{fmtDate(v as string)}</span>;
    case 'datetime': return <span>{fmtDateTime(v as string)}</span>;
    case 'select': case 'radio': {
      const o = field.options.find(x => x.value === v);
      const tone = o?.color === 'green' ? 'success' : o?.color === 'red' ? 'danger' : o?.color === 'amber' ? 'warning' : o?.color === 'blue' ? 'accent' : 'neutral';
      return o?.color ? <Badge tone={tone}>{o.label}</Badge> : <span>{o?.label ?? String(v)}</span>;
    }
    case 'multiselect': return <span>{(v as string[]).map(x => field.options.find(o => o.value === x)?.label ?? x).join(', ')}</span>;
    case 'daterange': { const r = v as { from?: string; to?: string }; return <span>{fmtDate(r.from)} – {fmtDate(r.to)}</span>; }
    case 'grid': return <span className="text-fg-muted">{t('masters.rows', { n: (v as unknown[]).length })}</span>;
    default: return <span>{String(v)}</span>;
  }
}

export const numericTypes = new Set(['number', 'decimal', 'currency', 'percentage', 'formula']);
