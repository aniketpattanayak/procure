import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { DashboardInput, ExportRequest, ReportDefinition, ReportInput, ReportRunInput, ScheduleInput } from '@procure/schema';
import type { MyPermissions } from '@procure/schema';
import { z } from 'zod';
import { TenantOnly } from '../../core/auth/decorators';
import { CurrentPermissions, Requires } from '../../core/auth/permissions';
import { DbService } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { Zod } from '../../core/zod';
import { ReportsCatalogue } from './catalogue.service';
import { DashboardsService } from './dashboards.service';
import { ExportsService } from './exports.service';
import { ReportsService } from './reports.service';
import { SchedulesService } from './schedules.service';
import type { RunActor } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: string, what: string) => {
  if (!UUID.test(v)) throw AppError.notFound(what);
  return v;
};
function actor(perms?: MyPermissions): RunActor {
  const p = tenantPrincipal();
  return { tenantId: p.tenantId, userId: p.userId, perms: perms ?? { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 } };
}

const PreviewInput = z.object({ definition: ReportDefinition, params: z.record(z.string(), z.unknown()).default({}) });
const WidgetDataInput = z.object({ dashboardId: z.string() });

@TenantOnly()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly db: DbService, private readonly reports: ReportsService, private readonly catalogue: ReportsCatalogue,
    private readonly schedules: SchedulesService,
  ) {}

  @Get('sources')
  @Requires('reports:action.view')
  sources(@CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.catalogue.list(tx, a));
  }

  @Get()
  @Requires('reports:action.view')
  list(@CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.reports.list(tx, a));
  }

  @Post('preview')
  @HttpCode(200)
  @Requires('reports:action.view', 'reports:action.build')
  preview(@Body(new Zod(PreviewInput)) body: z.infer<typeof PreviewInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.reports.preview(tx, a, body.definition, body.params));
  }

  @Get(':id')
  @Requires('reports:action.view')
  get(@Param('id') rid: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.reports.get(tx, a, id(rid, 'Report')));
  }

  @Post()
  @Requires('reports:action.view', 'reports:action.build')
  create(@Body(new Zod(ReportInput)) body: z.infer<typeof ReportInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.reports.create(tx, a, body));
  }

  @Put(':id')
  @Requires('reports:action.view', 'reports:action.build')
  update(@Param('id') rid: string, @Body(new Zod(ReportInput)) body: z.infer<typeof ReportInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.reports.update(tx, a, id(rid, 'Report'), body));
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('reports:action.view', 'reports:action.build')
  async remove(@Param('id') rid: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    await this.db.tenantTx(a.tenantId, tx => this.reports.remove(tx, a, id(rid, 'Report')));
  }

  @Post(':id/run')
  @HttpCode(200)
  @Requires('reports:action.view')
  run(@Param('id') rid: string, @Body(new Zod(ReportRunInput)) body: z.infer<typeof ReportRunInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.reports.run(tx, a, id(rid, 'Report'), body));
  }

  // ---- schedules
  @Post(':id/schedules')
  @Requires('reports:action.view', 'reports:action.schedule')
  schedule(@Param('id') rid: string, @Body(new Zod(ScheduleInput)) body: z.infer<typeof ScheduleInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.schedules.create(tx, a, id(rid, 'Report'), body));
  }

  @Get(':id/schedules')
  @Requires('reports:action.view', 'reports:action.schedule')
  listSchedules(@Param('id') rid: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.schedules.list(tx, a, id(rid, 'Report')));
  }

  @Delete(':id/schedules/:scheduleId')
  @HttpCode(204)
  @Requires('reports:action.view', 'reports:action.schedule')
  async removeSchedule(@Param('id') rid: string, @Param('scheduleId') sid: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    await this.db.tenantTx(a.tenantId, tx => this.schedules.remove(tx, a, id(rid, 'Report'), sid));
  }
}

@TenantOnly()
@Controller('exports')
export class ExportsController {
  constructor(private readonly db: DbService, private readonly exports: ExportsService) {}

  /** Access is checked per kind (report view + export, list tab view, master export). */
  @Post()
  async create(@Body(new Zod(ExportRequest)) body: z.infer<typeof ExportRequest>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    const row = await this.db.tenantTx(a.tenantId, tx => this.exports.request(tx, a, body));
    await this.exports.enqueue(a.tenantId, row.id);
    return row;
  }

  @Get()
  list(@CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.exports.list(tx, a));
  }

  @Get(':id')
  get(@Param('id') eid: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.exports.get(tx, a, eid));
  }
}

@TenantOnly()
@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly db: DbService, private readonly dashboards: DashboardsService) {}

  @Get()
  @Requires('dashboards:action.view')
  list(@CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.dashboards.list(tx, a));
  }

  /** Any tenant user: role default → personal → built-in "My work". */
  @Get('mine')
  mine(@CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.dashboards.mine(tx, a));
  }

  /** Data of one widget of a dashboard the caller can see (report widgets also need report + source access). */
  @Post('widgets/:widgetId/data')
  @HttpCode(200)
  data(@Param('widgetId') widgetId: string, @Body(new Zod(WidgetDataInput)) body: z.infer<typeof WidgetDataInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.dashboards.widgetData(tx, a, body.dashboardId, widgetId));
  }

  @Get(':id')
  @Requires('dashboards:action.view')
  get(@Param('id') did: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.dashboards.get(tx, a, did));
  }

  @Post()
  @Requires('dashboards:action.view', 'dashboards:action.edit')
  create(@Body(new Zod(DashboardInput)) body: z.infer<typeof DashboardInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.dashboards.create(tx, a, body));
  }

  @Put(':id')
  @Requires('dashboards:action.view', 'dashboards:action.edit')
  update(@Param('id') did: string, @Body(new Zod(DashboardInput)) body: z.infer<typeof DashboardInput>, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    return this.db.tenantTx(a.tenantId, tx => this.dashboards.update(tx, a, did, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @Requires('dashboards:action.view', 'dashboards:action.edit')
  async remove(@Param('id') did: string, @CurrentPermissions() perms?: MyPermissions) {
    const a = actor(perms);
    await this.db.tenantTx(a.tenantId, tx => this.dashboards.remove(tx, a, did));
  }
}
