import { Global, Module } from '@nestjs/common';
import { FilesModule } from '../files';
import { FormsModule } from '../forms';
import { NotifyModule } from '../notify';
import { ReportsCatalogue } from './catalogue.service';
import { DashboardsController, ExportsController, ReportsController } from './controllers';
import { DashboardsService } from './dashboards.service';
import { ExportsService } from './exports.service';
import { ReportsService } from './reports.service';
import { ReportRunner } from './runner.service';
import { SchedulesService } from './schedules.service';

/**
 * Reports engine (Phase 7, ADR-0015): source catalogue + compiler, saved reports (built-in + custom), background
 * exports (queue `exports`), schedules (queue `reports`) and dashboards. Global so modules can inject the
 * catalogue to register their engine sources (or call the exported `registerSource`).
 */
@Global()
@Module({
  // Forms, Files and Notify are not global; Documents, Permissions and Workflow are. Notify: scheduled report emails.
  imports: [FormsModule, FilesModule, NotifyModule],
  controllers: [ReportsController, ExportsController, DashboardsController],
  providers: [ReportsCatalogue, ReportRunner, ReportsService, ExportsService, SchedulesService, DashboardsService],
  exports: [ReportsCatalogue, ReportRunner, ReportsService, ExportsService],
})
export class ReportsModule {}
