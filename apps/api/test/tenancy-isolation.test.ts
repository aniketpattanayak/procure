/**
 * Generated cross-tenant isolation suite (ADR-0002).
 *
 * DB level: every table in schema `app` is discovered from information_schema at runtime, so tables added by
 * later phases are covered automatically. Rows for tenants A and B are seeded through the API (and directly as
 * the DB owner where the API has no route yet), then, connected as `app_user`:
 *   - context A sees zero B rows (and does see its own rows),
 *   - inserting / re-homing a row to B's tenant_id under context A fails,
 *   - UPDATE / DELETE aimed at B's rows touch zero rows,
 *   - no context → zero rows,
 *   - nothing in schema `platform` is readable.
 *
 * API level: every Phase 1 tenant GET-by-id / mutate-by-id route, called by tenant A's admin with tenant B's ids,
 * answers 404 NOT_FOUND (never 403, never B's data) and leaves B's data unchanged.
 *
 * Adding a new `app.*` table? The "has seed rows" check below fails until you add seeding for it in `seedExtra`.
 */
import { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  API, bearer, bootApp, closeApp, createUser, Ctx, superAdmin, tenantLogin, tenantWithAdmin, uid,
} from './helpers';
import { seedWorkflowIsolation } from './workflow-helpers';
import { seedDocumentsIsolation } from './documents-helpers';
import { seedProcurementIsolationA } from './procurement-helpers';
import { seedTemplatesIsolation } from './templates-helpers';
import { seedReportsIsolation } from './reports-helpers';
import { seedNotifyIsolation } from './notify-helpers';
import { seedStockIsolation } from './stock-helpers';

type Row = Record<string, unknown>;

interface Side {
  tenantId: string;
  code: string;
  adminToken: string;
  adminId: string;
  userId: string;
  userEmail: string;
  userTempPassword: string;
  userVersion: number;
  roleId: string;
  notificationId: string;
  sessionId: string;
  userSessionCookie: string;
  // ---- Phase 2 permissions/locations (Permissions agent)
  locationId: string;
  locationVersion: number;
  // ---- Phase 2 (QA): master records + files by id
  itemId: string;
  uomId: string;
  fileId: string;
  // ---- Phase 3 (Workflow agent): workflow tables
  wfDocId: string;
  wfSpareDocTypeId: string;
  wfSpareLineId: string;
  // ---- Phase 3 (Documents agent): documents core tables
  docs: Awaited<ReturnType<typeof seedDocumentsIsolation>>;
  // ---- Phase 4 (Procurement agent A): indent + vendor_quote
  procA: Awaited<ReturnType<typeof seedProcurementIsolationA>>;
  // ---- Phase 7 (Reports agent): report_def, report_schedule, dashboard_def, export_job
  reports: Awaited<ReturnType<typeof seedReportsIsolation>>;
  // ---- Phase 6 (Notify agent): trigger_rule, outbound_message, webhook_endpoint, webhook_delivery
  notify: Awaited<ReturnType<typeof seedNotifyIsolation>>;
  // ---- Phase 5 (Stock agent): stock_batch, stock_movement, stock_balance, item_avg_cost, valuation_layer, reorder_rule
  stock: Awaited<ReturnType<typeof seedStockIsolation>>;
}

const appUserUrl = () => process.env.DATABASE_URL!; // app_user (NOBYPASSRLS)

/** Runs fn as app_user inside a transaction that is always rolled back, with optional tenant context. */
async function asAppUser<T>(pool: Pool, tenantId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** Runs one statement in its own savepoint so a failure doesn't poison the rest of the transaction. */
async function attempt(c: PoolClient, text: string, values: unknown[] = []): Promise<{ ok: true; rowCount: number } | { ok: false; code: string; message: string }> {
  await c.query('SAVEPOINT s');
  try {
    const r = await c.query(text, values);
    await c.query('RELEASE SAVEPOINT s');
    return { ok: true, rowCount: r.rowCount ?? 0 };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? '?', message: err.message ?? String(e) };
  }
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** Form & master engine tables: make a copied row insertable (unique keys, generated columns). */
function engineRow(tbl: string, row: Record<string, unknown>) {
  if (tbl === 'master_record') { delete row.search; row.code = `X-${uid()}`; }
  if (tbl === 'file_object') row.storage_key = `iso/${uid(16)}`;
  if (tbl === 'form_def') { row.key = `x_${uid(6)}`; row.current_version_id = null; }
  if (tbl === 'form_version') row.version = 1000 + Math.floor(Math.random() * 1e6);
  if (tbl === 'master_def') { row.key = `x_${uid(6)}`; row.form_id = null; }
  if (tbl === 'record_ref') row.from_id = crypto.randomUUID();
  // provisioning adds master tab rows; a copied tab row re-keyed as an action must not stay kind 'tab'
  if (tbl === 'permission_def' && row.kind === 'tab') row.kind = 'action';
  // master_def.form_id is unique per tenant: point the copy at the user form (a form without a master)
  if (tbl === 'master_def' && freeFormId) row.form_id = freeFormId;
  // ---- Phase 3 (Workflow agent): unique keys of workflow tables (+ the document rows the workflow seed creates)
  const spare = spares.get(String(row.tenant_id));
  if (tbl === 'workflow_def' && spare) row.doc_type_id = spare.docType;
  if (tbl === 'workflow_version') row.version = 1000 + Math.floor(Math.random() * 1e6);
  if (tbl === 'wf_instance') row.status = 'completed';
  if (tbl === 'wf_stage_state' || tbl === 'wf_line_state') row.stage_key = `x${uid(6)}`;
  if (tbl === 'wf_action' && row.idempotency_key) row.idempotency_key = `x-${uid()}`;
  if (tbl === 'doc_type') row.key = `x${uid(6)}`;
  if (tbl === 'document') row.number = null;
  if (tbl === 'document_line') row.line_no = 1000 + Math.floor(Math.random() * 1e6);
  if (tbl === 'line_qty_summary' && spare) row.line_id = spare.line;
  // ---- Phase 3 (Documents agent): unique keys of the documents tables
  if (tbl === 'numbering_series') row.is_active = false;
  if (tbl === 'numbering_counter') row.period = `x${uid(6)}`;
  // ---- Phase 6 (Templates agent): unique keys of message_template / generated_pdf
  if (tbl === 'message_template') { row.key = `x${uid(8)}`; row.is_default = false; }
  if (tbl === 'generated_pdf') row.document_version = 1000 + Math.floor(Math.random() * 1e6);
  // ---- Phase 4 (Procurement agent B): unique keys of document_revision / line_tax
  if (tbl === 'document_revision') row.rev_no = 1000 + Math.floor(Math.random() * 1e6);
  if (tbl === 'line_tax') row.component = row.component === 'igst' ? 'cess' : 'igst';
  // ---- Phase 7 (Reports agent): report_def key is unique per tenant
  if (tbl === 'report_def') row.key = `x${uid(8)}`;
  // ---- Phase 6 (Notify agent): unique idempotency key / (endpoint, outbox id)
  if (tbl === 'outbound_message') row.idempotency_key = `x-${uid(12)}`;
  if (tbl === 'webhook_delivery') row.outbox_id = 1e9 + Math.floor(Math.random() * 1e9);
  // ---- Phase 5 (Stock agent): unique keys of the stock tables (copies go to the parent location)
  if (tbl === 'stock_batch') row.batch_no = `X-${uid(8)}`;
  if (tbl === 'stock_movement' && row.idempotency_key) row.idempotency_key = `x-${uid(12)}`;
  if (tbl === 'stock_balance') row.batch_key = crypto.randomUUID();
  const stockSpare = stockSpares.get(String(row.tenant_id));
  if ((tbl === 'item_avg_cost' || tbl === 'reorder_rule') && stockSpare) row.node_id = stockSpare;
}
/** Per tenant (Phase 5): a location without stock rows, target node of the item_avg_cost / reorder_rule copies. */
const stockSpares = new Map<string, string>();
/** Per tenant: a doc type without workflow and a line without summary, targets for the insert-control copies. */
const spares = new Map<string, { docType: string; line: string }>();
let freeFormId: string | null = null;

describe('tenancy isolation (generated)', () => {
  let c: Ctx;
  let owner: string;
  let appPool: Pool;
  let A: Side;
  let B: Side;
  let appTables: string[] = [];
  let platformRelations: string[] = [];

  async function seedSide(): Promise<Side> {
    // max_users 3 → creating the 2nd and 3rd user crosses 80% and 100% → limit_warning notifications.
    const { tenant, admin } = await tenantWithAdmin(c, owner, { limits: { max_users: 3, max_locations: 10 } });
    const role = await c.http.post(`${API}/roles`).set(bearer(admin.token)).send({ key: `qa_${uid(6)}`, name: 'QA role' });
    expect(role.status).toBe(201);
    const u = await createUser(c, admin.token, { roleIds: [role.body.id] });
    expect(u.status).toBe(201);
    expect((await createUser(c, admin.token)).status).toBe(201);
    const userLogin = await tenantLogin(c, tenant.code, u.body.user.email, u.body.temporaryPassword);
    const notes = await c.http.get(`${API}/notifications`).set(bearer(admin.token));
    expect(notes.body.data.length).toBeGreaterThan(0);
    const sessions = await c.http.get(`${API}/auth/sessions`).set(bearer(admin.token));
    // Tenant setting + permission grant have no Phase 1 API → insert as the DB owner.
    await c.db.insertInto('app.tenant_setting').values({ tenant_id: tenant.tenantId, key: 'security.lockout_minutes', value: JSON.stringify(15) }).execute();
    await c.db.insertInto('app.permission_grant').values({ tenant_id: tenant.tenantId, role_id: role.body.id, perm_key: 'qa.read', effect: 'allow' }).execute();
    // ---- Phase 2 (Permissions agent): location_node + scope_grant via the API; permission_def/field_access as owner.
    const loc = await c.http.post(`${API}/locations`).set(bearer(admin.token)).send({ code: `ISO-${uid(6)}`, name: 'Iso plant' });
    expect(loc.status).toBe(201);
    const child = await c.http.post(`${API}/locations`).set(bearer(admin.token)).send({ parentId: loc.body.id, code: `ISO-${uid(6)}`, name: 'Iso store' });
    expect(child.status).toBe(201);
    const sc = await c.http.put(`${API}/roles/${role.body.id}/scope`).set(bearer(admin.token)).send({ entries: [{ nodeId: loc.body.id }] });
    expect(sc.status).toBe(200);
    await c.db.insertInto('app.permission_def').values({ tenant_id: tenant.tenantId, key: `qa.tab:action.read`, kind: 'action', tab_key: 'qa.tab', label: 'QA', source: 'report', sort_order: 0 }).execute();
    await c.db.insertInto('app.field_access').values({ tenant_id: tenant.tenantId, form_key: 'qa', field_key: 'f1', role_id: role.body.id, mode: 'hidden' }).execute();
    // ---- end Phase 2 (Permissions agent)
    // ---- Phase 2 (Form & master engine): form_def/form_version/master_def come from provisioning; master_record +
    // record_ref via the API (item -> uom lookup); file_object as owner (bytes are irrelevant to isolation).
    const uom = await c.http.post(`${API}/masters/uom/records`).set(bearer(admin.token)).send({ code: `U${uid(4)}`, name: 'Iso unit', data: { decimals: '0' } });
    expect(uom.status).toBe(201);
    const item = await c.http.post(`${API}/masters/item/records`).set(bearer(admin.token)).send({ name: 'Iso item', data: { uom: uom.body.id } });
    expect(item.status).toBe(201);
    const fileRow = await c.db.insertInto('app.file_object').values({
      tenant_id: tenant.tenantId, storage_key: `${tenant.tenantId}/iso/${uid(12)}.txt`, filename: 'iso.txt', mime: 'text/plain', size_bytes: 3, sha256: 'x',
    }).returning('id').executeTakeFirstOrThrow();
    // ---- end Phase 2 (Form & master engine)
    // ---- Phase 3 (Workflow agent): workflow_def/version, wf_instance/stage/line state, wf_action, wf_assignment
    const wfSeed = await seedWorkflowIsolation(c, { tenantId: tenant.tenantId, adminId: admin.userId, locationId: loc.body.id, userId: u.body.user.id });
    spares.set(tenant.tenantId, { docType: wfSeed.spareDocTypeId, line: wfSeed.spareLineId });
    // ---- end Phase 3 (Workflow agent)
    // ---- Phase 3 (Documents agent): doc type/numbering (service), documents, ledger, comment, attachment, saved view,
    // outbox via the API; line_link as owner.
    const docs = await seedDocumentsIsolation(c, { tenantId: tenant.tenantId, adminId: admin.userId, adminToken: admin.token, locationId: child.body.id, itemId: item.body.id });
    // ---- end Phase 3 (Documents agent)
    // ---- Phase 4 (Procurement agent A): draft indent + vendor via the API, vendor_quote as owner
    const procA = await seedProcurementIsolationA(c, { tenantId: tenant.tenantId, adminId: admin.userId, adminToken: admin.token, locationId: child.body.id, itemId: item.body.id });
    // ---- end Phase 4 (Procurement agent A)
    // ---- Phase 4 (Procurement agent B): po_followup, document_revision, line_tax as owner on the documents seed's doc
    await c.db.insertInto('app.po_followup').values({ tenant_id: tenant.tenantId, document_id: docs.docId, line_id: docs.lineId, contact_mode: 'call', created_by: admin.userId }).execute();
    await c.db.insertInto('app.document_revision').values({ tenant_id: tenant.tenantId, document_id: docs.docId, rev_no: 0, snapshot: JSON.stringify({ iso: true }), status: 'approved', created_by: admin.userId }).execute();
    await c.db.insertInto('app.line_tax').values({ tenant_id: tenant.tenantId, line_id: docs.lineId, document_id: docs.docId, component: 'igst', rate_pct: '18', taxable_amount: '20', tax_amount: '3.6' }).execute();
    // ---- end Phase 4 (Procurement agent B)
    // ---- Phase 6 (Templates agent): starter templates (provisioning) + a generated_pdf row as owner
    await seedTemplatesIsolation(c, { tenantId: tenant.tenantId, documentId: wfSeed.docId });
    // ---- end Phase 6 (Templates agent)
    // ---- Phase 7 (Reports agent): reports tables as owner (the isolation plan has no reports feature)
    const reports = await seedReportsIsolation(c, { tenantId: tenant.tenantId, adminId: admin.userId });
    // ---- end Phase 7 (Reports agent)
    // ---- Phase 6 (Notify agent): notify tables as owner on the workflow seed's document
    const notify = await seedNotifyIsolation(c, { tenantId: tenant.tenantId, documentId: wfSeed.docId });
    // ---- end Phase 6 (Notify agent)
    // ---- Phase 5 (Stock agent): the six 0015 tables as owner (stock at the child node; copies use the parent)
    const stock = await seedStockIsolation(c, { tenantId: tenant.tenantId, adminId: admin.userId, itemId: item.body.id, nodeId: child.body.id });
    stockSpares.set(tenant.tenantId, loc.body.id);
    // ---- end Phase 5 (Stock agent)
    return {
      tenantId: tenant.tenantId, code: tenant.code, adminToken: admin.token, adminId: admin.userId,
      userId: u.body.user.id, userEmail: u.body.user.email, userTempPassword: u.body.temporaryPassword, userVersion: u.body.user.version,
      roleId: role.body.id, notificationId: notes.body.data[0].id, sessionId: sessions.body[0].id, userSessionCookie: userLogin.cookie,
      locationId: child.body.id, locationVersion: child.body.version,
      itemId: item.body.id, uomId: uom.body.id, fileId: fileRow.id,
      wfDocId: wfSeed.docId, wfSpareDocTypeId: wfSeed.spareDocTypeId, wfSpareLineId: wfSeed.spareLineId,
      docs,
      procA,
      reports,
      notify,
      stock,
    };
  }

  beforeAll(async () => {
    c = await bootApp();
    owner = (await superAdmin(c)).token;
    appPool = new Pool({ connectionString: appUserUrl(), max: 2 });
    A = await seedSide();
    B = await seedSide();
    freeFormId = (await c.db.selectFrom('app.form_def').select('id').where('tenant_id', '=', A.tenantId).where('key', '=', 'user').executeTakeFirstOrThrow()).id;
    const t = await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = 'app' and table_type = 'BASE TABLE' order by table_name`.execute(c.db);
    appTables = t.rows.map(r => r.table_name);
    const p = await sql<{ table_name: string }>`
      select table_name from information_schema.tables where table_schema = 'platform' order by table_name`.execute(c.db);
    platformRelations = p.rows.map(r => r.table_name);
  });

  afterAll(async () => {
    await appPool?.end();
    await closeApp(c);
  });

  it('discovers the Phase 1 app tables (sanity: discovery works)', () => {
    expect(appTables).toEqual(expect.arrayContaining([
      'audit_log', 'notification', 'permission_grant', 'role', 'tenant_setting', 'tenant_user', 'user_role',
    ]));
    expect(platformRelations.length).toBeGreaterThan(5);
  });

  // ------------------------------------------------------------------ DB level, per table

  describe('DB level: every app.* table', () => {
    // Table names are only known at runtime, so each check loops over all of them and reports every offender.

    it('has tenant_id, RLS enabled + forced, and a tenant_isolation policy', async () => {
      const bad: string[] = [];
      for (const tbl of appTables) {
        const r = await sql<{ rls: boolean; force: boolean; has_col: boolean; has_policy: boolean }>`
          select cl.relrowsecurity as rls, cl.relforcerowsecurity as force,
            exists (select 1 from information_schema.columns where table_schema='app' and table_name=${tbl} and column_name='tenant_id') as has_col,
            exists (select 1 from pg_policies where schemaname='app' and tablename=${tbl} and policyname='tenant_isolation') as has_policy
          from pg_class cl join pg_namespace n on n.oid = cl.relnamespace where n.nspname='app' and cl.relname=${tbl}`.execute(c.db);
        const x = r.rows[0]!;
        if (!x.rls || !x.force || !x.has_col || !x.has_policy) bad.push(`${tbl}: ${JSON.stringify(x)}`);
      }
      expect(bad).toEqual([]);
    });

    it('has seed rows for both tenants (extend seedSide() when adding a table)', async () => {
      const missing: string[] = [];
      for (const tbl of appTables) {
        for (const s of [A, B]) {
          const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(`app.${tbl}`)} where tenant_id = ${s.tenantId}`.execute(c.db);
          if (Number(r.rows[0]!.n) === 0) missing.push(`${tbl} (${s === A ? 'A' : 'B'})`);
        }
      }
      expect(missing, 'tables without seed rows cannot prove isolation').toEqual([]);
    });

    it('context A sees its own rows and zero rows of B', async () => {
      const leaks: string[] = [];
      const blind: string[] = [];
      await asAppUser(appPool, A.tenantId, async cl => {
        for (const tbl of appTables) {
          const r = await cl.query(`select tenant_id::text as t, count(*)::int as n from app.${q(tbl)} group by tenant_id`);
          const byTenant = Object.fromEntries(r.rows.map((x: Row) => [x.t, x.n]));
          const others = Object.keys(byTenant).filter(t => t !== A.tenantId);
          if (others.length) leaks.push(`${tbl}: sees ${others.join(',')}`);
          if (!byTenant[A.tenantId]) blind.push(tbl);
          // Explicitly asking for B by id/tenant still returns nothing.
          const direct = await cl.query(`select count(*)::int as n from app.${q(tbl)} where tenant_id = $1`, [B.tenantId]);
          if (direct.rows[0].n !== 0) leaks.push(`${tbl}: where tenant_id=B returned ${direct.rows[0].n}`);
        }
      });
      expect(leaks).toEqual([]);
      expect(blind, 'context A should see its own rows').toEqual([]);
    });

    it('no tenant context → zero rows in every table', async () => {
      const leaks: string[] = [];
      await asAppUser(appPool, null, async cl => {
        for (const tbl of appTables) {
          const r = await cl.query(`select count(*)::int as n from app.${q(tbl)}`);
          if (r.rows[0].n !== 0) leaks.push(`${tbl}: ${r.rows[0].n}`);
        }
      });
      expect(leaks).toEqual([]);
    });

    it('empty-string tenant context behaves like no context (zero rows)', async () => {
      const leaks: string[] = [];
      await asAppUser(appPool, null, async cl => {
        await cl.query(`select set_config('app.tenant_id', '', true)`);
        for (const tbl of appTables) {
          const r = await cl.query(`select count(*)::int as n from app.${q(tbl)}`);
          if (r.rows[0].n !== 0) leaks.push(`${tbl}: ${r.rows[0].n}`);
        }
      });
      expect(leaks).toEqual([]);
    });

    it('under context A, inserting a row with B\'s tenant_id fails (RLS WITH CHECK)', async () => {
      const allowed: string[] = [];
      for (const tbl of appTables) {
        // Template = one of A's own rows (read as owner), re-homed to B, with a fresh id where there is one.
        const tmpl = await sql<{ j: Row }>`select to_jsonb(t) as j from ${sql.table(`app.${tbl}`)} t where tenant_id = ${A.tenantId} limit 1`.execute(c.db);
        const row = { ...tmpl.rows[0]!.j };
        row.tenant_id = B.tenantId;
        if (typeof row.id === 'string') row.id = crypto.randomUUID();
        if (typeof row.id === 'number') delete row.id;
        if (typeof row.key === 'string' && tbl === 'role') row.key = `x_${uid(6)}`;
        if (typeof row.email === 'string') row.email = `x-${uid()}@iso.test`;
        if (tbl === 'tenant_setting') row.key = `qa.${uid()}`;
        engineRow(tbl, row);
        const cols = Object.keys(row);
        const text = `insert into app.${q(tbl)} (${cols.map(q).join(',')})
          select ${cols.map(q).join(',')} from jsonb_populate_record(null::app.${q(tbl)}, $1::jsonb)`;
        await asAppUser(appPool, A.tenantId, async cl => {
          const r = await attempt(cl, text, [JSON.stringify(row)]);
          if (r.ok) allowed.push(`${tbl}: inserted ${r.rowCount}`);
          else if (r.code !== '42501') allowed.push(`${tbl}: failed for the wrong reason ${r.code} ${r.message}`);
        });
      }
      expect(allowed).toEqual([]);
    });

    it('under context A, the same insert with A\'s tenant_id is accepted (control for the test above)', async () => {
      // Proves the insert statement itself is valid, so the failure above is RLS and nothing else.
      const failures: string[] = [];
      for (const tbl of appTables) {
        if (tbl === 'audit_log') continue; // append-only + hash chain; insert works but is not worth polluting
        const tmpl = await sql<{ j: Row }>`select to_jsonb(t) as j from ${sql.table(`app.${tbl}`)} t where tenant_id = ${A.tenantId} limit 1`.execute(c.db);
        const row = { ...tmpl.rows[0]!.j };
        if (typeof row.id === 'string') row.id = crypto.randomUUID();
        if (typeof row.id === 'number') delete row.id;
        if (tbl === 'role') row.key = `x_${uid(6)}`;
        if (typeof row.email === 'string') row.email = `x-${uid()}@iso.test`;
        if (tbl === 'tenant_setting') row.key = `qa.${uid()}`;
        if (tbl === 'permission_grant') row.perm_key = `qa.${uid()}`;
        if (tbl === 'location_node') row.code = `X-${uid()}`;
        if (tbl === 'field_access') row.field_key = `f_${uid()}`;
        if (tbl === 'permission_def') row.key = `qa.${uid()}:action.read`;
        engineRow(tbl, row);
        if (tbl === 'user_role') {
          const r2 = await c.http.post(`${API}/roles`).set(bearer(A.adminToken)).send({ key: `ctl_${uid(6)}`, name: 'Control' });
          row.role_id = r2.body.id;
        }
        const cols = Object.keys(row);
        const text = `insert into app.${q(tbl)} (${cols.map(q).join(',')})
          select ${cols.map(q).join(',')} from jsonb_populate_record(null::app.${q(tbl)}, $1::jsonb)`;
        await asAppUser(appPool, A.tenantId, async cl => {
          const r = await attempt(cl, text, [JSON.stringify(row)]);
          if (!r.ok) failures.push(`${tbl}: ${r.code} ${r.message}`);
        });
      }
      expect(failures).toEqual([]);
    });

    it('under context A, moving A\'s rows to B\'s tenant_id fails; UPDATE/DELETE of B rows touch nothing', async () => {
      const problems: string[] = [];
      for (const tbl of appTables) {
        await asAppUser(appPool, A.tenantId, async cl => {
          const move = await attempt(cl, `update app.${q(tbl)} set tenant_id = $1 where tenant_id = $2`, [B.tenantId, A.tenantId]);
          // 42501 = RLS violation (or, for append-only audit_log, no UPDATE privilege at all) — both are fine.
          if (move.ok) problems.push(`${tbl}: re-homed ${move.rowCount} rows to B`);
          else if (move.code !== '42501') problems.push(`${tbl}: move failed for the wrong reason ${move.code} ${move.message}`);

          const upd = await attempt(cl, `update app.${q(tbl)} set tenant_id = tenant_id where tenant_id = $1`, [B.tenantId]);
          if (upd.ok && upd.rowCount !== 0) problems.push(`${tbl}: updated ${upd.rowCount} B rows`);
          const del = await attempt(cl, `delete from app.${q(tbl)} where tenant_id = $1`, [B.tenantId]);
          if (del.ok && del.rowCount !== 0) problems.push(`${tbl}: deleted ${del.rowCount} B rows`);
        });
      }
      expect(problems).toEqual([]);
      // And B's rows are all still there.
      for (const tbl of appTables) {
        const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(`app.${tbl}`)} where tenant_id = ${B.tenantId}`.execute(c.db);
        expect(Number(r.rows[0]!.n), tbl).toBeGreaterThan(0);
      }
    });

    it('app_user cannot select from any platform.* table or view', async () => {
      const readable: string[] = [];
      for (const rel of platformRelations) {
        await asAppUser(appPool, A.tenantId, async cl => {
          const r = await attempt(cl, `select 1 from platform.${q(rel)} limit 1`);
          if (r.ok) readable.push(rel);
          else if (r.code !== '42501') readable.push(`${rel}: unexpected ${r.code} ${r.message}`);
        });
      }
      expect(readable).toEqual([]);
    });

    it('app_user cannot call platform.* functions that take a tenant argument', async () => {
      await asAppUser(appPool, A.tenantId, async cl => {
        const f = await attempt(cl, `select * from platform.effective_features($1::uuid)`, [B.tenantId]);
        expect(f.ok).toBe(false);
        const l = await attempt(cl, `select platform.effective_limit('max_users', $1::uuid)`, [B.tenantId]);
        expect(l.ok).toBe(false);
      });
    });

    it('SECURITY DEFINER helpers only answer for the tenant in context', async () => {
      // Make A and B differ: B gets a max_users override.
      await c.http.put(`${API}/platform/tenants/${B.tenantId}/overrides`).set(bearer(owner)).send({ kind: 'limit', key: 'max_users', value: 7, reason: 'iso test' });
      await asAppUser(appPool, A.tenantId, async cl => {
        expect((await cl.query(`select app.my_limit('max_users')::int as v`)).rows[0].v).toBe(3);
      });
      await asAppUser(appPool, B.tenantId, async cl => {
        expect((await cl.query(`select app.my_limit('max_users')::int as v`)).rows[0].v).toBe(7);
      });
      await asAppUser(appPool, null, async cl => {
        expect((await cl.query(`select count(*)::int as n from app.my_features()`)).rows[0].n).toBe(0);
        const st = await cl.query(`select count(*)::int as n from app.my_tenant_state()`);
        expect(st.rows[0].n).toBe(0);
        const qn = await attempt(cl, `select * from app.consume_quota('whatsapp_per_month', 1, '2026-01')`);
        expect(qn.ok).toBe(false);
      });
    });
  });

  // ------------------------------------------------------------------ API level

  describe('API level: tenant A admin with tenant B ids → 404', () => {
    type Route = { method: 'get' | 'put' | 'post' | 'delete'; path: (b: Side) => string; body?: (b: Side) => object };
    // Every Phase 1 tenant route that addresses a record by id (docs/contracts/phase-1-api.md).
    const routes: Route[] = [
      { method: 'get', path: b => `/users/${b.userId}` },
      { method: 'put', path: b => `/users/${b.userId}`, body: b => ({ name: 'Hijacked', version: b.userVersion }) },
      { method: 'post', path: b => `/users/${b.userId}/deactivate` },
      { method: 'post', path: b => `/users/${b.userId}/activate` },
      { method: 'post', path: b => `/users/${b.userId}/reset-password` },
      { method: 'post', path: b => `/users/${b.userId}/unlock` },
      { method: 'get', path: b => `/users/${b.userId}/sessions` },
      { method: 'post', path: b => `/users/${b.userId}/force-logout` },
      // B's admin id too (a different kind of target: an admin).
      { method: 'get', path: b => `/users/${b.adminId}` },
      { method: 'post', path: b => `/users/${b.adminId}/deactivate` },
      { method: 'post', path: b => `/notifications/${b.notificationId}/read` },
      // Phase 2 (Permissions agent): permissions, roles, locations by id.
      { method: 'get', path: b => `/roles/${b.roleId}/permissions` },
      { method: 'put', path: b => `/roles/${b.roleId}/permissions/tabs/admin.users`, body: () => ({ actions: ['admin.users:action.view'] }) },
      { method: 'put', path: b => `/roles/${b.roleId}/scope`, body: () => ({ entries: [{ allNodes: true }] }) },
      { method: 'put', path: b => `/roles/${b.roleId}`, body: () => ({ key: 'hijack', name: 'Hijacked', version: 1 }) },
      { method: 'delete', path: b => `/roles/${b.roleId}` },
      { method: 'get', path: b => `/users/${b.userId}/permissions` },
      { method: 'put', path: b => `/users/${b.userId}/permissions/tabs/admin.users`, body: () => ({ allow: ['admin.users:action.view'] }) },
      { method: 'put', path: b => `/users/${b.userId}/scope`, body: () => ({ entries: [{ allNodes: true }] }) },
      { method: 'put', path: b => `/users/${b.userId}/roles`, body: () => ({ roleIds: [] }) },
      { method: 'get', path: b => `/users/${b.userId}/effective-permissions` },
      { method: 'get', path: b => `/locations/${b.locationId}` },
      { method: 'put', path: b => `/locations/${b.locationId}`, body: b => ({ name: 'Hijacked', version: b.locationVersion }) },
      { method: 'post', path: b => `/locations/${b.locationId}/move`, body: b => ({ parentId: null, version: b.locationVersion }) },
      { method: 'post', path: b => `/locations/${b.locationId}/deactivate` },
      { method: 'post', path: b => `/locations/${b.locationId}/activate` },
      { method: 'delete', path: b => `/locations/${b.locationId}` },
      { method: 'delete', path: b => `/auth/sessions/${b.sessionId}` },
      // Phase 2 (QA): master records (same master key in both tenants) and files by id.
      { method: 'get', path: b => `/masters/item/records/${b.itemId}` },
      { method: 'put', path: b => `/masters/item/records/${b.itemId}`, body: () => ({ name: 'Hijacked', data: {}, version: 1 }) },
      { method: 'post', path: b => `/masters/item/records/${b.itemId}/deactivate` },
      { method: 'post', path: b => `/masters/item/records/${b.itemId}/activate` },
      { method: 'delete', path: b => `/masters/item/records/${b.itemId}`, body: () => ({ reason: 'hijack' }) },
      { method: 'get', path: b => `/masters/item/records/${b.itemId}/usage` },
      { method: 'get', path: b => `/masters/uom/records/${b.uomId}` },
      { method: 'delete', path: b => `/masters/uom/records/${b.uomId}`, body: () => ({ reason: 'hijack' }) },
      { method: 'get', path: b => `/files/${b.fileId}` },
      // Phase 3 (Workflow agent): workflow action on B's document (same doc type key exists in A)
      { method: 'post', path: b => `/docs/wfiso/${b.wfDocId}/actions`, body: () => ({ action: 'decide', stageKey: 's1', outcome: 'approve' }) },
      { method: 'post', path: b => `/docs/wfiso/${b.wfDocId}/actions`, body: () => ({ action: 'unhold', stageKey: 's1', lineIds: [crypto.randomUUID()] }) },
      // Phase 3 (Documents agent): documents, collaboration, numbering and saved views by id (same type key in A)
      { method: 'get', path: b => `/docs/isodoc/${b.docs.docId}` },
      { method: 'put', path: b => `/docs/isodoc/${b.docs.draftId}`, body: b => ({ version: b.docs.draftVersion, values: {}, lines: [] }) },
      { method: 'delete', path: b => `/docs/isodoc/${b.docs.draftId}` },
      { method: 'post', path: b => `/docs/isodoc/${b.docs.draftId}/submit`, body: b => ({ version: b.docs.draftVersion }) },
      { method: 'post', path: b => `/docs/isodoc/${b.docs.docId}/cancel`, body: () => ({ reason: 'hijack' }) },
      { method: 'post', path: b => `/docs/isodoc/${b.docs.docId}/cancel`, body: b => ({ reason: 'hijack', lineIds: [b.docs.lineId] }) },
      { method: 'post', path: b => `/docs/isodoc/${b.docs.docId}/close`, body: () => ({ reason: 'hijack' }) },
      { method: 'post', path: b => `/docs/isodoc/${b.docs.docId}/copy` },
      { method: 'get', path: b => `/docs/isodoc/${b.docs.docId}/timeline` },
      { method: 'get', path: b => `/docs/isodoc/${b.docs.docId}/comments` },
      { method: 'post', path: b => `/docs/isodoc/${b.docs.docId}/comments`, body: () => ({ body: 'hijack' }) },
      { method: 'put', path: b => `/docs/isodoc/${b.docs.docId}/comments/${b.docs.commentId}`, body: () => ({ body: 'hijack' }) },
      { method: 'delete', path: b => `/docs/isodoc/${b.docs.docId}/comments/${b.docs.commentId}` },
      { method: 'get', path: b => `/docs/isodoc/${b.docs.docId}/attachments` },
      { method: 'post', path: b => `/docs/isodoc/${b.docs.docId}/attachments`, body: b => ({ fileId: b.fileId }) },
      { method: 'delete', path: b => `/docs/isodoc/${b.docs.docId}/attachments/${b.docs.attachmentId}` },
      { method: 'put', path: b => `/config/numbering/${b.docs.seriesId}`, body: b => ({ docTypeKey: 'isodoc', name: 'Hijacked', pattern: 'H-{SEQ:3}', version: b.docs.seriesVersion }) },
      { method: 'get', path: b => `/config/numbering/${b.docs.seriesId}/preview` },
      { method: 'put', path: b => `/saved-views/${b.docs.viewId}`, body: b => ({ scopeKey: 'doc.isodoc:document', name: 'Hijacked', config: { filters: {} }, version: b.docs.viewVersion }) },
      { method: 'delete', path: b => `/saved-views/${b.docs.viewId}` },
      // Phase 4 (Procurement agent A): quotes / comparison / short-close on B's indent (same type key in A)
      { method: 'get', path: b => `/procurement/indent-lines/${b.procA.indentLineId}/quotes?all=true` },
      { method: 'get', path: b => `/docs/indent/${b.procA.indentId}` },
      { method: 'post', path: b => `/docs/indent/${b.procA.indentId}/short-close`, body: () => ({ reason: 'hijack' }) },
      // Phase 6 (Notify agent): trigger rules, message retry, per-document messages / manual send (same type key in A)
      { method: 'get', path: b => `/config/triggers/${b.notify.ruleId}` },
      { method: 'put', path: b => `/config/triggers/${b.notify.ruleId}`, body: b => ({ name: 'Hijacked', eventType: 'document.submitted', channel: 'inapp', templateId: b.notify.templateId, recipients: [{ type: 'users', userIds: [b.adminId] }], version: b.notify.ruleVersion }) },
      { method: 'delete', path: b => `/config/triggers/${b.notify.ruleId}` },
      { method: 'post', path: b => `/messages/${b.notify.messageId}/retry` },
      { method: 'get', path: b => `/docs/wfiso/${b.wfDocId}/messages` },
      { method: 'get', path: b => `/docs/wfiso/${b.wfDocId}/send/suggestions` },
      { method: 'post', path: b => `/docs/wfiso/${b.wfDocId}/send/preview`, body: b => ({ channel: 'email', templateId: b.notify.templateId, recipients: ['x@y.test'] }) },
      { method: 'post', path: b => `/docs/wfiso/${b.wfDocId}/send`, body: b => ({ channel: 'email', templateId: b.notify.templateId, recipients: ['x@y.test'], idempotencyKey: 'hijack-key-1' }) },
    ];

    async function snapshotB() {
      const u = await c.http.get(`${API}/users/${B.userId}`).set(bearer(B.adminToken));
      const adm = await c.http.get(`${API}/users/${B.adminId}`).set(bearer(B.adminToken));
      const n = await c.http.get(`${API}/notifications`).query({ limit: 100 }).set(bearer(B.adminToken));
      const s = await c.http.get(`${API}/auth/sessions`).set(bearer(B.adminToken));
      return {
        user: { name: u.body.name, isActive: u.body.isActive, version: u.body.version, lockedUntil: u.body.lockedUntil },
        admin: { isActive: adm.body.isActive, version: adm.body.version },
        note: n.body.data.find((x: { id: string }) => x.id === B.notificationId)?.readAt ?? null,
        sessions: s.body.map((x: { id: string }) => x.id).sort(),
        // Phase 3 (Documents agent): B's documents, comments, attachments, numbering and views are untouched
        docs: await (async () => {
          const g = (p: string) => c.http.get(`${API}${p}`).set(bearer(B.adminToken)).then(r => r.body);
          const [doc, draft, comments, atts, series, views] = await Promise.all([
            g(`/docs/isodoc/${B.docs.docId}`), g(`/docs/isodoc/${B.docs.draftId}`), g(`/docs/isodoc/${B.docs.docId}/comments`),
            g(`/docs/isodoc/${B.docs.docId}/attachments`), g('/config/numbering?docType=isodoc'), g('/saved-views'),
          ]);
          return {
            doc: [doc.version, doc.statusKey], draft: [draft.version, draft.statusKey], comments: comments.map((x: { body: string }) => x.body),
            atts: atts.map((x: { id: string }) => x.id), series: series.map((x: { pattern: string; version: number }) => [x.pattern, x.version]),
            views: views.map((x: { name: string; version: number }) => [x.name, x.version]),
          };
        })(),
      };
    }

    for (const viaImpersonation of [false, true]) {
      it(`every by-id route answers 404 with no B data${viaImpersonation ? ' (impersonated A admin)' : ''}`, async () => {
        let token = A.adminToken;
        if (viaImpersonation) {
          const imp = await c.http.post(`${API}/platform/tenants/${A.tenantId}/impersonate`).set(bearer(owner)).send({ reason: 'iso test' });
          expect(imp.status).toBe(200);
          token = imp.body.accessToken;
        }
        const before = await snapshotB();
        const wrong: string[] = [];
        for (const r of routes) {
          const path = r.path(B);
          let req = c.http[r.method](`${API}${path}`).set(bearer(token));
          if (r.body) req = req.send(r.body(B));
          const res = await req;
          const text = JSON.stringify(res.body ?? '');
          if (res.status !== 404 || res.body.code !== 'NOT_FOUND') wrong.push(`${r.method.toUpperCase()} ${path} → ${res.status} ${res.body?.code}`);
          if (text.includes(B.userEmail) || text.includes(B.tenantId)) wrong.push(`${r.method.toUpperCase()} ${path} leaks B data: ${text.slice(0, 200)}`);
        }
        expect(wrong).toEqual([]);
        // B is untouched: same versions, still active, notification unread, sessions intact, user can still refresh.
        expect(await snapshotB()).toEqual(before);
        expect((await c.http.get(`${API}/auth/me`).set(bearer(B.adminToken))).status).toBe(200);
      });
    }

    it('B user can still sign in with the original temp password (reset-password from A had no effect)', async () => {
      const r = await c.http.post(`${API}/auth/login`).send({ tenantCode: B.code, email: B.userEmail, password: B.userTempPassword });
      expect(r.status).toBe(200);
    });

    it('A cannot assign B\'s role or B\'s user as manager (ids from another tenant are invalid references)', async () => {
      // (A is at its 3-user cap, so use PUT on an existing A user; create would hit the limit first.)
      const cur = await c.http.get(`${API}/users/${A.userId}`).set(bearer(A.adminToken));
      const put = await c.http.put(`${API}/users/${A.userId}`).set(bearer(A.adminToken)).send({ roleIds: [B.roleId], version: cur.body.version });
      expect(put.status).toBe(400);
      const mgr = await c.http.put(`${API}/users/${A.userId}`).set(bearer(A.adminToken)).send({ reportingManagerId: B.userId, version: cur.body.version });
      expect(mgr.status).toBe(400);
      const after = await c.http.get(`${API}/users/${A.userId}`).set(bearer(A.adminToken));
      expect(after.body.version).toBe(cur.body.version);
      expect(after.body.roles.map((r: { id: string }) => r.id)).not.toContain(B.roleId);
    });

    it('A\'s lists never contain B records', async () => {
      const users = await c.http.get(`${API}/users`).query({ limit: 200 }).set(bearer(A.adminToken));
      const roles = await c.http.get(`${API}/roles`).set(bearer(A.adminToken));
      const notes = await c.http.get(`${API}/notifications`).query({ limit: 100 }).set(bearer(A.adminToken));
      const sess = await c.http.get(`${API}/auth/sessions`).set(bearer(A.adminToken));
      const all = JSON.stringify([users.body, roles.body, notes.body, sess.body]);
      for (const id of [B.userId, B.adminId, B.roleId, B.notificationId, B.sessionId, B.userEmail]) expect(all).not.toContain(id);
      const usage = await c.http.get(`${API}/tenant/usage`).set(bearer(A.adminToken));
      expect(usage.body.limits.find((l: { key: string }) => l.key === 'max_users').effective).toBe(3);
    });

    it('a tenant token cannot reach B through /platform/* (403 by audience, never data)', async () => {
      for (const p of [`/platform/tenants/${B.tenantId}`, `/platform/tenants/${B.tenantId}/overrides/history`, `/platform/tenants/${B.tenantId}/subscriptions`]) {
        const r = await c.http.get(`${API}${p}`).set(bearer(A.adminToken));
        expect(r.status, p).toBe(403);
        expect(JSON.stringify(r.body)).not.toContain(B.code);
      }
    });

    it('a refresh cookie is not bound to a tenant code: B\'s user cookie refreshes into B only', async () => {
      const r = await c.http.post(`${API}/auth/refresh`).set('Cookie', B.userSessionCookie);
      expect(r.status).toBe(200);
      expect(r.body.principal.tenantId).toBe(B.tenantId);
    });
  });
});
