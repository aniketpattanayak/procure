import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DocListQuery, ErrorCode, ExportJobRow, ExportRequest, RecordRow } from '@procure/schema';
import type { DocListRow, ItemListRow, MyPermissions } from '@procure/schema';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { z } from 'zod';
import { config } from '../../core/config';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { TEMPLATE_RENDERER, TemplateRenderer } from '../../core/ports';
import { QueueService } from '../../core/queue.service';
import { DocListService, DocTypesService } from '../documents';
import { FilesService } from '../files';
import { dataFields, FormsService, isFileField, isGrid, MastersService, RecordsService } from '../forms';
import { normaliseAddress, OutboundService } from '../notify';
import { PermissionResolverService } from '../permissions';
import { fetchPage, limits, resultColumns, shapeRows } from './compiler';
import { ReportsService } from './reports.service';
import { ReportRunner } from './runner.service';
import type { RunActor } from './types';
import { ExportCell, MIME, openWriter, TableWriter } from './writers';

export const EXPORTS_QUEUE = 'exports';
export const EXPORT_TTL_DAYS = 7;
/** A PDF export holds at most this many rows (a printable table, not a data dump); xlsx/csv have no such cap. */
export const PDF_MAX_ROWS = 5000;
const BATCH = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
const holds = (perms: MyPermissions | null, key: string) => !perms || perms.keys.includes(key);

const ReportSourceRef = z.object({ reportId: z.string().regex(UUID, 'Report id'), params: z.record(z.string(), z.unknown()).default({}) }).passthrough();
const ListSourceRef = z.object({
  scope: z.string().regex(/^doc\.[a-z][a-z0-9_]{1,60}(:item)?$/, 'doc.<type> or doc.<type>:item'),
  query: z.record(z.string(), z.unknown()).default({}),
});
const MasterSourceRef = z.object({ masterKey: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), view: z.enum(['active', 'inactive', 'all']).default('active') });

type JobRow = {
  id: string; kind: 'report' | 'list' | 'master' | 'import'; source: Record<string, unknown>; format: 'xlsx' | 'csv' | 'pdf'; status: ExportJobRow['status'];
  row_count: string | null; file_id: string | null; error: string | null; requested_by: string; created_at: Date; finished_at: Date | null; expires_at: Date | null;
};
const COLS = ['id', 'kind', 'source', 'format', 'status', 'row_count', 'file_id', 'error', 'requested_by', 'created_at', 'finished_at', 'expires_at'] as const;

interface Producer {
  name: string;
  /** Column labels. */
  header: string[];
  /** Yields row batches until exhausted. */
  batches(): AsyncGenerator<ExportCell[][]>;
}

/** Parses list query params the way GET /docs/:type does (f.<field> filters, the rest DocListQuery). */
function listInput(raw: Record<string, unknown>, view: 'document' | 'item') {
  const fields: Record<string, string> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('f.')) {
      if (!/^f\.[a-z][a-z0-9_]{0,62}$/.test(k) || typeof v !== 'string') throw bad(`source.query.${k}`, `Invalid filter "${k}".`);
      fields[k.slice(2)] = v;
    } else if (k !== 'cursor' && k !== 'limit' && k !== 'view' && k !== 'columns') rest[k] = v;
  }
  return { ...DocListQuery.parse({ ...rest, view }), fields, limit: 1000 };
}

const NIL = '00000000-0000-0000-0000-000000000000';

/**
 * Tenants with due schedules or expired ready exports (migration 0014, SECURITY DEFINER, returns ids only). No tenant
 * context is needed; NIL keeps RLS closed for anything else in the transaction.
 */
export async function reportDueTenants(db: DbService, now: Date): Promise<string[]> {
  return db.tenantTx(NIL, async tx => (await sql<{ tenant_id: string }>`select tenant_id from app.report_due_tenants(${now})`.execute(tx)).rows.map(r => r.tenant_id));
}

const n = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Buffers up to PDF_MAX_ROWS rows and renders them through the templates module's table PDF renderer on close. */
class PdfTableWriter implements TableWriter {
  private head: string[] = [];
  private readonly body: ExportCell[][] = [];
  truncated = false;
  constructor(private readonly renderer: Required<Pick<TemplateRenderer, 'renderTablePdf'>>, private readonly path: string, private readonly title: string) {}
  get full() { return this.body.length >= PDF_MAX_ROWS; }
  async header(labels: string[]) { this.head = labels; }
  async rows(rows: ExportCell[][]) {
    const room = PDF_MAX_ROWS - this.body.length;
    if (rows.length > room) this.truncated = true;
    this.body.push(...rows.slice(0, Math.max(0, room)));
  }
  async close() {
    const at = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const pdf = await this.renderer.renderTablePdf({
      title: this.title, subtitle: `Generated ${at} UTC · ${this.body.length} row${this.body.length === 1 ? '' : 's'}`, header: this.head, rows: this.body,
      note: this.truncated ? `Only the first ${PDF_MAX_ROWS.toLocaleString('en-IN')} rows are included. Export to Excel or CSV for all rows.` : null,
    });
    await writeFile(this.path, pdf);
  }
}

/**
 * Background exports (queue `exports`, concurrency 2): report results, document lists (both views) and master
 * lists streamed in batches to xlsx / csv files that expire after 7 days. The requester is notified in-app.
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  private readonly log = new Logger('Exports');

  constructor(
    private readonly db: DbService,
    private readonly queue: QueueService,
    private readonly files: FilesService,
    private readonly runner: ReportRunner,
    private readonly reports: ReportsService,
    private readonly lists: DocListService,
    private readonly docTypes: DocTypesService,
    private readonly masters: MastersService,
    private readonly records: RecordsService,
    private readonly forms: FormsService,
    private readonly resolver: PermissionResolverService,
    private readonly moduleRef: ModuleRef,
    private readonly outbound: OutboundService,
  ) {}

  onModuleInit() {
    this.queue.registerProcessor(EXPORTS_QUEUE, (job: Job) => this.process(job.data.tenantId, job.data.jobId, job), 2);
  }

  /** PDF exports use the templates module's table renderer (TEMPLATE_RENDERER.renderTablePdf, Chromium). */
  private pdfRenderer(): Required<Pick<TemplateRenderer, 'renderTablePdf'>> | null {
    try {
      const r = this.moduleRef.get(TEMPLATE_RENDERER, { strict: false }) as TemplateRenderer | undefined;
      return r && typeof r.renderTablePdf === 'function' ? { renderTablePdf: i => r.renderTablePdf!(i) } : null;
    } catch {
      return null;
    }
  }

  pdfAvailable(): boolean {
    return this.pdfRenderer() !== null;
  }

  // ------------------------------------------------------------------ request

  /** Validates access and stores a queued job; call `enqueue` after the transaction commits. */
  async request(tx: Tx, actor: RunActor, input: z.infer<typeof ExportRequest>, extra: Record<string, unknown> = {}): Promise<ExportJobRow> {
    if (input.format === 'pdf' && !this.pdfAvailable()) throw bad('format', 'PDF export is not available. Choose Excel (xlsx) or CSV.');
    let source: Record<string, unknown>;
    if (input.kind === 'report') {
      const s = ReportSourceRef.parse(input.source);
      if (!holds(actor.perms, 'reports:action.view')) throw AppError.forbidden();
      if (!holds(actor.perms, 'reports:action.export')) throw AppError.forbidden('You cannot export reports.');
      const r = await this.reports.get(tx, actor, s.reportId);
      await this.runner.prepare(tx, actor, r.definition, { params: s.params, adapt: r.kind === 'builtin' }); // access + validity now, not in the job
      source = { reportId: r.id, params: s.params, name: r.name };
    } else if (input.kind === 'list') {
      const s = ListSourceRef.parse(input.source);
      const [tab, view] = s.scope.split(':') as [string, string | undefined];
      const typeKey = tab.slice('doc.'.length);
      const t = await this.docTypes.find(tx, actor.tenantId, typeKey);
      if (!t || !holds(actor.perms, `doc.${typeKey}:action.view`)) throw AppError.notFound('Document type');
      const q = listInput(s.query, view === 'item' ? 'item' : 'document');
      await this.lists.list(tx, { ...actor }, t, { ...q, limit: 1 }); // validates filters / status views
      source = { scope: s.scope, query: s.query, name: view === 'item' ? `${t.plural_name} — item-wise` : t.plural_name };
    } else if (input.kind === 'master') {
      const s = MasterSourceRef.parse(input.source);
      const m = await this.masters.find(tx, actor.tenantId, s.masterKey);
      if (!m || !holds(actor.perms, `master.${m.key}:action.view`)) throw AppError.notFound('Master');
      if (!holds(actor.perms, `master.${m.key}:action.export`)) throw AppError.forbidden(`You cannot export ${m.plural_name.toLowerCase()}.`);
      source = { masterKey: m.key, view: s.view, name: m.plural_name };
    } else throw bad('kind', 'Unknown export kind.');
    const row = await tx.insertInto('app.export_job').values({
      kind: input.kind, source: JSON.stringify({ ...source, ...extra }), format: input.format, requested_by: actor.userId!,
    }).returning([...COLS]).executeTakeFirstOrThrow();
    return this.toRow(actor.tenantId, row as JobRow);
  }

  async enqueue(tenantId: string, jobId: string) {
    await this.queue.enqueue(EXPORTS_QUEUE, 'export', { tenantId, jobId }, { jobId: `export:${jobId}`, attempts: 3 });
  }

  async toRow(tenantId: string, r: JobRow, tx?: Tx): Promise<ExportJobRow & { source: Record<string, string> }> {
    let fileUrl: string | null = null;
    if (r.status === 'ready' && r.file_id) {
      const f = tx ? await this.files.loadOne(tx, tenantId, r.file_id) : await this.db.tenantTx(tenantId, t => this.files.loadOne(t, tenantId, r.file_id!));
      if (f) fileUrl = (await this.files.toMeta(tenantId, f)).url;
    }
    const src = r.source ?? {};
    const pick = (k: string) => (typeof src[k] === 'string' ? { [k]: src[k] as string } : {});
    return {
      id: r.id, name: typeof src.name === 'string' ? src.name : undefined,
      // what was exported, without params / recipients
      source: { ...pick('reportId'), ...pick('scope'), ...pick('masterKey'), ...pick('view'), ...pick('scheduleId') },
      kind: r.kind, format: r.format, status: r.status, rowCount: r.row_count === null ? null : Number(r.row_count), fileUrl, error: r.error,
      createdAt: new Date(r.created_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    };
  }

  async list(tx: Tx, actor: RunActor): Promise<ExportJobRow[]> {
    const rows = (await tx.selectFrom('app.export_job').select([...COLS]).where('tenant_id', '=', actor.tenantId)
      .where('requested_by', '=', actor.userId!).orderBy('created_at', 'desc').limit(100).execute()) as JobRow[];
    const out: ExportJobRow[] = [];
    for (const r of rows) out.push(await this.toRow(actor.tenantId, r, tx));
    return out;
  }

  async get(tx: Tx, actor: RunActor, id: string): Promise<ExportJobRow> {
    if (!UUID.test(id)) throw AppError.notFound('Export');
    const r = (await tx.selectFrom('app.export_job').select([...COLS]).where('tenant_id', '=', actor.tenantId).where('id', '=', id)
      .where('requested_by', '=', actor.userId!).executeTakeFirst()) as JobRow | undefined;
    if (!r) throw AppError.notFound('Export');
    return this.toRow(actor.tenantId, r, tx);
  }

  // ------------------------------------------------------------------ processing

  private async actorFor(tenantId: string, userId: string): Promise<RunActor> {
    const u = await this.db.tenantTx(tenantId, tx => tx.selectFrom('app.tenant_user').select(['is_tenant_admin', 'is_active', 'is_deleted'])
      .where('id', '=', userId).executeTakeFirst());
    if (!u || !u.is_active || u.is_deleted) throw AppError.forbidden('The user who requested this export is no longer active.');
    return { tenantId, userId, perms: await this.resolver.resolve(tenantId, userId, u.is_tenant_admin) };
  }

  /** Runs one export job (idempotent: a finished job is left alone). Returns the final status. */
  async process(tenantId: string, jobId: string, job?: Job): Promise<string> {
    const row = (await this.db.tenantTx(tenantId, tx => tx.selectFrom('app.export_job').select([...COLS]).where('id', '=', jobId).executeTakeFirst())) as JobRow | undefined;
    if (!row) return 'missing';
    if (row.status === 'ready' || row.status === 'expired') return row.status;
    await this.db.tenantTx(tenantId, tx => tx.updateTable('app.export_job').set({ status: 'running', started_at: new Date(), error: null }).where('id', '=', jobId).execute());
    const dir = join(tmpdir(), 'procure-exports');
    await mkdir(dir, { recursive: true });
    const ext = row.format;
    const path = join(dir, `${jobId}.${ext}`);
    try {
      const actor = await this.actorFor(tenantId, row.requested_by);
      const producer = await this.producer(actor, row);
      let pdf: PdfTableWriter | null = null;
      if (ext === 'pdf') {
        const r = this.pdfRenderer();
        if (!r) throw new AppError(400, ErrorCode.VALIDATION, 'PDF export is not available. Choose Excel (xlsx) or CSV.');
        pdf = new PdfTableWriter(r, path, producer.name);
      }
      const writer: TableWriter = pdf ?? openWriter(ext === 'csv' ? 'csv' : 'xlsx', path, producer.name);
      let count = 0;
      let closed = false;
      try {
        await writer.header(producer.header);
        for await (const batch of producer.batches()) {
          await writer.rows(batch);
          count += batch.length;
          if (pdf?.full) break; // the rest would be dropped anyway
        }
        closed = true;
        await writer.close();
      } finally {
        if (!closed && !pdf) await writer.close().catch(() => undefined);
      }
      if (pdf) count = Math.min(count, PDF_MAX_ROWS);
      const fileId = await this.store(tenantId, row, path, producer.name, count);
      await this.emailRecipients(tenantId, row, fileId, producer.name, count).catch(e =>
        this.log.warn(`export ${jobId}: scheduled report email failed: ${(e as Error).message}`));
      return 'ready';
    } catch (e) {
      const final = e instanceof AppError || !job || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (!final) throw e;
      const message = e instanceof AppError ? e.message : 'The export failed. Try again, or narrow the filters.';
      if (!(e instanceof AppError)) this.log.warn(`export ${jobId} failed: ${(e as Error).stack ?? String(e)}`);
      await this.db.tenantTx(tenantId, async tx => {
        await tx.updateTable('app.export_job').set({ status: 'failed', error: message, finished_at: new Date() }).where('id', '=', jobId).execute();
        await tx.insertInto('app.notification').values({
          user_id: row.requested_by, kind: 'export_failed', title: 'Your export failed', body: message, link: `/exports/${jobId}`, data: JSON.stringify({ exportId: jobId }),
        }).execute();
      });
      return 'failed';
    } finally {
      await rm(path, { force: true });
    }
  }

  private async store(tenantId: string, row: JobRow, path: string, name: string, count: number): Promise<string> {
    const body = await readFile(path);
    const ext = row.format;
    const now = new Date();
    const key = `${tenantId}/exports/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${row.id}.${ext}`;
    await this.files.storage.put(key, body, MIME[ext]);
    const safe = name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'export';
    const filename = `${safe}-${now.toISOString().slice(0, 10)}.${ext}`;
    const expires = new Date(now.getTime() + EXPORT_TTL_DAYS * 86_400_000);
    const source = row.source ?? {};
    return this.db.tenantTx(tenantId, async tx => {
      // Exports are not counted against the storage limit (contract): no consume_storage().
      const f = await tx.insertInto('app.file_object').values({
        storage_key: key, filename, mime: MIME[ext], size_bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'),
        scan_status: 'clean', attached_to: JSON.stringify({ kind: 'export_job', id: row.id, field: 'file' }), created_by: row.requested_by,
      }).returning('id').executeTakeFirstOrThrow();
      await tx.updateTable('app.export_job').set({ status: 'ready', row_count: count, file_id: f.id, finished_at: now, expires_at: expires, error: null })
        .where('id', '=', row.id).execute();
      const recipients = new Set<string>([row.requested_by]);
      const scheduled = typeof source.scheduleId === 'string';
      if (scheduled && Array.isArray(source.recipients)) {
        for (const r of source.recipients as { type: string; userId?: string }[]) if (r.type === 'user' && r.userId && UUID.test(r.userId)) recipients.add(r.userId);
      }
      const users = await tx.selectFrom('app.tenant_user').select('id').where('id', 'in', [...recipients]).where('is_active', '=', true).where('is_deleted', '=', false).execute();
      if (users.length) {
        await tx.insertInto('app.notification').values(users.map(u => ({
          user_id: u.id, kind: scheduled ? 'scheduled_report' : 'export_ready',
          title: scheduled ? `Scheduled report "${name}" is ready` : 'Your export is ready',
          body: `${name} — ${count} row${count === 1 ? '' : 's'} (${ext}). The file is available for ${EXPORT_TTL_DAYS} days.`,
          link: `/exports/${row.id}`, data: JSON.stringify({ exportId: row.id, scheduleId: source.scheduleId ?? null }),
        }))).execute();
      }
      return f.id;
    });
  }

  /**
   * Scheduled reports: e-mails the schedule's recipients (users by their account email, plus literal addresses)
   * through the notify email channel as a system message with a signed download link valid until the export
   * expires. Notify applies the plan feature / provider gate and the monthly email quota per recipient (blocked
   * messages show in the message log). Idempotent per export job + address, so a retried job never sends twice.
   */
  async emailRecipients(tenantId: string, row: JobRow, fileId: string, name: string, count: number): Promise<{ queued: number; blocked: number }> {
    const source = row.source ?? {};
    if (typeof source.scheduleId !== 'string' || !Array.isArray(source.recipients)) return { queued: 0, blocked: 0 };
    const list = source.recipients as { type: string; userId?: string; address?: string }[];
    const ttlSec = EXPORT_TTL_DAYS * 86_400;
    const signed = this.files.signedUrl(tenantId, fileId, null, ttlSec);
    const web = config.webOrigin[0]!.replace(/\/+$/, '');
    // Absolute signed link when FILE_URL_BASE is set (production); otherwise only the in-app page can be linked.
    const download = /^https?:\/\//.test(signed) ? signed : null;
    const inApp = `${web}/exports/${row.id}`;
    const until = new Date(Date.now() + ttlSec * 1000).toISOString().slice(0, 10);
    const fmt = row.format.toUpperCase();
    const subject = `Scheduled report: ${name}`.slice(0, 200);
    const body = [
      `<p>Your scheduled report <strong>${esc(name)}</strong> is ready: ${count} row${count === 1 ? '' : 's'} (${fmt}).</p>`,
      download ? `<p><a href="${esc(download)}">Download ${esc(fmt)} file</a> (link valid until ${until}).</p>` : '',
      `<p>You can also open it in the app: <a href="${esc(inApp)}">${esc(inApp)}</a> (sign-in required).</p>`,
      '<p style="color:#777;font-size:12px">You receive this because you are a recipient of a report schedule. Ask the schedule owner to remove you.</p>',
    ].join('\n');
    const res = await this.db.tenantTx(tenantId, async tx => {
      const userIds = [...new Set(list.filter(r => r.type === 'user' && r.userId && UUID.test(r.userId)).map(r => r.userId!))];
      const users = userIds.length
        ? await tx.selectFrom('app.tenant_user').select(['id', 'name', 'email']).where('tenant_id', '=', tenantId).where('id', 'in', userIds)
          .where('is_active', '=', true).where('is_deleted', '=', false).execute()
        : [];
      const seen = new Set<string>();
      const to: { address: string; name: string | null; userId: string | null; source: 'users' | 'fixed' }[] = [];
      const add = (raw: string | null | undefined, nm: string | null, userId: string | null) => {
        if (!raw) return;
        const a = normaliseAddress('email', raw);
        if (!a.valid || seen.has(a.address)) return;
        seen.add(a.address);
        to.push({ address: a.address, name: nm, userId, source: userId ? 'users' : 'fixed' });
      };
      for (const u of users) add(u.email, u.name, u.id);
      for (const r of list) if (r.type === 'email') add(r.address, null, null);
      if (!to.length) return { enqueue: [], ids: [] as string[] };
      return this.outbound.create(tx, {
        tenantId, channel: 'email', templateId: null, content: { subject, body }, documentId: null, recipients: to,
        keyBase: `report:${row.id}`, manual: false, createdBy: row.requested_by, context: {},
      });
    });
    await this.outbound.enqueue(res.enqueue);
    return { queued: res.enqueue.length, blocked: res.ids.length - res.enqueue.length };
  }

  private async producer(actor: RunActor, row: JobRow): Promise<Producer> {
    const src = row.source ?? {};
    const t = actor.tenantId;
    if (row.kind === 'report') {
      const s = ReportSourceRef.parse(src);
      const r = await this.db.tenantTx(t, tx => this.reports.get(tx, actor, s.reportId));
      const header = await this.db.tenantTx(t, async tx => resultColumns((await this.runner.prepare(tx, actor, r.definition, { params: s.params, adapt: r.kind === 'builtin' })).compiled));
      const types = header.map(h => h.type);
      const runner = this.runner;
      const db = this.db;
      return {
        name: r.name, header: header.map(h => h.label),
        async *batches() {
          let cursor: string | undefined;
          for (;;) {
            const page = await db.tenantTx(t, async tx => {
              const { compiled } = await runner.prepare(tx, actor, r.definition, { params: s.params, adapt: r.kind === 'builtin' });
              await limits(tx, compiled.aggregateMode);
              const p = await fetchPage(tx, compiled, cursor, BATCH);
              return { rows: shapeRows(compiled, p.rows), next: p.nextCursor };
            });
            yield page.rows.map(cells => cells.map((v, i) => ((types[i] === 'number' || types[i] === 'currency') && typeof v === 'string' ? Number(v) : v) as ExportCell));
            if (!page.next) return;
            cursor = page.next;
          }
        },
      };
    }
    if (row.kind === 'list') {
      const s = ListSourceRef.parse(src);
      const [tab, view] = s.scope.split(':') as [string, string | undefined];
      const item = view === 'item';
      const type = await this.db.tenantTx(t, tx => this.docTypes.find(tx, t, tab.slice('doc.'.length)));
      if (!type || !holds(actor.perms, `doc.${type.key}:action.view`)) throw AppError.notFound('Document type');
      const base = listInput(s.query, item ? 'item' : 'document');
      const lists = this.lists;
      const db = this.db;
      // Custom columns come from the first page (keys are the same on every row of a list).
      const first = await db.tenantTx(t, tx => lists.list(tx, actor, type, base));
      const extra = Object.keys((first.data[0] as { columns?: Record<string, unknown> } | undefined)?.columns ?? {});
      const header = item
        ? ['Number', 'Line', 'Status', 'Item code', 'Item', 'Unit', 'Location', 'Required date', 'Requested', 'Approved', 'Pending approval', 'Ordered', 'Received', ...extra]
        : ['Number', 'Date', 'Status', 'Location', 'Total amount', 'Lines', 'Created by', 'Created at', 'Submitted at', 'Overdue', ...extra];
      const shape = (r: DocListRow | ItemListRow): ExportCell[] => {
        const cols = (r.columns ?? {}) as Record<string, unknown>;
        const custom = extra.map(k => { const v = cols[k]; return v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : (v as ExportCell); });
        if (item) {
          const l = r as ItemListRow;
          return [l.number, l.lineNo, l.statusLabel, l.item?.code ?? null, l.item?.name ?? null, l.uom, l.location.name, l.requiredDate,
            n(l.qty.requested), n(l.qty.approved), n(l.qty.pendingApproval), n(l.qty.ordered), n(l.qty.received), ...custom];
        }
        const d = r as DocListRow;
        return [d.number, d.docDate, d.statusLabel, d.location.name, n(d.totalAmount), d.lineCount, d.createdBy, d.createdAt, d.submittedAt, d.overdue, ...custom];
      };
      return {
        name: `${type.plural_name}${item ? ' (item-wise)' : ''}`, header,
        async *batches() {
          let page = first;
          for (;;) {
            yield (page.data as (DocListRow | ItemListRow)[]).map(shape);
            if (!page.nextCursor) return;
            const cursor = page.nextCursor;
            page = await db.tenantTx(t, tx => lists.list(tx, actor, type, { ...base, cursor }));
          }
        },
      };
    }
    if (row.kind === 'master') {
      const s = MasterSourceRef.parse(src);
      const m = await this.db.tenantTx(t, tx => this.masters.load(tx, t, s.masterKey));
      if (!holds(actor.perms, `master.${m.key}:action.export`)) throw AppError.forbidden();
      const def = await this.db.tenantTx(t, async tx => (await this.forms.current(tx, t, await this.forms.loadById(tx, t, m.form_id))).definition);
      const hidden = actor.perms?.fieldAccess?.[m.key] ?? {};
      const fields = dataFields(def).filter(f => !f.removed && !isGrid(f) && !isFileField(f) && hidden[f.key] !== 'hidden');
      const records = this.records;
      const db = this.db;
      const shape = (r: RecordRow): ExportCell[] => [r.code, r.name, ...fields.map(f => {
        const v = r.data[f.key];
        const refs = r.refs?.[f.key];
        if (v === undefined || v === null) return null;
        if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? refs?.[x] ?? x : String(x))).join(', ');
        if (typeof v === 'string' && refs?.[v]) return refs[v]!;
        return typeof v === 'object' ? JSON.stringify(v) : (v as ExportCell);
      }), r.isActive];
      return {
        name: m.plural_name, header: ['Code', 'Name', ...fields.map(f => f.label), 'Active'],
        async *batches() {
          let cursor: string | undefined;
          for (;;) {
            const page = await db.tenantTx(t, tx => records.list(tx, actor, m, { cursor, limit: 1000, view: s.view, filters: {} }));
            yield page.data.map(shape);
            if (!page.nextCursor) return;
            cursor = page.nextCursor;
          }
        },
      };
    }
    throw bad('kind', 'This export kind is not supported.');
  }

  // ------------------------------------------------------------------ expiry

  /** Daily job: ready exports past their expiry become `expired`; their files are deleted. */
  async cleanup(now = new Date()): Promise<{ expired: number }> {
    let expired = 0;
    for (const tenantId of await reportDueTenants(this.db, now)) {
      try {
        expired += await this.cleanupTenant(tenantId, now);
      } catch (e) {
        this.log.warn(`export cleanup failed for ${tenantId}: ${(e as Error).message}`);
      }
    }
    return { expired };
  }

  async cleanupTenant(tenantId: string, now = new Date()): Promise<number> {
    const { keys, count } = await this.db.tenantTx(tenantId, async tx => {
      const due = await tx.selectFrom('app.export_job as j').leftJoin('app.file_object as f', 'f.id', 'j.file_id')
        .select(['j.id', 'j.file_id', 'f.storage_key']).where('j.tenant_id', '=', tenantId).where('j.status', '=', 'ready')
        .where('j.expires_at', '<=', now).forUpdate('j').skipLocked().limit(1000).execute();
      if (due.length) {
        await tx.updateTable('app.export_job').set({ status: 'expired' }).where('tenant_id', '=', tenantId).where('id', 'in', due.map(d => d.id)).execute();
        const fileIds = due.map(d => d.file_id).filter((x): x is string => !!x);
        if (fileIds.length) await tx.updateTable('app.file_object').set({ is_deleted: true }).where('tenant_id', '=', tenantId).where('id', 'in', fileIds).execute();
      }
      return { keys: due.map(d => d.storage_key).filter((x): x is string => !!x), count: due.length };
    });
    for (const k of keys) await this.files.storage.delete(k).catch(e => this.log.warn(`could not delete ${k}: ${String(e)}`));
    return count;
  }
}
