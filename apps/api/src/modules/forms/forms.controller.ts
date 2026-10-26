import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import {
  FormDefinition, FormDetail, FormDraftSave, FormPublish, FormSummary, FormVersionRow, MyPermissions, perm, RenderableForm,
} from '@procure/schema';
import { z } from 'zod';
import { RequiresFeature, TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, hasPermission, Requires } from '../../core/auth/permissions';
import { DbService } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { Zod } from '../../core/zod';
// Same INCR permver:<tenant> as PermissionCache.bump; imported from core because modules/permissions imports
// identity, which imports this module (a file-level cycle Nest cannot resolve).
import { EntitlementsService } from '../../core/entitlements.service';
import { Actor, FormsService } from './forms.service';

const FORM_KEY = /^[a-z][a-z0-9_]{1,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const formKeyOf = (k: string) => {
  if (!FORM_KEY.test(k)) throw AppError.notFound('Form');
  return k;
};

const NO_PERMS: MyPermissions = { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };
export function actorOf(perms: MyPermissions | undefined): Actor {
  const p = tenantPrincipal();
  return { tenantId: p.tenantId, userId: p.userId, perms: perms ?? NO_PERMS };
}

const ValidateBody = z.object({ definition: FormDefinition, formKey: z.string().optional() });

@TenantOnly()
@Controller('config/forms')
export class ConfigFormsController {
  constructor(private readonly db: DbService, private readonly forms: FormsService, private readonly ent: EntitlementsService) {}

  @Get()
  @Requires('config.forms:action.view')
  list(): Promise<FormSummary[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.forms.list(tx, p.tenantId));
  }

  @Post('validate')
  @HttpCode(200)
  @RequiresFeature('form_builder')
  @Requires('config.forms:action.edit')
  validate(@Body(new Zod(ValidateBody)) body: z.infer<typeof ValidateBody>) {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => ({ issues: await this.forms.validate(tx, p.tenantId, body.definition, body.formKey) }));
  }

  @Get(':formKey')
  @Requires('config.forms:action.view')
  detail(@Param('formKey') key: string): Promise<FormDetail> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.forms.detail(tx, p.tenantId, formKeyOf(key)));
  }

  @Put(':formKey/draft')
  @RequiresFeature('form_builder')
  @Requires('config.forms:action.edit')
  saveDraft(@Param('formKey') key: string, @Body(new Zod(FormDraftSave)) body: z.infer<typeof FormDraftSave>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.forms.saveDraft(tx, a, formKeyOf(key), body.definition, body.version));
  }

  @Delete(':formKey/draft')
  @RequiresFeature('form_builder')
  @Requires('config.forms:action.edit')
  discardDraft(@Param('formKey') key: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.forms.discardDraft(tx, a, formKeyOf(key)));
  }

  @Post(':formKey/publish')
  @HttpCode(200)
  @RequiresFeature('form_builder')
  @Requires('config.forms:action.publish')
  async publish(@Param('formKey') key: string, @Body(new Zod(FormPublish)) body: z.infer<typeof FormPublish>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actorOf(perms);
    const out = await this.db.tenantTx(a.tenantId, tx => this.forms.publish(tx, a, formKeyOf(key), body.version, body.changeNote));
    await this.ent.bumpPermissions(a.tenantId); // registry forms/fields changed
    return out;
  }

  @Get(':formKey/versions')
  @Requires('config.forms:action.view')
  versions(@Param('formKey') key: string): Promise<FormVersionRow[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.forms.versions(tx, p.tenantId, formKeyOf(key)));
  }

  @Get(':formKey/versions/:version')
  @Requires('config.forms:action.view')
  version(@Param('formKey') key: string, @Param('version', ParseIntPipe) version: number): Promise<FormDefinition> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.forms.versionDefinition(tx, p.tenantId, formKeyOf(key), version));
  }
}

@TenantOnly()
@Controller('forms')
export class FormsRenderController {
  constructor(private readonly db: DbService, private readonly forms: FormsService) {}

  /** Any user who can view a tab using this form: the master's tab, the users tab for the user form. */
  @Get(':formKey/render')
  render(@Param('formKey') key: string, @Query('versionId') versionId: string | undefined, @CurrentPermissions() perms?: MyPermissions): Promise<RenderableForm> {
    const a = actorOf(perms);
    formKeyOf(key);
    if (versionId !== undefined && !UUID.test(versionId)) throw AppError.notFound('Form version');
    return this.db.tenantTx(a.tenantId, async tx => {
      const form = await this.forms.load(tx, a.tenantId, key);
      const tab = form.kind === 'master' ? perm.masterTab(key) : key === 'user' ? 'admin.users' : null;
      if (tab && !['view', 'add', 'edit'].some(x => hasPermission(a.perms ?? undefined, perm.action(tab, x)))
        && !hasPermission(a.perms ?? undefined, 'config.forms:action.view')) {
        throw AppError.forbidden();
      }
      return this.forms.render(tx, a, key, versionId);
    });
  }
}

const UserOptionsQuery = z.object({ q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

/**
 * Lookup feed for `source.kind = 'user'` fields: any tenant user; active users only, id/name/email nothing else.
 * Registered before the identity module's `/users/:id` route (see AppModule import order).
 */
@TenantOnly()
@Controller('users')
export class UserOptionsController {
  constructor(private readonly db: DbService) {}

  @Get('options')
  options(@Query(new Zod(UserOptionsQuery)) q: z.infer<typeof UserOptionsQuery>): Promise<{ id: string; name: string; email: string }[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      let qb = tx.selectFrom('app.tenant_user').select(['id', 'name', 'email'])
        .where('tenant_id', '=', p.tenantId).where('is_active', '=', true).where('is_deleted', '=', false);
      if (q.q) {
        const pat = `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
        qb = qb.where(eb => eb.or([eb('name', 'ilike', pat), eb('email', 'ilike', pat)]));
      }
      return qb.orderBy('name').orderBy('id').limit(q.limit).execute();
    });
  }
}
