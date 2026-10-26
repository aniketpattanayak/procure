import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ErrorCode, ScheduleInput } from '@procure/schema';
import type { MyPermissions } from '@procure/schema';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { QueueService } from '../../core/queue.service';
import { PermissionResolverService } from '../permissions';
import { ReportsCatalogue } from './catalogue.service';
import { CronError, nextRun, parseCron } from './cron';
import { ExportsService, reportDueTenants } from './exports.service';
import { isAdmin, ReportsService } from './reports.service';
import { ReportRunner } from './runner.service';
import type { RunActor } from './types';

export const REPORTS_QUEUE = 'reports';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
const holds = (perms: MyPermissions | null, key: string) => !perms || perms.keys.includes(key);

export interface ScheduleRow {
  id: string; reportId: string; cron: string; format: 'xlsx' | 'csv' | 'pdf'; recipients: unknown[]; params: Record<string, unknown>;
  runAsUserId: string; isActive: boolean; nextRunAt: string | null; lastRunAt: string | null; createdAt: string;
}
type DbRow = {
  id: string; report_id: string; cron: string; format: 'xlsx' | 'csv' | 'pdf'; recipients: unknown[]; filters: Record<string, unknown>; run_as_user_id: string;
  is_active: boolean; next_run_at: Date | null; last_run_at: Date | null; created_at: Date;
};
const COLS = ['id', 'report_id', 'cron', 'format', 'recipients', 'filters', 'run_as_user_id', 'is_active', 'next_run_at', 'last_run_at', 'created_at'] as const;

const toRow = (r: DbRow): ScheduleRow => ({
  id: r.id, reportId: r.report_id, cron: r.cron, format: r.format, recipients: r.recipients ?? [], params: r.filters ?? {}, runAsUserId: r.run_as_user_id,
  isActive: r.is_active, nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
  lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null, createdAt: new Date(r.created_at).toISOString(),
});

/**
 * Report schedules (contract "schedules"): a repeatable scan (queue `reports`, every minute) finds schedules whose
 * cron — evaluated in the tenant timezone — is due, and queues an export run (xlsx / csv / pdf) as the schedule's
 * creator. When the file is ready, user recipients get an in-app notification with the link, and every recipient
 * (users by account email, plus literal addresses) gets an email through the notify email channel with a signed
 * download link (ExportsService.emailRecipients; plan feature, provider and monthly email quota apply).
 *
 * Tenant discovery: app.report_due_tenants(now) (migration 0014, SECURITY DEFINER).
 */
@Injectable()
export class SchedulesService implements OnModuleInit {
  private readonly log = new Logger('ReportSchedules');

  constructor(
    private readonly db: DbService,
    private readonly queue: QueueService,
    private readonly reports: ReportsService,
    private readonly exports: ExportsService,
    private readonly runner: ReportRunner,
    private readonly catalogue: ReportsCatalogue,
    private readonly resolver: PermissionResolverService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor(REPORTS_QUEUE, async job => {
      if (job.name === 'report-schedules') return this.scan(new Date());
      if (job.name === 'export-cleanup') return this.exports.cleanup(new Date());
      return null;
    }, 1);
    this.queue.registerRepeat(REPORTS_QUEUE, 'report-schedules', { every: 60_000 });
    this.queue.registerRepeat(REPORTS_QUEUE, 'export-cleanup', { pattern: '45 2 * * *' });
  }

  async create(tx: Tx, actor: RunActor, reportId: string, input: z.infer<typeof ScheduleInput>, now = new Date()): Promise<ScheduleRow> {
    const report = await this.reports.get(tx, actor, reportId);
    try {
      parseCron(input.cron);
    } catch (e) {
      throw bad('cron', e instanceof CronError ? `Invalid schedule: ${e.message}.` : 'Invalid schedule.');
    }
    if (input.format === 'pdf' && !this.exports.pdfAvailable()) throw bad('format', 'PDF delivery is not available. Choose Excel (xlsx) or CSV.');
    await this.runner.prepare(tx, actor, report.definition, { params: input.params, adapt: report.kind === 'builtin' });
    const userIds = input.recipients.filter(r => r.type === 'user').map(r => (r as { userId: string }).userId);
    if (userIds.length) {
      const found = await tx.selectFrom('app.tenant_user').select('id').where('tenant_id', '=', actor.tenantId).where('id', 'in', userIds)
        .where('is_deleted', '=', false).execute();
      if (found.length !== new Set(userIds).size) throw bad('recipients', 'Unknown user among the recipients.');
    }
    const tz = await this.catalogue.timezone(actor.tenantId);
    const next = input.isActive ? nextRun(input.cron, now, tz) : null;
    const row = await tx.insertInto('app.report_schedule').values({
      report_id: report.id, cron: input.cron, format: input.format, recipients: JSON.stringify(input.recipients), filters: JSON.stringify(input.params),
      run_as_user_id: actor.userId!, next_run_at: next, is_active: input.isActive, created_by: actor.userId,
    }).returning([...COLS]).executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'create', entity: 'report_schedule', entityId: row.id, actorId: actor.userId, after: { reportId: report.id, cron: input.cron, format: input.format, recipients: input.recipients } });
    return toRow(row as DbRow);
  }

  async list(tx: Tx, actor: RunActor, reportId: string): Promise<ScheduleRow[]> {
    await this.reports.get(tx, actor, reportId);
    let q = tx.selectFrom('app.report_schedule').select([...COLS]).where('tenant_id', '=', actor.tenantId).where('report_id', '=', reportId);
    if (!isAdmin(actor.perms)) q = q.where('run_as_user_id', '=', actor.userId!);
    return ((await q.orderBy('created_at').execute()) as DbRow[]).map(toRow);
  }

  async remove(tx: Tx, actor: RunActor, reportId: string, id: string): Promise<void> {
    if (!UUID.test(id)) throw AppError.notFound('Schedule');
    await this.reports.get(tx, actor, reportId);
    const r = await tx.selectFrom('app.report_schedule').select(['id', 'run_as_user_id', 'cron']).where('tenant_id', '=', actor.tenantId)
      .where('report_id', '=', reportId).where('id', '=', id).executeTakeFirst();
    if (!r || (r.run_as_user_id !== actor.userId && !isAdmin(actor.perms))) throw AppError.notFound('Schedule');
    await tx.deleteFrom('app.report_schedule').where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    await this.audit.tenant(tx, { action: 'delete', entity: 'report_schedule', entityId: id, actorId: actor.userId, before: { reportId, cron: r.cron } });
  }

  /** One scan at `now` (injectable clock for tests). Returns the number of schedules that fired. */
  async scan(now = new Date()): Promise<{ fired: number }> {
    let fired = 0;
    for (const tenantId of await reportDueTenants(this.db, now)) {
      try {
        fired += await this.runTenant(tenantId, now);
      } catch (e) {
        this.log.warn(`schedule scan failed for tenant ${tenantId}: ${(e as Error).message}`);
      }
    }
    return { fired };
  }

  async runTenant(tenantId: string, now: Date): Promise<number> {
    const tz = await this.catalogue.timezone(tenantId);
    const jobs: string[] = [];
    await this.db.tenantTx(tenantId, async tx => {
      const due = (await tx.selectFrom('app.report_schedule').select([...COLS]).where('tenant_id', '=', tenantId).where('is_active', '=', true)
        .where('next_run_at', '<=', now).orderBy('next_run_at').forUpdate().skipLocked().limit(100).execute()) as DbRow[];
      for (const s of due) {
        await tx.updateTable('app.report_schedule').set({ last_run_at: now, next_run_at: nextRun(s.cron, now, tz) }).where('id', '=', s.id).execute();
        await sql`savepoint sched`.execute(tx);
        try {
          const u = await tx.selectFrom('app.tenant_user').select(['is_tenant_admin', 'is_active', 'is_deleted']).where('id', '=', s.run_as_user_id).executeTakeFirst();
          if (!u || !u.is_active || u.is_deleted) throw AppError.forbidden('The owner of this schedule is no longer active.');
          const perms = await this.resolver.resolve(tenantId, s.run_as_user_id, u.is_tenant_admin);
          if (!holds(perms, 'reports:action.schedule')) throw AppError.forbidden('The owner of this schedule may no longer schedule reports.');
          const actor: RunActor = { tenantId, userId: s.run_as_user_id, perms: { ...perms, keys: [...perms.keys, 'reports:action.export'] } };
          const job = await this.exports.request(tx, actor, { kind: 'report', source: { reportId: s.report_id, params: s.filters ?? {} }, format: s.format },
            { scheduleId: s.id, recipients: s.recipients ?? [] });
          jobs.push(job.id);
          await sql`release savepoint sched`.execute(tx);
        } catch (e) {
          await sql`rollback to savepoint sched`.execute(tx);
          const msg = e instanceof AppError ? e.message : 'The scheduled report could not run.';
          if (!(e instanceof AppError)) this.log.warn(`schedule ${s.id}: ${(e as Error).message}`);
          await tx.insertInto('app.notification').values({
            user_id: s.run_as_user_id, kind: 'scheduled_report_failed', title: 'A scheduled report could not run', body: msg,
            link: `/reports/${s.report_id}`, data: JSON.stringify({ scheduleId: s.id }),
          }).execute();
        }
      }
    });
    for (const id of jobs) await this.exports.enqueue(tenantId, id);
    return jobs.length;
  }
}
