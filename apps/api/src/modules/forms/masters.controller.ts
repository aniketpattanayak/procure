import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ImportReport, MasterCreate, MasterSummary, MasterUpdate, MyPermissions, OptionRow, OptionsQuery, Page, perm, RecordDeleteBlocked,
  RecordListQuery, RecordRow, RecordUpdate, RecordWrite,
} from '@procure/schema';
import type { Response } from 'express';
import { z } from 'zod';
import { RequiresFeature, TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, hasPermission, Requires } from '../../core/auth/permissions';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { Zod } from '../../core/zod';
// Same INCR permver:<tenant> as PermissionCache.bump; imported from core because modules/permissions imports
// identity, which imports this module (a file-level cycle Nest cannot resolve).
import { EntitlementsService } from '../../core/entitlements.service';
import { actorOf } from './forms.controller';
import { Actor } from './forms.service';
import { MasterRow, MastersService } from './masters.service';
import { IMPORT_MAX_BYTES, RecordIoService } from './record-io.service';
import { RecordsService } from './records.service';

const MASTER_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ListQuery = RecordListQuery.extend({ view: z.enum(['active', 'inactive', 'all']).optional() });
const DeleteBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) });
const ImportQuery = z.object({
  dryRun: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  mode: z.enum(['create', 'upsert']).default('create'),
});
const ExportQuery = z.object({ format: z.enum(['csv', 'xlsx']).default('xlsx'), view: z.enum(['active', 'inactive', 'all']).optional() });

const masterKeyOf = (k: string) => {
  if (!MASTER_KEY.test(k)) throw AppError.notFound('Master');
  return k;
};
const recordIdOf = (id: string) => {
  if (!UUID.test(id)) throw AppError.notFound('Record');
  return id;
};

/** Runtime key check: `master.<key>:action.<name>` (keys come from the URL). */
function need(a: Actor, master: string, action: string) {
  if (!hasPermission(a.perms ?? undefined, perm.action(perm.masterTab(master), action))) throw AppError.forbidden();
}

/** Resolves the `view` param: default = first permitted view; a view the user lacks is 403. */
function resolveView(a: Actor, master: string, view: 'active' | 'inactive' | 'all' | undefined): 'active' | 'inactive' | 'all' {
  const tab = perm.masterTab(master);
  const canActive = hasPermission(a.perms ?? undefined, perm.view(tab, 'active'));
  const canInactive = hasPermission(a.perms ?? undefined, perm.view(tab, 'inactive'));
  const v = view ?? (canActive ? 'active' : canInactive ? 'inactive' : null);
  if (!v) throw AppError.forbidden('You cannot see any records in this list.');
  if ((v === 'active' && !canActive) || (v === 'inactive' && !canInactive) || (v === 'all' && !(canActive && canInactive))) {
    throw AppError.forbidden('You do not have access to this view.');
  }
  return v;
}

@TenantOnly()
@Controller('config/masters')
export class ConfigMastersController {
  constructor(private readonly db: DbService, private readonly masters: MastersService, private readonly ent: EntitlementsService) {}

  @Post()
  @RequiresFeature('form_builder')
  @Requires('config.masters:action.add')
  async create(@Body(new Zod(MasterCreate)) body: z.infer<typeof MasterCreate>, @CurrentPermissions() perms?: MyPermissions): Promise<MasterSummary> {
    const a = actorOf(perms);
    const out = await this.db.tenantTx(a.tenantId, tx => this.masters.create(tx, a, body));
    await this.ent.bumpPermissions(a.tenantId); // new registry keys
    return out;
  }

  @Put(':key')
  @RequiresFeature('form_builder')
  @Requires('config.masters:action.edit')
  async update(@Param('key') key: string, @Body(new Zod(MasterUpdate)) body: z.infer<typeof MasterUpdate>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actorOf(perms);
    const out = await this.db.tenantTx(a.tenantId, tx => this.masters.update(tx, a, masterKeyOf(key), body));
    await this.ent.bumpPermissions(a.tenantId); // registry labels
    return out;
  }

  @Post(':key/deactivate')
  @HttpCode(200)
  @RequiresFeature('form_builder')
  @Requires('config.masters:action.edit')
  deactivate(@Param('key') key: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.masters.setActive(tx, a, masterKeyOf(key), false));
  }

  @Post(':key/activate')
  @HttpCode(200)
  @RequiresFeature('form_builder')
  @Requires('config.masters:action.edit')
  activate(@Param('key') key: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.masters.setActive(tx, a, masterKeyOf(key), true));
  }
}

@TenantOnly()
@Controller('masters')
export class MastersController {
  constructor(
    private readonly db: DbService,
    private readonly masters: MastersService,
    private readonly records: RecordsService,
    private readonly io: RecordIoService,
  ) {}

  private run<T>(perms: MyPermissions | undefined, key: string, fn: (tx: Tx, a: Actor, m: MasterRow) => Promise<T>): Promise<T> {
    const a = actorOf(perms);
    const k = masterKeyOf(key);
    return this.db.tenantTx(a.tenantId, async tx => fn(tx, a, await this.masters.load(tx, a.tenantId, k)));
  }

  /** Masters the caller may view (all of them for master designers). */
  @Get()
  list(@CurrentPermissions() perms?: MyPermissions): Promise<MasterSummary[]> {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.masters.list(tx, a));
  }

  @Get(':key/records')
  listRecords(@Param('key') key: string, @Query() raw: Record<string, unknown>, @CurrentPermissions() perms?: MyPermissions): Promise<Page<RecordRow>> {
    const q = ListQuery.parse(raw);
    const filters: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('f.')) continue;
      const field = k.slice(2);
      if (!/^[a-z][a-z0-9_]*$/.test(field) || typeof v !== 'string') throw new AppError(400, 'VALIDATION_FAILED', `Invalid filter "${k}".`);
      filters[field] = v;
    }
    return this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'view');
      const view = resolveView(a, m.key, q.view);
      return this.records.list(tx, a, m, { cursor: q.cursor, limit: q.limit, q: q.q, sort: q.sort, view, filters });
    });
  }

  @Post(':key/records')
  createRecord(@Param('key') key: string, @Body(new Zod(RecordWrite)) body: z.infer<typeof RecordWrite>, @CurrentPermissions() perms?: MyPermissions): Promise<RecordRow> {
    return this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'add');
      return this.records.create(tx, a, m, body);
    });
  }

  @Get(':key/records/:id')
  getRecord(@Param('key') key: string, @Param('id') id: string, @CurrentPermissions() perms?: MyPermissions): Promise<RecordRow> {
    return this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'view');
      return this.records.get(tx, a, m, recordIdOf(id));
    });
  }

  @Put(':key/records/:id')
  updateRecord(@Param('key') key: string, @Param('id') id: string, @Body(new Zod(RecordUpdate)) body: z.infer<typeof RecordUpdate>, @CurrentPermissions() perms?: MyPermissions) {
    return this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'edit');
      return this.records.update(tx, a, m, recordIdOf(id), body);
    });
  }

  @Post(':key/records/:id/deactivate')
  @HttpCode(200)
  deactivateRecord(@Param('key') key: string, @Param('id') id: string, @CurrentPermissions() perms?: MyPermissions) {
    return this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'deactivate');
      return this.records.setActive(tx, a, m, recordIdOf(id), false);
    });
  }

  @Post(':key/records/:id/activate')
  @HttpCode(200)
  activateRecord(@Param('key') key: string, @Param('id') id: string, @CurrentPermissions() perms?: MyPermissions) {
    return this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'deactivate');
      return this.records.setActive(tx, a, m, recordIdOf(id), true);
    });
  }

  @Delete(':key/records/:id')
  @HttpCode(204)
  async deleteRecord(@Param('key') key: string, @Param('id') id: string, @Body(new Zod(DeleteBody)) body: z.infer<typeof DeleteBody>, @CurrentPermissions() perms?: MyPermissions): Promise<void> {
    await this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'delete');
      return this.records.remove(tx, a, m, recordIdOf(id), body.reason);
    });
  }

  @Get(':key/records/:id/usage')
  usage(@Param('key') key: string, @Param('id') id: string, @CurrentPermissions() perms?: MyPermissions): Promise<RecordDeleteBlocked['usedBy']> {
    return this.run(perms, key, async (tx, a, m) => {
      need(a, m.key, 'view');
      await this.records.loadRow(tx, a.tenantId, m, recordIdOf(id));
      return this.records.usage(tx, a.tenantId, id);
    });
  }

  /** Dropdown feed. Any tenant user (lookups on other tabs need it); hidden fields never appear in `attrs`. */
  @Get(':key/options')
  options(@Param('key') key: string, @Query(new Zod(OptionsQuery)) q: z.infer<typeof OptionsQuery>, @CurrentPermissions() perms?: MyPermissions): Promise<OptionRow[]> {
    return this.run(perms, key, (tx, a, m) => this.records.options(tx, a, m, q));
  }

  @Get(':key/template.xlsx')
  async template(@Param('key') key: string, @Res() res: Response, @CurrentPermissions() perms?: MyPermissions): Promise<void> {
    const body = await this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'import');
      return this.io.template(tx, a, m);
    });
    send(res, body, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `${key}-template.xlsx`);
  }

  @Post(':key/import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } }))
  async import(
    @Param('key') key: string, @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Query(new Zod(ImportQuery)) q: z.infer<typeof ImportQuery>, @CurrentPermissions() perms?: MyPermissions,
  ): Promise<ImportReport> {
    const a = actorOf(perms);
    const master = await this.db.tenantTx(a.tenantId, tx => this.masters.load(tx, a.tenantId, masterKeyOf(key)));
    need(a, master.key, 'import');
    if (!file) throw new AppError(400, 'VALIDATION_FAILED', 'Choose a .csv or .xlsx file to import.', undefined, [{ path: 'file', message: 'Required' }]);
    return this.io.import(a, master, file, q);
  }

  @Get(':key/export')
  async export(@Param('key') key: string, @Query(new Zod(ExportQuery)) q: z.infer<typeof ExportQuery>, @Res() res: Response, @CurrentPermissions() perms?: MyPermissions): Promise<void> {
    const f = await this.run(perms, key, (tx, a, m) => {
      need(a, m.key, 'export');
      return this.io.export(tx, a, m, q.format, resolveView(a, m.key, q.view));
    });
    send(res, f.body, f.mime, f.filename);
  }
}

function send(res: Response, body: Buffer, mime: string, filename: string) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end(body);
}
