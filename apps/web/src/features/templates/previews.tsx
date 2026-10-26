'use client';
import { cn } from '@procure/ui';
import { Bell, FileText } from 'lucide-react';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import type { PdfOptions } from '@/features/notify/api';

const PX_PER_MM = 96 / 25.4;
export const PAPER_MM: Record<PdfOptions['format'], [number, number]> = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const fillPageVars = (html: string, page: number, total: number) =>
  html.replace(/<span class="pageNumber"><\/span>/g, String(page)).replace(/<span class="totalPages"><\/span>/g, String(total))
    .replace(/<span class="date"><\/span>/g, new Date().toLocaleDateString('en-IN')).replace(/<span class="title"><\/span>/g, '');

/**
 * The rendered PDF body on true-to-scale paper: page size and orientation from the options, margins drawn as a
 * dashed frame, header/footer in the margin bands, and page breaks marked where the content would flow onto the
 * next sheet. Scripts never run (sandboxed iframe without allow-scripts).
 */
export function PaperPreview({ html, options, loading }: { html: string; options: PdfOptions; loading?: boolean }) {
  const [wrapRef, avail] = useWidth<HTMLDivElement>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [contentPx, setContentPx] = useState(0);
  const [wMm, hMm] = (() => { const [w, h] = PAPER_MM[options.format ?? 'A4']; return options.landscape ? [h, w] : [w, h]; })();
  const m = options.marginMm ?? { top: 15, right: 12, bottom: 15, left: 12 };
  const pageW = wMm * PX_PER_MM;
  const pageH = hMm * PX_PER_MM;
  const bodyH = (hMm - m.top - m.bottom) * PX_PER_MM;
  const pages = Math.max(1, Math.ceil(contentPx / Math.max(1, bodyH)));
  const scale = avail > 0 ? Math.min(1, (avail - 2) / pageW) : 0.5;
  const totalH = pages * pageH;

  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#fff;color:#1f2328;font-family:Helvetica,Arial,sans-serif;font-size:11pt;}
    #flow{width:${wMm - m.left - m.right}mm;margin-left:${m.left}mm;padding-top:${m.top}mm;}
  </style></head><body><div id="flow">${html}</div></body></html>`;

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => {
      try {
        const flow = el.contentDocument?.getElementById('flow');
        if (flow) setContentPx(flow.scrollHeight - m.top * PX_PER_MM);
      } catch { /* cross-origin: keep one page */ }
    };
    el.addEventListener('load', measure);
    return () => el.removeEventListener('load', measure);
  }, [m.top]);

  return (
    <div ref={wrapRef} className="relative w-full" data-testid="tpl-paper" data-format={options.format} data-landscape={options.landscape ? 'true' : 'false'} data-pages={pages}>
      <div className="mx-auto" style={{ width: pageW * scale, height: totalH * scale }}>
        <div className="relative origin-top-left" style={{ width: pageW, height: totalH, transform: `scale(${scale})` }}>
          {Array.from({ length: pages }, (_, i) => (
            <div key={i} className="absolute left-0 bg-white shadow-[0_1px_3px_rgb(16_24_40/0.18),0_8px_24px_rgb(16_24_40/0.10)]" style={{ top: i * pageH, width: pageW, height: pageH - (i < pages - 1 ? 12 / scale : 0) }} aria-hidden />
          ))}
          <iframe
            ref={frame}
            title={t('tpl.preview.frame')}
            sandbox="allow-same-origin"
            srcDoc={doc}
            className={cn('absolute left-0 top-0 border-0 bg-transparent transition-opacity', loading && 'opacity-60')}
            style={{ width: pageW, height: Math.max(pageH, contentPx + m.top * PX_PER_MM + 4) }}
          />
          {/* Margin frames, header/footer bands and page breaks */}
          {Array.from({ length: pages }, (_, i) => (
            <div key={i} className="pointer-events-none absolute left-0" style={{ top: i * pageH, width: pageW, height: pageH }} aria-hidden>
              <div className="absolute border border-dashed border-sky-500/50" style={{ top: m.top * PX_PER_MM, left: m.left * PX_PER_MM, right: m.right * PX_PER_MM, bottom: m.bottom * PX_PER_MM }} />
              {options.headerHtml && (
                <BandFrame html={fillPageVars(options.headerHtml, i + 1, pages)} align="start" style={{ top: 4 * PX_PER_MM, left: m.left * PX_PER_MM, right: m.right * PX_PER_MM, height: Math.max(0, m.top - 6) * PX_PER_MM }} />
              )}
              {options.footerHtml && (
                <BandFrame html={fillPageVars(options.footerHtml, i + 1, pages)} align="end" style={{ bottom: 4 * PX_PER_MM, left: m.left * PX_PER_MM, right: m.right * PX_PER_MM, height: Math.max(0, m.bottom - 6) * PX_PER_MM }} />
              )}
              {i > 0 && <div className="absolute left-0 right-0 border-t-2 border-dashed border-sky-500/40" style={{ top: 0 }} />}
              <span className="absolute right-1.5 top-1 rounded bg-neutral-900/70 px-1.5 text-[11px] text-white" style={{ fontSize: 11 / scale }}>{t('tpl.preview.pageOf', { n: i + 1, total: pages })}</span>
            </div>
          ))}
          {/* White mask over the flow between pages so content in the bottom/top margins reads as a page break */}
          {Array.from({ length: pages - 1 }, (_, i) => (
            <div key={`gap${i}`} className="pointer-events-none absolute left-0 bg-subtle" style={{ top: (i + 1) * pageH - 12 / scale, width: pageW, height: 12 / scale }} aria-hidden />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Header/footer band. SEC8-004: this HTML is authored by template editors, so it is never injected into the app's own
 * DOM (a regex "strip scripts" was bypassable, e.g. `<img src=x/onerror=...>`); it renders in a fully sandboxed
 * iframe (no scripts, opaque origin) like the body.
 */
function BandFrame({ html, align, style }: { html: string; align: 'start' | 'end'; style: CSSProperties }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent;}
    body{display:flex;flex-direction:column;justify-content:flex-${align};font-family:Helvetica,Arial,sans-serif;font-size:8pt;color:#404040;}</style></head><body><div>${html}</div></body></html>`;
  return <iframe title="" aria-hidden tabIndex={-1} sandbox="" srcDoc={doc} className="absolute border-0 bg-transparent" style={style} />;
}

/** Auto-height sandboxed HTML (email body). */
export function HtmlFrame({ html, title, testId, minHeight = 160 }: { html: string; title: string; testId?: string; minHeight?: number }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(minHeight);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { try { setH(Math.max(minHeight, (el.contentDocument?.body.scrollHeight ?? 0) + 24)); } catch { /* keep */ } };
    el.addEventListener('load', measure);
    return () => el.removeEventListener('load', measure);
  }, [minHeight]);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:16px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;background:#fff}</style></head><body>${html}</body></html>`;
  return <iframe ref={ref} title={title} sandbox="allow-same-origin" srcDoc={doc} className="block w-full border-0 bg-white" style={{ height: h }} data-testid={testId} />;
}

export function EmailPreview({ subject, html, to, attachments }: { subject: string | null; html: string; to?: string; attachments?: string[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm" data-testid="tpl-email-preview">
      <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 border-b border-border bg-subtle px-4 py-3 text-sm">
        {to !== undefined && <><dt className="text-fg-subtle">{t('tpl.email.to')}</dt><dd className="min-w-0 truncate">{to || '—'}</dd></>}
        <dt className="text-fg-subtle">{t('tpl.email.subject')}</dt>
        <dd className="min-w-0 font-medium" data-testid="tpl-email-subject">{subject || <span className="text-fg-subtle">{t('tpl.email.noSubject')}</span>}</dd>
        {!!attachments?.length && <><dt className="text-fg-subtle">{t('tpl.email.attached')}</dt><dd className="flex flex-wrap gap-1.5">{attachments.map(a => <span key={a} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 text-xs"><FileText className="size-3" aria-hidden />{a}</span>)}</dd></>}
      </dl>
      <HtmlFrame html={html} title={t('tpl.email.bodyFrame')} />
    </div>
  );
}

/** WhatsApp message bubble: optional document header, body with variables filled, template name below. */
export function WhatsAppBubble({ body, headerKind, templateName, fileName }: { body: string; headerKind?: string; templateName?: string; fileName?: string }) {
  return (
    <div className="rounded-lg bg-[#e7ded3] p-4 dark:bg-[#1c2a26]" data-testid="tpl-wa-preview">
      <div className="ml-auto max-w-[22rem] rounded-lg rounded-tr-none bg-[#d9fdd3] p-1.5 text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">
        {headerKind === 'document' && (
          <div className="mb-1 flex items-center gap-2 rounded bg-black/5 px-2.5 py-2 text-sm dark:bg-white/10">
            <FileText className="size-6 shrink-0 text-[#c0392b]" aria-hidden />
            <span className="min-w-0 truncate">{fileName ?? t('tpl.wa.pdf')}</span>
          </div>
        )}
        <p className="whitespace-pre-wrap px-1.5 pb-1 pt-0.5 text-[14px] leading-snug">{body}</p>
        <p className="px-1.5 text-right text-[11px] opacity-60">{templateName}</p>
      </div>
    </div>
  );
}

export function InAppPreview({ title, body }: { title: string | null; body: string }) {
  return (
    <div className="max-w-sm rounded-lg border border-border bg-surface p-3 shadow-pop" data-testid="tpl-inapp-preview">
      <div className="flex gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><Bell className="size-4" aria-hidden /></span>
        <div className="min-w-0">
          <p className="font-medium">{title || t('tpl.inapp.noTitle')}</p>
          <p className="mt-0.5 text-sm text-fg-muted">{body}</p>
          <p className="mt-1 text-xs text-fg-subtle">{t('tpl.inapp.justNow')}</p>
        </div>
      </div>
    </div>
  );
}
