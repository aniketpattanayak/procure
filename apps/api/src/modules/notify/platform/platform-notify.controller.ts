import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { Principal, ProviderCredentialInput, WhatsAppTemplateInput } from '@procure/schema';
import { z } from 'zod';
import { CurrentPrincipal, PlatformOnly } from '../../../core/auth/decorators';
import { Zod } from '../../../core/zod';
import { UuidParam } from '../../identity';
import { ProviderStore } from './providers.store';
import { WhatsAppCatalogService } from './whatsapp-catalog.service';

const ProviderUpdate = ProviderCredentialInput.and(z.object({ version: z.number().int() }));
const ProviderQuery = z.object({ tenantId: z.string().uuid().optional(), channel: z.enum(['email', 'whatsapp']).optional() });
const AllowedBody = z.object({ templateIds: z.array(z.string().uuid()).max(500) });
type PlatformPrincipal = Extract<Principal, { kind: 'platform' }>;

/** Super Admin: provider credentials (secrets write-only) and the WhatsApp template catalogue / tenant approvals. */
@PlatformOnly('owner')
@Controller('platform')
export class PlatformNotifyController {
  constructor(private readonly providers: ProviderStore, private readonly wa: WhatsAppCatalogService) {}

  @Get('providers')
  listProviders(@Query(new Zod(ProviderQuery)) q: z.infer<typeof ProviderQuery>) {
    return this.providers.list(q);
  }

  @Get('providers/:id')
  getProvider(@Param('id', new UuidParam('Provider')) id: string) {
    return this.providers.get(id);
  }

  @Post('providers')
  createProvider(@Body(new Zod(ProviderCredentialInput)) body: z.infer<typeof ProviderCredentialInput>) {
    return this.providers.create(body);
  }

  @Put('providers/:id')
  updateProvider(@Param('id', new UuidParam('Provider')) id: string, @Body(new Zod(ProviderUpdate)) body: z.infer<typeof ProviderUpdate>) {
    return this.providers.update(id, body);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  async deleteProvider(@Param('id', new UuidParam('Provider')) id: string) {
    await this.providers.remove(id);
  }

  @Get('whatsapp-templates')
  listTemplates() {
    return this.wa.list();
  }

  @Post('whatsapp-templates')
  createTemplate(@Body(new Zod(WhatsAppTemplateInput)) body: z.infer<typeof WhatsAppTemplateInput>) {
    return this.wa.create(body);
  }

  @Put('whatsapp-templates/:id')
  updateTemplate(@Param('id', new UuidParam('WhatsApp template')) id: string, @Body(new Zod(WhatsAppTemplateInput)) body: z.infer<typeof WhatsAppTemplateInput>) {
    return this.wa.update(id, body);
  }

  @Delete('whatsapp-templates/:id')
  @HttpCode(204)
  async deleteTemplate(@Param('id', new UuidParam('WhatsApp template')) id: string) {
    await this.wa.remove(id);
  }

  @Get('tenants/:id/whatsapp-templates')
  tenantTemplates(@Param('id', new UuidParam('Company')) id: string) {
    return this.wa.tenantAllowed(id);
  }

  @Put('tenants/:id/whatsapp-templates')
  setTenantTemplates(@Param('id', new UuidParam('Company')) id: string, @Body(new Zod(AllowedBody)) body: z.infer<typeof AllowedBody>, @CurrentPrincipal() p: PlatformPrincipal) {
    return this.wa.setTenantAllowed(id, body.templateIds, p.userId);
  }
}
