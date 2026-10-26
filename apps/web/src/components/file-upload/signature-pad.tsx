'use client';
import type { FileMeta } from '@procure/schema';
import { Button } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { Eraser, Loader2, PenLine, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fileHref, getFileMeta, uploadFile } from './transport';

export interface SignaturePadProps {
  id?: string;
  value: string | null | undefined;
  onChange: (fileId: string | null) => void;
  formKey?: string;
  fieldKey: string;
  meta?: FileMeta;
  onMeta?: (m: FileMeta) => void;
  readOnly?: boolean;
  'aria-describedby'?: string;
}

/** Draw with mouse, pen or touch; "Use signature" uploads a PNG through POST /files and stores its id. */
export function SignaturePad({ id, value, onChange, formKey, fieldKey, meta: known, onMeta, readOnly, ...aria }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!value);

  const q = useQuery({ queryKey: ['file', value], queryFn: () => getFileMeta(value!), enabled: !!value && !known, staleTime: 4 * 60_000 });
  const meta = known ?? q.data;

  useEffect(() => { if (!value) setEditing(true); }, [value]);

  // Size the canvas to its CSS box at device pixel ratio, with an ink colour that follows the theme.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !editing) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.round(rect.width * ratio);
    c.height = Math.round(rect.height * ratio);
    const ctx = c.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1F2328';
  }, [editing]);

  function pos(e: PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (readOnly) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = e.currentTarget.getContext('2d')!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
    setDirty(true);
  }
  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext('2d')!;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function up() { drawing.current = false; }

  function clear() {
    const c = canvasRef.current;
    if (!c) return;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setDirty(false);
  }

  async function save() {
    const c = canvasRef.current;
    if (!c || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      // Composite onto white so the PNG is readable on any background (and in print).
      const out = document.createElement('canvas');
      out.width = c.width;
      out.height = c.height;
      const ctx = out.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(c, 0, 0);
      const blob = await new Promise<Blob | null>(res => out.toBlob(res, 'image/png'));
      if (!blob) throw new Error(t('files.failed'));
      const m = await uploadFile(blob, { filename: `${fieldKey}-signature.png`, formKey, fieldKey });
      onMeta?.(m);
      onChange(m.id);
      setEditing(false);
      setDirty(false);
    } catch (e) {
      setError(isApiError(e) ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (value && !editing) {
    const src = fileHref(meta?.url ?? meta?.thumbUrl);
    return (
      <div className="flex items-end gap-3" data-testid={`signature-${fieldKey}`}>
        <div className="grid h-24 w-64 max-w-full place-items-center overflow-hidden rounded border border-border bg-white">
          {src ? (
            <img src={src} alt={t('files.signatureAlt')} className="max-h-full max-w-full object-contain" />
          ) : (
            <Loader2 className="size-5 animate-spin text-fg-subtle" aria-label={t('common.loading')} />
          )}
        </div>
        {!readOnly && (
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}><PenLine aria-hidden />{t('files.signAgain')}</Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(null)} aria-label={t('files.removeSignature')}><X aria-hidden /></Button>
          </div>
        )}
      </div>
    );
  }
  if (readOnly) return <p className="text-sm text-fg-subtle">—</p>;

  return (
    <div className="space-y-2" data-testid={`signature-${fieldKey}`}>
      <canvas
        ref={canvasRef}
        id={id}
        role="img"
        aria-label={t('files.signatureCanvas')}
        {...aria}
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="h-36 w-full max-w-md touch-none rounded border border-dashed border-border-strong bg-white"
        data-testid={`signature-canvas-${fieldKey}`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={!dirty} loading={saving} data-testid={`signature-save-${fieldKey}`}>{t('files.useSignature')}</Button>
        <Button size="sm" variant="ghost" onClick={clear} disabled={!dirty}><Eraser aria-hidden />{t('files.clear')}</Button>
        {value && <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('common.cancel')}</Button>}
        <span className="text-xs text-fg-subtle">{t('files.signHint')}</span>
      </div>
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}
