import { Inject, Injectable, Module, OnModuleInit, Optional } from '@nestjs/common';
import { FilesModule } from '../files';
import { TemplatesInstaller } from '../templates';
import { DocMessagesController, MessagesController, ProviderHooksController, TriggersController, WebhooksController } from './controllers';
import { installDefaultRules } from './defaults';
import { TriggerEngine } from './engine.service';
import { HooksService } from './hooks.service';
import { MessagesService } from './messages.service';
import { OutboundService } from './outbound.service';
import { DeliveryStatusService } from './platform/delivery-status.service';
import { PlatformNotifyController } from './platform/platform-notify.controller';
import { ProviderStore } from './platform/providers.store';
import { NotifyPlatformReader } from './platform/usage.reader';
import { WhatsAppCatalogService } from './platform/whatsapp-catalog.service';
import { RecipientResolver } from './recipients';
import { FallbackRenderer, RendererRef } from './renderer';
import { RulesService } from './rules.service';
import { SenderService } from './sender.service';
import { WebhooksService } from './webhooks.service';

/** Registers the per-tenant default rules with the Templates installer (after the starter templates, order 100). */
@Injectable()
class NotifyInstallStep implements OnModuleInit {
  constructor(@Optional() @Inject(TemplatesInstaller) private readonly installer?: TemplatesInstaller) {}
  onModuleInit() {
    this.installer?.register({ key: 'notify.default_rules', order: 500, run: async (tx, ctx) => { await installDefaultRules(tx, ctx.tenantId); } });
  }
}

/**
 * Notify (Phase 6, ADR-0014): trigger engine on `events-notify`, email/WhatsApp/in-app channels behind provider
 * adapters, plan limits, manual send, message log, provider webhooks, outgoing webhooks, send_email/send_whatsapp
 * workflow effects and the Super Admin provider / WhatsApp template endpoints.
 */
@Module({
  imports: [FilesModule],
  controllers: [TriggersController, WebhooksController, MessagesController, DocMessagesController, ProviderHooksController, PlatformNotifyController],
  providers: [
    FallbackRenderer, RendererRef, ProviderStore, WhatsAppCatalogService, DeliveryStatusService, NotifyPlatformReader, RecipientResolver, OutboundService,
    SenderService, RulesService, WebhooksService, TriggerEngine, MessagesService, HooksService, NotifyInstallStep,
  ],
  exports: [TriggerEngine, SenderService, OutboundService, WebhooksService, RendererRef, ProviderStore, HooksService, MessagesService, RulesService],
})
export class NotifyModule {}
