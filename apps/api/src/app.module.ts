import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { FilesModule } from './modules/files';
import { DocumentsModule } from './modules/documents';
import { FormsModule } from './modules/forms';
import { IdentityModule } from './modules/identity';
import { PermissionsModule } from './modules/permissions';
import { PlatformModule } from './modules/platform';
import { ProcurementModule } from './modules/procurement';
import { WorkflowModule } from './modules/workflow';
import { TemplatesModule } from './modules/templates';
import { ReportsModule } from './modules/reports';
import { NotifyModule } from './modules/notify';
import { StockModule } from './modules/stock';
import { InventoryModule } from './modules/inventory';
import { IntegrityModule } from './modules/integrity';

/**
 * Modular monolith root. Each feature module lives in src/modules/<name> and is owned by one agent.
 * Modules talk to each other only through exported services (eslint boundaries rule).
 */
@Module({
  // FormsModule before IdentityModule: its static `GET /users/options` must be registered ahead of `/users/:id`.
  imports: [CoreModule, FilesModule, FormsModule, IdentityModule, PlatformModule, PermissionsModule, DocumentsModule, WorkflowModule, ProcurementModule, TemplatesModule, ReportsModule, NotifyModule, StockModule, InventoryModule, IntegrityModule],
})
export class AppModule {}
