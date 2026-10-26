import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  AttachmentInput, AttachmentRow, CancelInput, CloseInput, CommentInput, CommentRow, DocListQuery, DocTypeCreate, DocTypeSummary, DocTypeUpdate,
  DocumentRow, DocumentUpdate, DocumentWrite, MyPermissions, NumberingSeriesInput, NumberingSeriesRow, SavedViewInput, SavedViewRow, TimelineEntry,
} from '@procure/schema';
import { z } from 'zod';
import { RequiresFeature, TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../core/auth/permissions';
import { DbService } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { Zod } from '../../core/zod';
import { UuidParam } from '../identity';
import { CollaborationService } from './collaboration.service';
import { DocTypesService } from './doc-types.service';
import { DocumentsService } from './documents.service';
import { DocListService, ListInput } from './list.service';
import { NumberingService } from './numbering.service';
import { SavedViewsService } from './saved-views.service';
import type { DocActor } from './types';

const NO_PERMS: MyPermissions = { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };
export function docActor(perms: MyPermissions | undefined): DocActor {
  const p = tenantPrincipal();
  return { tenantId: p.tenantId, userId: p.userId, perms: perms ?? NO_PERMS };
}

const TYPE_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const typeKeyOf = (k: string) => {
  if (!TYPE_KEY.test(k)) throw AppError.notFound('Document type');
  return k;
};

// ------------------------------------------------------------------ document types
@TenantOnly()
@Controller()
export class DocTypesController {
  constructor(private readonly db: DbService, private readonly types: DocTypesService, private readonly ent: EntitlementsService) {}

  @Get('doc-types')
  list(@CurrentPermissions() perms?: MyPermissions): Promise<DocTypeSummary[]> {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.types.list(tx, a));
  }

  @Post('config/doc-types')
  @RequiresFeature('form_builder')
  @Requires('config.doc_types:action.add')
  async create(@Body(new Zod(DocTypeCreate)) body: z.infer<typeof DocTypeCreate>, @CurrentPermissions() perms?: MyPermissions): Promise<DocTypeSummary> {
    const a = docActor(perms);
    const out = await this.db.tenantTx(a.tenantId, tx => this.types.create(tx, a, body));
    await this.ent.bumpPermissions(a.tenantId);
    return out;
  }

  @Put('config/doc-types/:key')
  @RequiresFeature('form_builder')
  @Requires('config.doc_types:action.edit')
  async update(@Param('key') key: string, @Body(new Zod(DocTypeUpdate)) body: z.infer<typeof DocTypeUpdate>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    const out = await this.db.tenantTx(a.tenantId, tx => this.types.update(tx, a, typeKeyOf(key), body));
    await this.ent.bumpPermissions(a.tenantId);
    return out;
  }

  @Post('config/doc-types/:key/deactivate')
  @HttpCode(200)
  @Requires('config.doc_types:action.edit')
  deactivate(@Param('key') key: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.types.setActive(tx, a, typeKeyOf(key), false));
  }

  @Post('config/doc-types/:key/activate')
  @HttpCode(200)
  @Requires('config.doc_types:action.edit')
  activate(@Param('key') key: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.types.setActive(tx, a, typeKeyOf(key), true));
  }
}

// ------------------------------------------------------------------ numbering
const NumberingUpdate = NumberingSeriesInput.extend({ version: z.number().int() });
const PreviewQuery = z.object({ locationId: z.string().uuid().optional(), date: z.string().date().optional() });

@TenantOnly()
@Controller('config/numbering')
export class NumberingController {
  constructor(private readonly db: DbService, private readonly numbering: NumberingService) {}

  @Get()
  @Requires('config.numbering:action.view')
  list(@Query('docType') docType?: string): Promise<NumberingSeriesRow[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.numbering.list(tx, p.tenantId, typeof docType === 'string' && docType ? docType : undefined));
  }

  @Post()
  @Requires('config.numbering:action.edit')
  create(@Body(new Zod(NumberingSeriesInput)) body: z.infer<typeof NumberingSeriesInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.numbering.create(tx, a, body));
  }

  @Put(':id')
  @Requires('config.numbering:action.edit')
  update(@Param('id', new UuidParam('Numbering series')) id: string, @Body(new Zod(NumberingUpdate)) body: z.infer<typeof NumberingUpdate>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.numbering.update(tx, a, id, body));
  }

  @Get(':id/preview')
  @Requires('config.numbering:action.view')
  preview(@Param('id', new UuidParam('Numbering series')) id: string, @Query(new Zod(PreviewQuery)) q: z.infer<typeof PreviewQuery>) {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.numbering.preview(tx, p.tenantId, id, q));
  }
}

// ------------------------------------------------------------------ documents
function listInput(raw: Record<string, unknown>): ListInput {
  const fields: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  let extraColumns: string[] | undefined;
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k === 'columns') {
      const list = (Array.isArray(v) ? v : [v]).flatMap(x => String(x).split(',')).map(x => x.trim()).filter(Boolean);
      if (list.length > 40 || list.some(x => !/^[a-z][a-z0-9_]{0,62}$/.test(x))) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Invalid columns.', undefined, [{ path: 'columns', message: 'Use columns=<key>[,<key>…] (at most 40 field keys).' }]);
      }
      extraColumns = [...new Set(list)];
    } else if (k.startsWith('f.')) {
      if (!/^f\.[a-z][a-z0-9_]{0,62}$/.test(k) || typeof v !== 'string') throw new AppError(400, 'VALIDATION_FAILED', `Invalid filter "${k}".`, undefined, [{ path: k, message: 'Use f.<field>=<value> once per field.' }]);
      fields[k.slice(2)] = v;
    } else rest[k] = v;
  }
  return { ...DocListQuery.parse(rest), fields, ...(extraColumns ? { extraColumns } : {}) };
}

@TenantOnly()
@Controller('docs/:type')
export class DocumentsController {
  constructor(
    private readonly db: DbService, private readonly docs: DocumentsService, private readonly lists: DocListService, private readonly collab: CollaborationService,
  ) {}

  @Get()
  list(@Param('type') type: string, @Query() q: Record<string, unknown>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    const input = listInput(q);
    return this.db.tenantTx(a.tenantId, async tx => this.lists.list(tx, a, await this.docs.typeFor(tx, a, typeKeyOf(type)), input));
  }

  @Get('counts')
  counts(@Param('type') type: string, @Query() q: Record<string, unknown>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    const input = listInput(q);
    return this.db.tenantTx(a.tenantId, async tx => this.lists.counts(tx, a, await this.docs.typeFor(tx, a, typeKeyOf(type)), input));
  }

  @Post()
  create(@Param('type') type: string, @Body(new Zod(DocumentWrite)) body: z.infer<typeof DocumentWrite>, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.docs.create(tx, a, typeKeyOf(type), body));
  }

  @Get(':id')
  get(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.docs.detail(tx, a, typeKeyOf(type), id));
  }

  @Put(':id')
  update(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(DocumentUpdate)) body: z.infer<typeof DocumentUpdate>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.docs.update(tx, a, typeKeyOf(type), id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<void> {
    const a = docActor(perms);
    await this.db.tenantTx(a.tenantId, tx => this.docs.remove(tx, a, typeKeyOf(type), id));
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(z.object({ version: z.number().int() }))) body: { version: number }, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.docs.submit(tx, a, typeKeyOf(type), id, body.version));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(CancelInput)) body: z.infer<typeof CancelInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.docs.cancel(tx, a, typeKeyOf(type), id, body));
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(CloseInput)) body: z.infer<typeof CloseInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.docs.close(tx, a, typeKeyOf(type), id, body));
  }

  @Post(':id/copy')
  copy(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<DocumentRow> {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.docs.copy(tx, a, typeKeyOf(type), id));
  }

  @Get(':id/timeline')
  timeline(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<TimelineEntry[]> {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.collab.timeline(tx, a, typeKeyOf(type), id));
  }

  @Get(':id/comments')
  comments(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<CommentRow[]> {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.collab.listComments(tx, a, typeKeyOf(type), id));
  }

  @Post(':id/comments')
  addComment(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(CommentInput)) body: z.infer<typeof CommentInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.collab.addComment(tx, a, typeKeyOf(type), id, body));
  }

  @Put(':id/comments/:commentId')
  editComment(
    @Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Param('commentId', new UuidParam('Comment')) commentId: string,
    @Body(new Zod(CommentInput)) body: z.infer<typeof CommentInput>, @CurrentPermissions() perms?: MyPermissions,
  ) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.collab.editComment(tx, a, typeKeyOf(type), id, commentId, body));
  }

  @Delete(':id/comments/:commentId')
  @HttpCode(204)
  async deleteComment(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Param('commentId', new UuidParam('Comment')) commentId: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    await this.db.tenantTx(a.tenantId, tx => this.collab.deleteComment(tx, a, typeKeyOf(type), id, commentId));
  }

  @Get(':id/attachments')
  attachments(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<AttachmentRow[]> {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.collab.listAttachments(tx, a, typeKeyOf(type), id));
  }

  @Post(':id/attachments')
  attach(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(AttachmentInput)) body: z.infer<typeof AttachmentInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.collab.addAttachment(tx, a, typeKeyOf(type), id, body));
  }

  @Delete(':id/attachments/:attId')
  @HttpCode(204)
  async detach(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Param('attId', new UuidParam('Attachment')) attId: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    await this.db.tenantTx(a.tenantId, tx => this.collab.removeAttachment(tx, a, typeKeyOf(type), id, attId));
  }
}

// ------------------------------------------------------------------ saved views
const SavedViewUpdate = SavedViewInput.extend({ version: z.number().int() });

@TenantOnly()
@Controller('saved-views')
export class SavedViewsController {
  constructor(private readonly db: DbService, private readonly views: SavedViewsService) {}

  @Get()
  list(@Query('scope') scope: string | undefined, @CurrentPermissions() perms?: MyPermissions): Promise<SavedViewRow[]> {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.views.list(tx, a, typeof scope === 'string' && scope ? scope : undefined));
  }

  @Post()
  create(@Body(new Zod(SavedViewInput)) body: z.infer<typeof SavedViewInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.views.create(tx, a, body));
  }

  @Put(':id')
  update(@Param('id', new UuidParam('Saved view')) id: string, @Body(new Zod(SavedViewUpdate)) body: z.infer<typeof SavedViewUpdate>, @CurrentPermissions() perms?: MyPermissions) {
    const a = docActor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.views.update(tx, a, id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new UuidParam('Saved view')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<void> {
    const a = docActor(perms);
    await this.db.tenantTx(a.tenantId, tx => this.views.remove(tx, a, id));
  }
}
