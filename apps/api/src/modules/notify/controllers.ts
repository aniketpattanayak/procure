import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  ManualSendInput, MyPermissions, OutboundMessageRow, Page, SendPreview, TriggerRuleInput, TriggerRuleRow, WebhookDeliveryRow, WebhookEndpointInput, WebhookEndpointRow,
} from '@procure/schema';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { Public, RequiresFeature, TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../core/auth/permissions';
import { DbService } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { Zod } from '../../core/zod';
import type { DocActor } from '../documents';
import { UuidParam } from '../identity';
import { HooksService } from './hooks.service';
import { MessageListQuery, MessagesService, PreviewInput, SendOptions, SendSuggestion } from './messages.service';
import { EventInfo, RulesService } from './rules.service';
import { WebhooksService } from './webhooks.service';

const NO_PERMS: MyPermissions = { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };
function actorOf(perms: MyPermissions | undefined): DocActor {
  const p = tenantPrincipal();
  return { tenantId: p.tenantId, userId: p.userId, perms: perms ?? NO_PERMS };
}
const TYPE_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const typeKeyOf = (k: string) => {
  if (!TYPE_KEY.test(k)) throw AppError.notFound('Document type');
  return k;
};
const RuleUpdate = TriggerRuleInput.and(z.object({ version: z.number().int() }));
const RuleQuery = z.object({ docTypeKey: z.string().max(60).optional(), eventType: z.string().max(80).optional() });
const WebhookUpdate = WebhookEndpointInput.and(z.object({ version: z.number().int() }));

// ------------------------------------------------------------------ trigger rules
@TenantOnly()
@Controller('config')
export class TriggersController {
  constructor(private readonly db: DbService, private readonly rules: RulesService) {}

  @Get('triggers')
  @Requires('config.triggers:action.view')
  list(@Query(new Zod(RuleQuery)) q: z.infer<typeof RuleQuery>): Promise<TriggerRuleRow[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.rules.list(tx, q));
  }

  @Get('triggers/events')
  @Requires('config.triggers:action.view')
  events(): Promise<EventInfo[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.rules.events(tx));
  }

  @Get('triggers/:id')
  @Requires('config.triggers:action.view')
  get(@Param('id', new UuidParam('Rule')) id: string): Promise<TriggerRuleRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.rules.get(tx, id));
  }

  @Post('triggers')
  @Requires('config.triggers:action.edit')
  create(@Body(new Zod(TriggerRuleInput)) body: z.infer<typeof TriggerRuleInput>): Promise<TriggerRuleRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.rules.create(tx, p.tenantId, p.userId, body));
  }

  @Put('triggers/:id')
  @Requires('config.triggers:action.edit')
  update(@Param('id', new UuidParam('Rule')) id: string, @Body(new Zod(RuleUpdate)) body: z.infer<typeof RuleUpdate>): Promise<TriggerRuleRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.rules.update(tx, p.tenantId, p.userId, id, body));
  }

  @Delete('triggers/:id')
  @HttpCode(204)
  @Requires('config.triggers:action.edit')
  async remove(@Param('id', new UuidParam('Rule')) id: string): Promise<void> {
    const p = tenantPrincipal();
    await this.db.tenantTx(p.tenantId, tx => this.rules.remove(tx, p.userId, id));
  }

  /** WhatsApp templates the Super Admin allowed for this company (for the template editor). */
  @Get('whatsapp-templates')
  @Requires('config.templates:action.view')
  async whatsappTemplates() {
    const p = tenantPrincipal();
    const rows = await this.db.tenantTx(p.tenantId, tx => sql<{ id: string; name: string; language: string; category: string; header_kind: string; body: string; variables: unknown }>`
      select id, name, language, category, header_kind, body, variables from app.my_whatsapp_templates() order by name, language`.execute(tx));
    return rows.rows.map(r => ({ id: r.id, name: r.name, language: r.language, category: r.category, headerKind: r.header_kind, body: r.body, variables: r.variables }));
  }
}

// ------------------------------------------------------------------ outgoing webhooks
@TenantOnly()
@RequiresFeature('api_access')
@Controller('config/webhooks')
export class WebhooksController {
  constructor(private readonly db: DbService, private readonly hooks: WebhooksService) {}

  @Get()
  @Requires('config.webhooks:action.view')
  list(): Promise<WebhookEndpointRow[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.hooks.list(tx));
  }

  @Get(':id')
  @Requires('config.webhooks:action.view')
  get(@Param('id', new UuidParam('Webhook')) id: string): Promise<WebhookEndpointRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.hooks.get(tx, id));
  }

  @Post()
  @Requires('config.webhooks:action.edit')
  create(@Body(new Zod(WebhookEndpointInput)) body: z.infer<typeof WebhookEndpointInput>): Promise<WebhookEndpointRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.hooks.create(tx, p.tenantId, p.userId, body));
  }

  @Put(':id')
  @Requires('config.webhooks:action.edit')
  update(@Param('id', new UuidParam('Webhook')) id: string, @Body(new Zod(WebhookUpdate)) body: z.infer<typeof WebhookUpdate>): Promise<WebhookEndpointRow> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.hooks.update(tx, p.userId, id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('config.webhooks:action.edit')
  async remove(@Param('id', new UuidParam('Webhook')) id: string): Promise<void> {
    const p = tenantPrincipal();
    await this.db.tenantTx(p.tenantId, tx => this.hooks.remove(tx, p.userId, id));
  }

  @Get(':id/deliveries')
  @Requires('config.webhooks:action.view')
  deliveries(@Param('id', new UuidParam('Webhook')) id: string): Promise<WebhookDeliveryRow[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.hooks.deliveries(tx, id));
  }

  @Post(':id/test')
  @HttpCode(200)
  @Requires('config.webhooks:action.edit')
  test(@Param('id', new UuidParam('Webhook')) id: string): Promise<WebhookDeliveryRow> {
    const p = tenantPrincipal();
    return this.hooks.test(p.tenantId, id);
  }
}

// ------------------------------------------------------------------ message log
@TenantOnly()
@Controller('messages')
export class MessagesController {
  constructor(private readonly db: DbService, private readonly messages: MessagesService) {}

  @Get()
  @Requires('messages:action.view')
  list(@Query(new Zod(MessageListQuery)) q: z.infer<typeof MessageListQuery>): Promise<Page<OutboundMessageRow>> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.messages.list(tx, q));
  }

  @Post(':id/retry')
  @HttpCode(200)
  @Requires('messages:action.retry')
  retry(@Param('id', new UuidParam('Message')) id: string): Promise<OutboundMessageRow> {
    return this.messages.retry(tenantPrincipal().tenantId, id);
  }
}

// ------------------------------------------------------------------ per document: messages + manual send
@TenantOnly()
@Controller('docs/:type/:id')
export class DocMessagesController {
  constructor(private readonly db: DbService, private readonly messages: MessagesService) {}

  @Get('messages')
  list(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<OutboundMessageRow[]> {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.messages.forDocument(tx, a, typeKeyOf(type), id));
  }

  @Get('send/options')
  options(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<SendOptions> {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.messages.options(tx, a, typeKeyOf(type), id));
  }

  @Get('send/suggestions')
  suggestions(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @CurrentPermissions() perms?: MyPermissions): Promise<SendSuggestion[]> {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.messages.suggestions(tx, a, typeKeyOf(type), id));
  }

  @Post('send/preview')
  @HttpCode(200)
  preview(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(PreviewInput)) body: z.infer<typeof PreviewInput>, @CurrentPermissions() perms?: MyPermissions): Promise<SendPreview> {
    const a = actorOf(perms);
    return this.db.tenantTx(a.tenantId, tx => this.messages.preview(tx, a, typeKeyOf(type), id, body));
  }

  @Post('send')
  @HttpCode(201)
  send(@Param('type') type: string, @Param('id', new UuidParam('Document')) id: string, @Body(new Zod(ManualSendInput)) body: z.infer<typeof ManualSendInput>, @CurrentPermissions() perms?: MyPermissions): Promise<OutboundMessageRow[]> {
    return this.messages.send(actorOf(perms), typeKeyOf(type), id, body);
  }
}

// ------------------------------------------------------------------ inbound provider webhooks (public)
const MAX_RAW = 256 * 1024;
async function rawBody(req: Request & { rawBody?: Buffer }): Promise<Buffer> {
  if (req.rawBody) return req.rawBody;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  if (!req.readable) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_RAW) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

@Public()
@Controller('hooks')
export class ProviderHooksController {
  constructor(private readonly hooks: HooksService) {}

  @Get('whatsapp')
  async verify(@Query('hub.mode') mode: string | undefined, @Query('hub.verify_token') token: string | undefined, @Query('hub.challenge') challenge: string | undefined, @Res() res: Response) {
    const out = await this.hooks.metaVerify(mode, token, challenge);
    if (out === null) res.status(403).type('text/plain').send('Forbidden');
    else res.status(200).type('text/plain').send(out);
  }

  /** Fails closed: no raw body (rawBody capture off) or no matching app secret → 401. */
  @Post('whatsapp')
  @HttpCode(200)
  async whatsapp(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-hub-signature-256') sig: string | undefined) {
    const r = await this.hooks.metaNotify(req.rawBody, sig);
    if (!r.ok) throw new AppError(401, 'BAD_SIGNATURE', 'Invalid signature');
    return { ok: true, updated: r.updated };
  }

  @Post('email/ses')
  @HttpCode(200)
  async ses(@Req() req: Request & { rawBody?: Buffer }) {
    const r = await this.hooks.sesNotify(await rawBody(req));
    if (!r.ok) throw new AppError(401, 'BAD_SIGNATURE', 'Invalid SNS message');
    return { ok: true, updated: r.updated, ...(r.confirmed ? { confirmed: true } : {}) };
  }
}
