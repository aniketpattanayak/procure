import { fromBuffer } from 'file-type';
import { extname } from 'node:path';

/** Platform-wide upload allow-list (contract: images, pdf, csv, xlsx, docx, txt). mime -> accepted extensions. */
export const ALLOWED_TYPES: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'application/pdf': ['.pdf'],
  'text/csv': ['.csv'],
  'text/plain': ['.txt'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
};

export const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const ASF_GUID = Buffer.from([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C]);

export type SniffResult ={ ok: true; mime: string; ext: string } | { ok: false; reason: string };

/** Plain text: valid UTF-8, no NUL bytes, few control characters. */
function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 64 * 1024);
  if (sample.includes(0)) return false;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(sample);
  if (text.includes('�')) return false;
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) control++;
  }
  return control <= sample.length / 100;
}

/**
 * Determines the real type from the bytes (never the client's Content-Type), then requires the filename's extension
 * to agree with it. Unknown binary, anything off the allow-list, and mismatches (a "photo.png" that is really an
 * executable or a zip) are rejected.
 */
export async function sniff(buf: Buffer, filename: string): Promise<SniffResult> {
  const ext = extname(filename).toLowerCase();
  // SEC8-002: file-type <21.3.1 spins forever (starving the event loop) on an ASF header whose sub-object size is < 24.
  // ASF is never allowed, so refuse it before the parser sees it. Remove once file-type is upgraded.
  if (buf.length >= 16 && buf.subarray(0, 16).equals(ASF_GUID)) return { ok: false, reason: 'Files of type asf are not allowed.' };
  const detected = await fromBuffer(buf);
  let mime: string;
  if (detected) {
    mime = detected.mime;
  } else if (looksLikeText(buf)) {
    mime = ext === '.csv' ? 'text/csv' : 'text/plain';
  } else {
    return { ok: false, reason: 'The file type could not be recognised.' };
  }
  const exts = ALLOWED_TYPES[mime];
  if (!exts) return { ok: false, reason: `Files of type ${detected?.ext ?? mime} are not allowed.` };
  if (!exts.includes(ext)) {
    return { ok: false, reason: `The file name ends in "${ext || '(none)'}" but the content is ${exts[0]!.slice(1).toUpperCase()}.` };
  }
  return { ok: true, mime, ext };
}

/**
 * Field-level `accept` list: MIME types ('image/png', 'image/*') or extensions ('.xlsx'). Empty = platform allow-list.
 */
export function acceptMatches(accept: readonly string[], mime: string, filename: string): boolean {
  if (!accept.length) return true;
  const ext = extname(filename).toLowerCase();
  return accept.some(a => {
    const x = a.trim().toLowerCase();
    if (!x) return false;
    if (x.startsWith('.')) return x === ext || (ALLOWED_TYPES[mime]?.includes(x) ?? false);
    if (x.endsWith('/*')) return mime.startsWith(x.slice(0, -1));
    return x === mime;
  });
}
