import { Injectable, Logger } from '@nestjs/common';
import { ErrorCode, FileMeta } from '@procure/schema';
import { sql } from 'kysely';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { decodeImage, MAX_IMAGE_PIXELS } from './image';
import { AuditService } from '../../core/audit.service';
import { config } from '../../core/config';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { ClamAvScanner, NoopScanner, Scanner } from './scanner';
import { acceptMatches, IMAGE_MIMES, sniff } from './sniff';
import { LocalStorageDriver, S3StorageDriver, StorageDriver } from './storage';

/** The part of a multer file we use (memory storage). */
export interface UploadedBlob {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Per-field upload rules (from a form field of type file/image/files/signature). */
export interface FileFieldRules {
  label: string;
  accept: string[];
  maxSizeMb: number;
}

export interface FileRow {
  id: string;
  storage_key: string;
  filename: string;
  mime: string;
  size_bytes: string;
  sha256: string;
  scan_status: 'pending' | 'clean' | 'infected' | 'error';
  width: number | null;
  height: number | null;
  attached_to: { kind: string; id: string; field: string } | null;
  created_at: Date;
  created_by: string | null;
  is_deleted: boolean;
}

export interface AttachTarget {
  kind: string;
  id: string;
}

const FILE_COLS = [
  'id', 'storage_key', 'filename', 'mime', 'size_bytes', 'sha256', 'scan_status', 'width', 'height', 'attached_to', 'created_at',
  'created_by', 'is_deleted',
] as const;
const THUMB_WIDTH = 240;
const GB = 1073741824;

const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
const notAvailable = () => new AppError(404, ErrorCode.NOT_FOUND, 'File not found or not available');

/** Strips path parts and control characters from a client file name. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
  return cleaned || 'file';
}

@Injectable()
export class FilesService {
  private readonly log = new Logger('Files');
  readonly storage: StorageDriver;
  readonly scanner: Scanner;

  constructor(private readonly db: DbService, private readonly audit: AuditService) {
    const f = config.files;
    this.storage = f.driver === 's3' ? new S3StorageDriver(f.s3.bucket, f.s3.region, f.s3.endpoint) : new LocalStorageDriver(f.dir);
    this.scanner = f.scanner === 'clamav' ? new ClamAvScanner(f.clamav.host, f.clamav.port) : new NoopScanner();
  }

  // ------------------------------------------------------------------ upload
  /**
   * Stores an upload: sniff + allow-list, optional field rules, storage meter, sha256, image size, scan.
   * The file starts unattached (orphan) until a record save attaches it.
   */
  async upload(tenantId: string, userId: string | null, file: UploadedBlob, rules?: FileFieldRules | null): Promise<FileMeta> {
    if (!file?.buffer) throw bad('file', 'Choose a file to upload.');
    const filename = cleanFilename(file.originalname ?? 'file');
    const size = file.buffer.length;
    if (size === 0) throw bad('file', 'The file is empty.');
    if (size > config.files.maxUploadBytes) throw bad('file', 'Files can be at most 25 MB.');
    const sniffed = await sniff(file.buffer, filename);
    if (!sniffed.ok) throw bad('file', sniffed.reason);
    if (rules) {
      if (!acceptMatches(rules.accept, sniffed.mime, filename)) {
        throw bad('file', `${rules.label} accepts only ${rules.accept.join(', ')}.`);
      }
      if (size > rules.maxSizeMb * 1024 * 1024) throw bad('file', `${rules.label} accepts files up to ${rules.maxSizeMb} MB.`);
    }
    let width: number | null = null;
    let height: number | null = null;
    if (IMAGE_MIMES.has(sniffed.mime)) {
      // SEC8-016: decompression bombs are refused up front (sharp's explicit limitInputPixels; metadata reads only the
      // header, so nothing large is allocated), with a message that says why.
      const tooLarge = () => bad('file', `The image is too large; at most ${MAX_IMAGE_PIXELS / 1_000_000} megapixels are allowed.`);
      try {
        const m = await decodeImage(file.buffer).metadata();
        width = m.width ?? null;
        height = m.height ?? null;
      } catch (e) {
        if (/pixel limit/i.test(String((e as Error)?.message))) throw tooLarge();
        throw bad('file', 'The image could not be read. It may be damaged.');
      }
      if (width && height && width * height > MAX_IMAGE_PIXELS) throw tooLarge();
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const now = new Date();
    const key = `${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}${sniffed.ext}`;
    await this.storage.put(key, file.buffer, sniffed.mime);

    let row: FileRow;
    try {
      row = await this.db.tenantTx(tenantId, async tx => {
        const r = await sql<{ allowed: boolean; used_bytes: string; limit_bytes: string | null; crossed: string | null }>`
          select * from app.consume_storage(${size}::bigint)`.execute(tx);
        const meter = r.rows[0]!;
        if (!meter.allowed) {
          const limitGb = meter.limit_bytes === null ? 0 : Number(meter.limit_bytes) / GB;
          throw AppError.limitExceeded('storage_gb', limitGb, Math.round((Number(meter.used_bytes) / GB) * 100) / 100, 'GB of storage');
        }
        const inserted = await tx.insertInto('app.file_object').values({
          storage_key: key, filename, mime: sniffed.mime, size_bytes: size, sha256, width, height, created_by: userId,
        }).returning([...FILE_COLS]).executeTakeFirstOrThrow();
        if (meter.crossed) await this.notifyStorage(tx, meter.crossed, meter.limit_bytes);
        await this.audit.tenant(tx, {
          action: 'upload', entity: 'file', entityId: inserted.id, after: { filename, mime: sniffed.mime, sizeBytes: size, sha256 },
        });
        return inserted as FileRow;
      });
    } catch (e) {
      await this.storage.delete(key).catch(() => undefined);
      throw e;
    }

    const result = await this.scanner.scan(file.buffer).catch(e => ({ status: 'error' as const, message: String(e) }));
    if (result.status !== 'clean') this.log.warn(`file ${row.id} scan: ${JSON.stringify(result)}`);
    row = await this.db.tenantTx(tenantId, tx => tx.updateTable('app.file_object').set({ scan_status: result.status })
      .where('id', '=', row.id).where('tenant_id', '=', tenantId).returning([...FILE_COLS]).executeTakeFirstOrThrow()) as FileRow;
    return this.toMeta(tenantId, row);
  }

  private async notifyStorage(tx: Tx, crossed: string, limitBytes: string | null) {
    const admins = await tx.selectFrom('app.tenant_user').select('id')
      .where('tenant_id', '=', sql<string>`app.current_tenant_id()`)
      .where('is_tenant_admin', '=', true).where('is_active', '=', true).where('is_deleted', '=', false).execute();
    if (!admins.length) return;
    const gb = limitBytes === null ? null : Number(limitBytes) / GB;
    const title = crossed === '100' ? `You have used all ${gb} GB of file storage in your plan` : `You have used 80% of your ${gb} GB file storage`;
    await tx.insertInto('app.notification').values(admins.map(a => ({
      user_id: a.id, kind: 'limit_warning', title, body: 'Remove unused files or ask for a plan upgrade.', link: '/usage',
      data: JSON.stringify({ limitKey: 'storage_gb', threshold: Number(crossed) }),
    }))).execute();
  }

  /**
   * Field rules for `POST /files?formKey=&fieldKey=`, read from the form's current published version.
   * Grid columns may be addressed as `<grid>.<column>` or by the column key.
   */
  async fieldRules(tenantId: string, formKey: string, fieldKey: string): Promise<FileFieldRules> {
    const def = await this.db.tenantTx(tenantId, tx => tx.selectFrom('app.form_def as f')
      .innerJoin('app.form_version as v', 'v.id', 'f.current_version_id')
      .select('v.definition').where('f.tenant_id', '=', tenantId).where('f.key', '=', formKey).executeTakeFirst());
    if (!def) throw bad('formKey', `Unknown form "${formKey}".`);
    type F = { key: string; type: string; label?: string; accept?: string[]; maxSizeMb?: number; columns?: F[]; removed?: boolean };
    const fields = ((def.definition as { fields?: F[] }).fields ?? []);
    const [a, b] = fieldKey.split('.');
    let field: F | undefined;
    if (b) field = fields.find(f => f.key === a && f.type === 'grid')?.columns?.find(c => c.key === b);
    else field = fields.find(f => f.key === a) ?? fields.flatMap(f => f.columns ?? []).find(c => c.key === a);
    if (!field || field.removed || !['file', 'image', 'files', 'signature'].includes(field.type)) {
      throw bad('fieldKey', `"${fieldKey}" is not a file field of ${formKey}.`);
    }
    const defaultAccept = field.type === 'image' ? ['image/png', 'image/jpeg', 'image/webp'] : field.type === 'signature' ? ['image/png'] : [];
    return { label: field.label ?? fieldKey, accept: field.accept ?? defaultAccept, maxSizeMb: field.maxSizeMb ?? 10 };
  }

  // ------------------------------------------------------------------ read
  async get(tenantId: string, id: string): Promise<FileMeta> {
    const row = await this.db.tenantTx(tenantId, tx => this.loadOne(tx, tenantId, id));
    if (!row) throw AppError.notFound('File');
    return this.toMeta(tenantId, row);
  }

  async loadOne(tx: Tx, tenantId: string, id: string): Promise<FileRow | undefined> {
    return (await this.loadMany(tx, tenantId, [id]))[0];
  }

  /** Non-deleted files of this tenant among `ids` (explicit tenant filter: safe under the platform role too). */
  async loadMany(tx: Tx, tenantId: string, ids: string[]): Promise<FileRow[]> {
    const uniq = [...new Set(ids)].filter(isUuid);
    if (!uniq.length) return [];
    return (await tx.selectFrom('app.file_object').select([...FILE_COLS])
      .where('tenant_id', '=', tenantId).where('id', 'in', uniq).where('is_deleted', '=', false).execute()) as FileRow[];
  }

  /** id -> FileMeta (fresh signed URLs) in one query. */
  async metaMap(tx: Tx, tenantId: string, ids: string[]): Promise<Map<string, FileMeta>> {
    const rows = await this.loadMany(tx, tenantId, ids);
    const out = new Map<string, FileMeta>();
    for (const r of rows) out.set(r.id, await this.toMeta(tenantId, r));
    return out;
  }

  async toMeta(tenantId: string, r: FileRow): Promise<FileMeta> {
    const clean = r.scan_status === 'clean';
    const isImage = IMAGE_MIMES.has(r.mime);
    let url: string | null = null;
    let thumbUrl: string | null = null;
    if (clean) {
      const presigned = await this.storage.presign(r.storage_key, { filename: r.filename, mime: r.mime, ttlSec: config.files.urlTtlSec, inline: isImage });
      url = presigned ?? this.signedUrl(tenantId, r.id);
      thumbUrl = isImage ? presigned ?? this.signedUrl(tenantId, r.id, THUMB_WIDTH) : null;
    }
    return {
      id: r.id, filename: r.filename, mime: r.mime, sizeBytes: Number(r.size_bytes), width: r.width, height: r.height,
      scanStatus: r.scan_status, url, thumbUrl,
    };
  }

  // ------------------------------------------------------------------ attach (record saves)
  /**
   * Points `ids` at the owner record (field = where it is used) and orphans files the record no longer references.
   * Caller has already validated ownership and status.
   */
  async syncAttachments(tx: Tx, tenantId: string, owner: AttachTarget, byField: Map<string, string[]>) {
    const keep: string[] = [];
    for (const [field, ids] of byField) {
      const list = [...new Set(ids)].filter(isUuid);
      if (!list.length) continue;
      keep.push(...list);
      await tx.updateTable('app.file_object')
        .set({ attached_to: JSON.stringify({ kind: owner.kind, id: owner.id, field }) })
        .where('tenant_id', '=', tenantId).where('id', 'in', list).execute();
    }
    let q = tx.updateTable('app.file_object').set({ attached_to: null })
      .where('tenant_id', '=', tenantId)
      .where(sql<boolean>`attached_to->>'kind' = ${owner.kind} and attached_to->>'id' = ${owner.id}`);
    if (keep.length) q = q.where('id', 'not in', keep);
    await q.execute();
  }

  // ------------------------------------------------------------------ signed URLs + content
  sign(id: string, exp: number, w: number | null): string {
    return createHmac('sha256', config.files.urlSecret).update(`${id}|${exp}|${w ?? ''}`).digest('base64url');
  }

  /**
   * `/files/:id/content?t=<tenant>&exp=<unix s>&sig=<hmac(id|exp|w)>[&w=]`. The tenant id routes the lookup under RLS;
   * it is not secret, and a wrong one simply finds nothing.
   */
  signedUrl(tenantId: string, id: string, w: number | null = null, ttlSec: number = config.files.urlTtlSec): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const params = new URLSearchParams({ t: tenantId, exp: String(exp) });
    if (w) params.set('w', String(w));
    params.set('sig', this.sign(id, exp, w));
    return `${config.files.urlBase}/api/v1/files/${id}/content?${params.toString()}`;
  }

  verify(id: string, exp: string | undefined, sig: string | undefined, w: number | null): boolean {
    if (!exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
    if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
    const want = Buffer.from(this.sign(id, Number(exp), w));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** Bytes for a verified signed URL. Only clean files are ever served. */
  async content(q: { id: string; t?: string; exp?: string; sig?: string; w?: string }) {
    const w = q.w === undefined || q.w === '' ? null : Number(q.w);
    if (w !== null && (!Number.isInteger(w) || w < 16 || w > 2048)) throw AppError.forbidden('This link is invalid or has expired.');
    if (!isUuid(q.id) || !q.t || !isUuid(q.t) || !this.verify(q.id, q.exp, q.sig, w)) {
      throw AppError.forbidden('This link is invalid or has expired.');
    }
    const tenantId = q.t;
    const row = await this.db.tenantTx(tenantId, tx => this.loadOne(tx, tenantId, q.id));
    if (!row || row.scan_status !== 'clean') throw notAvailable();
    const isImage = IMAGE_MIMES.has(row.mime);
    // SEC8-016: an image stored before the 50 MP limit cannot be thumbnailed any more; serve the original instead of a 500.
    const thumb = w && isImage ? await this.thumbnail(row, w).catch((e: Error) => (/pixel limit/i.test(String(e?.message)) ? null : Promise.reject(e))) : null;
    if (thumb) return { body: thumb, mime: 'image/webp', filename: row.filename.replace(/\.[^.]+$/, '') + '.webp', inline: true };
    return { body: await this.storage.get(row.storage_key), mime: row.mime, filename: row.filename, inline: isImage };
  }

  private async thumbnail(row: FileRow, w: number): Promise<Buffer> {
    const cacheKey = `${row.storage_key}.w${w}.webp`;
    const path = this.storage instanceof LocalStorageDriver ? this.storage.cachePath(cacheKey) : null;
    if (path) {
      const hit = await readFile(path).catch(() => null);
      if (hit) return hit;
    }
    const src = await this.storage.get(row.storage_key);
    const out = await decodeImage(src, { animated: false }).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    if (path) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, out);
    }
    return out;
  }

  // ------------------------------------------------------------------ cleanup
  /**
   * Deletes files never attached to a record (or detached since) and older than `olderThanHours`, frees their bytes
   * and credits the storage meter. Files still referenced without `attached_to` (vendor quote attachments, outbound
   * message attachments, the company logo — see `app.file_ids_referenced`) are kept. Runs per tenant (RLS);
   * FilesCleanupJob runs it nightly for every tenant with candidates.
   */
  async cleanupOrphans(tenantId: string, olderThanHours = 24): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 3600_000);
    const rows = await this.db.tenantTx(tenantId, async tx => {
      const cands = await tx.selectFrom('app.file_object').select(['id', 'storage_key', 'size_bytes'])
        .where('tenant_id', '=', tenantId).where('attached_to', 'is', null).where('is_deleted', '=', false)
        .where('created_at', '<', cutoff).orderBy('created_at').limit(1000).execute();
      if (!cands.length) return cands;
      const ids = cands.map(c => c.id);
      const kept = new Set((await sql<{ file_id: string }>`select file_id from app.file_ids_referenced(${ids}::uuid[])`.execute(tx)).rows.map(r => r.file_id));
      return cands.filter(c => !kept.has(c.id));
    });
    let n = 0;
    for (const r of rows) {
      const done = await this.db.tenantTx(tenantId, async tx => {
        const res = await tx.updateTable('app.file_object').set({ is_deleted: true })
          .where('id', '=', r.id).where('tenant_id', '=', tenantId).where('attached_to', 'is', null).where('is_deleted', '=', false)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) === 0) return false;
        await sql`select * from app.consume_storage(${-Number(r.size_bytes)}::bigint)`.execute(tx);
        return true;
      });
      if (!done) continue;
      await this.storage.delete(r.storage_key).catch(e => this.log.warn(`could not delete ${r.storage_key}: ${String(e)}`));
      n++;
    }
    return n;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
