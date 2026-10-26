import { Body, Controller, Get, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { FileMeta } from '@procure/schema';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, TenantOnly } from '../../core/auth/decorators';
import { config } from '../../core/config';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { Zod } from '../../core/zod';
import { FilesService, isUuid, UploadedBlob } from './files.service';

const UploadBody = z.object({
  formKey: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/).optional(),
  fieldKey: z.string().regex(/^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62})?$/).optional(),
}).refine(v => !v.fieldKey || !!v.formKey, { path: ['formKey'], message: 'formKey is required with fieldKey' });

/** RFC 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Any tenant user may upload; files stay orphans until a record save attaches them. */
  @TenantOnly()
  @Post()
  @UseInterceptors(FileInterceptor('file', { /* multer default = memory storage */ limits: { fileSize: config.files.maxUploadBytes, files: 1 } }))
  async upload(@UploadedFile() file: UploadedBlob | undefined, @Body(new Zod(UploadBody)) body: z.infer<typeof UploadBody>): Promise<FileMeta> {
    const p = tenantPrincipal();
    const rules = body.formKey && body.fieldKey ? await this.files.fieldRules(p.tenantId, body.formKey, body.fieldKey) : null;
    if (!file) throw new AppError(400, 'VALIDATION_FAILED', 'Choose a file to upload.', undefined, [{ path: 'file', message: 'Required' }]);
    return this.files.upload(p.tenantId, p.userId, file, rules);
  }

  /** Phase 2: any user of the same tenant (RLS) may read metadata; the URL is freshly signed. */
  @TenantOnly()
  @Get(':id')
  get(@Param('id') id: string): Promise<FileMeta> {
    if (!isUuid(id)) throw AppError.notFound('File');
    return this.files.get(tenantPrincipal().tenantId, id);
  }

  /** Public: authorised by the HMAC signature in the URL (ADR-0008). */
  @Public()
  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Query() q: { t?: string; exp?: string; sig?: string; w?: string },
    @Res() res: Response,
  ): Promise<void> {
    const f = await this.files.content({ id, t: str(q.t), exp: str(q.exp), sig: str(q.sig), w: str(q.w) });
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Length', String(f.body.length));
    res.setHeader('Content-Disposition', contentDisposition(f.inline ? 'inline' : 'attachment', f.filename));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The web app lives on another origin; helmet's default CORP (same-origin) would block <img> tags.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200).end(f.body);
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
