'use client';
import type { FileMeta } from '@procure/schema';
import { Button, cn } from '@procure/ui';
import { useQuery } from '@tanstack/react-query';
import { FileText, ImagePlus, Loader2, Paperclip, ShieldAlert, Upload, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { t } from '@/i18n';
import { isApiError } from '@/lib/api';
import { fileHref, getFileMeta, uploadFile } from './transport';

export interface FileUploadProps {
  id?: string;
  /** File id (single) or ids (multiple). */
  value: string | string[] | null | undefined;
  onChange: (next: string | string[] | null) => void;
  multiple?: boolean;
  maxFiles?: number;
  /** MIME types or extensions. Empty = server default allow-list. */
  accept?: string[];
  maxSizeMb?: number;
  /** Image mode: thumbnails and an image-first drop zone. */
  image?: boolean;
  formKey?: string;
  fieldKey: string;
  /** Known metadata (e.g. RecordRow.files) so existing files render without extra calls. */
  metas?: Record<string, FileMeta>;
  onMeta?: (meta: FileMeta) => void;
  disabled?: boolean;
  readOnly?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

interface Pending { key: string; name: string; preview: string | null; error?: string }

const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

function accepts(file: File, accept: string[]) {
  if (!accept.length) return true;
  const name = file.name.toLowerCase();
  return accept.some(a => {
    const x = a.toLowerCase().trim();
    if (x.startsWith('.')) return name.endsWith(x);
    if (x.endsWith('/*')) return file.type.startsWith(x.slice(0, -1));
    return file.type === x;
  });
}

function describeAccept(accept: string[]) {
  return accept.map(a => (a.startsWith('.') ? a.slice(1) : a.split('/')[1] ?? a)).map(s => s.toUpperCase().replace('JPEG', 'JPG')).join(', ');
}

/** Upload control for file, image and files fields: client-side type/size/count checks, previews, scan status. */
export function FileUpload({
  id, value, onChange, multiple = false, maxFiles = 1, accept = [], maxSizeMb = 10, image = false, formKey, fieldKey, metas, onMeta, disabled, readOnly, ...aria
}: FileUploadProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = (Array.isArray(value) ? value : value ? [value] : []).filter(Boolean);
  const [pending, setPending] = useState<Pending[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const limit = multiple ? maxFiles : 1;
  const canAdd = !disabled && !readOnly && (multiple ? ids.length + pending.length < limit : true);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  async function addFiles(list: FileList | File[]) {
    setProblem(null);
    const files = Array.from(list);
    const room = multiple ? limit - idsRef.current.length - pending.length : 1;
    if (multiple && files.length > room) setProblem(t('files.tooMany', { n: limit }));
    const accepted: File[] = [];
    for (const f of files.slice(0, Math.max(room, 0))) {
      if (!accepts(f, accept)) { setProblem(t('files.badType', { name: f.name, types: describeAccept(accept) })); continue; }
      if (f.size > maxSizeMb * 1024 * 1024) { setProblem(t('files.tooBig', { name: f.name, mb: maxSizeMb })); continue; }
      accepted.push(f);
    }
    for (const f of accepted) {
      const key = `${f.name}-${f.size}-${Math.random()}`;
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
      setPending(p => [...p, { key, name: f.name, preview }]);
      try {
        const meta = await uploadFile(f, { formKey, fieldKey });
        onMeta?.(meta);
        if (multiple) onChange([...idsRef.current, meta.id]);
        else onChange(meta.id);
        setPending(p => p.filter(x => x.key !== key));
      } catch (e) {
        const msg = isApiError(e) ? e.message : t('files.failed');
        setPending(p => p.filter(x => x.key !== key));
        setProblem(t('files.uploadError', { name: f.name, message: msg }));
      } finally {
        if (preview) setTimeout(() => URL.revokeObjectURL(preview), 30_000);
      }
    }
  }

  function remove(fid: string) {
    if (multiple) onChange(ids.filter(x => x !== fid));
    else onChange(null);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (canAdd && e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  }

  const acceptAttr = accept.join(',') || undefined;
  const hint = [
    accept.length ? describeAccept(accept) : null,
    t('files.maxSize', { mb: maxSizeMb }),
    multiple ? t('files.maxCount', { n: limit }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="space-y-2" data-testid={`upload-${fieldKey}`}>
      {(ids.length > 0 || pending.length > 0) && (
        <ul className={cn(image ? 'flex flex-wrap gap-2' : 'space-y-1.5')}>
          {ids.map(fid => (
            <FileItem key={fid} id={fid} meta={metas?.[fid]} image={image} onMeta={onMeta} onRemove={disabled || readOnly ? undefined : () => remove(fid)} />
          ))}
          {pending.map(p => (
            <li key={p.key} className={cn(image ? 'relative size-24 overflow-hidden rounded border border-border bg-subtle' : 'flex items-center gap-2 rounded border border-border px-2.5 py-1.5 text-sm')} aria-live="polite">
              {image && p.preview ? (
                <>
                  <img src={p.preview} alt="" className="size-full object-cover opacity-60" />
                  <span className="absolute inset-0 grid place-items-center"><Loader2 className="size-5 animate-spin text-fg" aria-hidden /></span>
                  <span className="sr-only">{t('files.uploading', { name: p.name })}</span>
                </>
              ) : (
                <><Loader2 className="size-4 animate-spin text-fg-subtle" aria-hidden /><span className="truncate">{t('files.uploading', { name: p.name })}</span></>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAdd && (!readOnly) && (multiple || ids.length === 0 || !image) && (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center justify-center gap-1 rounded border border-dashed px-4 py-4 text-center transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'border-border-strong bg-subtle',
            image && 'py-5',
          )}
        >
          {image ? <ImagePlus className="size-5 text-fg-subtle" aria-hidden /> : <Upload className="size-5 text-fg-subtle" aria-hidden />}
          <p className="text-sm text-fg-muted">
            <label htmlFor={inputId} className="cursor-pointer font-medium text-accent underline-offset-4 hover:underline">
              {ids.length && !multiple ? t('files.replace') : image ? t('files.chooseImage') : t('files.choose')}
            </label>{' '}
            {t('files.orDrop')}
          </p>
          <p className="text-xs text-fg-subtle">{hint}</p>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            className="sr-only"
            accept={acceptAttr}
            multiple={multiple}
            disabled={disabled}
            onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
            data-testid={`upload-input-${fieldKey}`}
            {...aria}
          />
        </div>
      )}
      {readOnly && ids.length === 0 && <p className="text-sm text-fg-subtle">—</p>}
      {problem && <p role="alert" className="text-xs font-medium text-danger">{problem}</p>}
    </div>
  );
}

function FileItem({ id, meta: known, image, onMeta, onRemove }: { id: string; meta?: FileMeta; image: boolean; onMeta?: (m: FileMeta) => void; onRemove?: () => void }) {
  const needsFetch = !known || (known.scanStatus === 'pending');
  const q = useQuery({
    queryKey: ['file', id],
    queryFn: () => getFileMeta(id),
    enabled: needsFetch,
    staleTime: 4 * 60_000,
    // Poll while the virus scan runs.
    refetchInterval: query => (query.state.data?.scanStatus === 'pending' ? 2000 : false),
  });
  const meta = q.data ?? known;
  useEffect(() => { if (q.data && onMeta) onMeta(q.data); }, [q.data, onMeta]);

  const scanning = meta?.scanStatus === 'pending';
  const bad = meta?.scanStatus === 'infected' || meta?.scanStatus === 'error';
  const name = meta?.filename ?? t('files.file');

  if (image) {
    const src = fileHref(meta?.thumbUrl ?? meta?.url);
    return (
      <li className="group relative size-24 overflow-hidden rounded border border-border bg-subtle" data-testid="upload-item">
        {src ? (
          <a href={fileHref(meta?.url) ?? src} target="_blank" rel="noreferrer" className="block size-full" aria-label={t('files.open', { name })}>
            <img src={src} alt={name} className="size-full object-cover" />
          </a>
        ) : (
          <span className="grid size-full place-items-center text-fg-subtle">
            {bad ? <ShieldAlert className="size-5 text-danger" aria-label={t('files.blocked')} /> : <Loader2 className="size-5 animate-spin" aria-label={scanning ? t('files.scanning') : t('common.loading')} />}
          </span>
        )}
        {onRemove && (
          <button type="button" onClick={onRemove} className="absolute right-1 top-1 rounded-full bg-surface/90 p-0.5 text-fg shadow-pop hover:bg-surface focus-visible:outline-2 focus-visible:outline-ring" aria-label={t('files.remove', { name })}>
            <X className="size-3.5" />
          </button>
        )}
      </li>
    );
  }
  return (
    <li className="flex items-center gap-2 rounded border border-border bg-surface px-2.5 py-1.5 text-sm" data-testid="upload-item">
      {bad ? <ShieldAlert className="size-4 shrink-0 text-danger" aria-hidden /> : meta?.mime === 'application/pdf' ? <FileText className="size-4 shrink-0 text-fg-subtle" aria-hidden /> : <Paperclip className="size-4 shrink-0 text-fg-subtle" aria-hidden />}
      {meta?.url ? (
        <a href={fileHref(meta.url)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-accent underline-offset-4 hover:underline">{name}</a>
      ) : (
        <span className="min-w-0 flex-1 truncate">{name}</span>
      )}
      <span className="shrink-0 text-xs text-fg-subtle">
        {scanning ? t('files.scanning') : bad ? t('files.blocked') : meta ? fmtSize(meta.sizeBytes) : ''}
      </span>
      {onRemove && (
        <Button type="button" variant="ghost" size="icon-sm" className="size-6" onClick={onRemove} aria-label={t('files.remove', { name })}><X /></Button>
      )}
    </li>
  );
}
