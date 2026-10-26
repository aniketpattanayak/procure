/**
 * Report delivery: PDF exports (templates table renderer, real Chromium, network-locked) and scheduled report emails
 * through the notify email channel (recipients, de-duplication, monthly quota, idempotency).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueService } from '../src/core/queue.service';
import { FilesService } from '../src/modules/files';
import { ExportsService } from '../src/modules/reports/exports.service';
import { SchedulesService } from '../src/modules/reports/schedules.service';
import { TemplateRendererService } from '../src/modules/templates';
import { mustOk } from './forms-helpers';
import { bootApp, closeApp, Ctx } from './helpers';
import { cleanQueues, makeNotifyDoc, NOTIFY_FEATURES, notifyDocType, notifyTenant, NotifyTenant, provider, sendQueued } from './notify-helpers';
import { reportsApi } from './reports-helpers';

describe('reports: PDF export and scheduled email delivery', () => {
  let c: Ctx;
  let t: NotifyTenant;
  let r: ReturnType<typeof reportsApi>;
  let reportId: string;

  beforeAll(async () => {
    c = await bootApp();
    t = await notifyTenant(c, { features: [...NOTIFY_FEATURES, 'reports', 'report_builder'], limits: { email_per_month: 2 } });
    await provider(c, t, 'email');
    const dt = await notifyDocType(c, t);
    await makeNotifyDoc(c, t, dt, { values: { purpose: '<script>alert(1)</script> & co' } });
    await makeNotifyDoc(c, t, dt);
    r = reportsApi(c, t.token);
    const rep = await mustOk(r.create({ key: 'po_list', name: 'PO list', definition: { source: { kind: 'doc', key: dt.key }, columns: [{ field: 'number' }, { field: 'total_amount' }] } }), 201);
    reportId = rep.id;
  });
  afterAll(async () => {
    await cleanQueues(c);
    await c.app.get(QueueService).queue('exports').obliterate({ force: true }).catch(() => undefined);
    await closeApp(c);
  });

  it('table PDF: escapes cell text, repeats the header, makes a real PDF', async () => {
    const pdf = await c.app.get(TemplateRendererService).renderTablePdf({ title: 'T <b>', header: ['A', 'B'], rows: [['<img src=https://evil.test/x>', 1234.5], [null, true]] });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { tableHtml } = await import('../src/modules/templates/table-pdf');
    const html = tableHtml({ title: 'T <b>', header: ['A'], rows: [['<img src=x>']] });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toMatch(/<script|https?:\/\//);
  });

  it('POST /exports format pdf produces a PDF file (was 400 before)', async () => {
    const job = await mustOk(r.post('/exports', { kind: 'report', source: { reportId }, format: 'pdf' }), 201);
    expect(await c.app.get(ExportsService).process(t.tenantId, job.id)).toBe('ready');
    const done = await mustOk(r.get(`/exports/${job.id}`));
    expect(done).toMatchObject({ status: 'ready', format: 'pdf', rowCount: 2 });
    const j = await c.db.selectFrom('app.export_job').select('file_id').where('id', '=', job.id).executeTakeFirstOrThrow();
    const f = await c.db.selectFrom('app.file_object').select(['storage_key', 'mime', 'filename']).where('id', '=', j.file_id!).executeTakeFirstOrThrow();
    expect(f.mime).toBe('application/pdf');
    expect(f.filename).toMatch(/\.pdf$/);
    expect((await c.app.get(FilesService).storage.get(f.storage_key)).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('a scheduled report emails its recipients (deduplicated) with a download link, within the email quota, once', async () => {
    const sched = await mustOk(r.post(`/reports/${reportId}/schedules`, {
      cron: '0 9 * * *', format: 'csv',
      recipients: [{ type: 'user', userId: t.adminId }, { type: 'email', address: 'Boss@Example.test' }, { type: 'email', address: 'boss@example.test' }, { type: 'email', address: 'third@example.test' }],
    }), 201);
    expect((await c.app.get(SchedulesService).scan(new Date(sched.nextRunAt))).fired).toBe(1);
    const job = await c.db.selectFrom('app.export_job').selectAll().where('tenant_id', '=', t.tenantId)
      .where(eb => eb(eb.ref('source'), '@>', JSON.stringify({ scheduleId: sched.id }) as never)).executeTakeFirstOrThrow();
    const exportsSvc = c.app.get(ExportsService);
    expect(await exportsSvc.process(t.tenantId, job.id)).toBe('ready');

    const msgs = await c.db.selectFrom('app.outbound_message').selectAll().where('tenant_id', '=', t.tenantId).where('template_id', 'is', null).orderBy('created_at').execute();
    expect(msgs).toHaveLength(3); // admin + boss (case-insensitive duplicate collapsed) + third
    expect(new Set(msgs.map(m => m.recipient)).has('boss@example.test')).toBe(true);
    // email_per_month = 2: the third recipient is blocked by the plan quota, never queued
    expect(msgs.map(m => m.status).sort()).toEqual(['blocked_limit', 'queued', 'queued']);
    for (const m of msgs) {
      expect(m.channel).toBe('email');
      expect(m.subject).toBe('Scheduled report: PO list');
      expect(m.body_preview).toContain(`/exports/${job.id}`);
      expect(m.document_id).toBeNull();
    }
    const sent = await sendQueued(c, t.tenantId);
    expect(sent.map(s => s.status)).toEqual(['sent', 'sent']);

    // Idempotent per export job + address: delivering again adds nothing.
    const again = await exportsSvc.emailRecipients(t.tenantId, job as never, job.file_id!, 'PO list', 2);
    expect(again.queued).toBe(0);
    expect(await c.db.selectFrom('app.outbound_message').select('id').where('tenant_id', '=', t.tenantId).where('template_id', 'is', null).execute()).toHaveLength(3);
  });

  it('a non-scheduled export emails nobody', async () => {
    const job = await mustOk(r.post('/exports', { kind: 'report', source: { reportId }, format: 'csv' }), 201);
    const before = (await c.db.selectFrom('app.outbound_message').select('id').where('tenant_id', '=', t.tenantId).execute()).length;
    expect(await c.app.get(ExportsService).process(t.tenantId, job.id)).toBe('ready');
    expect((await c.db.selectFrom('app.outbound_message').select('id').where('tenant_id', '=', t.tenantId).execute()).length).toBe(before);
  });
});
