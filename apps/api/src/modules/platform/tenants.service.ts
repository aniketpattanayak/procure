import { Injectable, Logger } from '@nestjs/common';
import {
  AuthResult, Entitlements, ErrorCode, ListQuery, OverrideSet, Principal, SubscriptionChange, TenantCreate, TenantCreated,
  TenantStatusChange, TenantUpdate,
} from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { invalidatePrincipal } from '../../core/auth/auth.guard';
import { DbService, Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { AppError } from '../../core/errors';
import { RedisService } from '../../core/redis.service';
import {
  AuthService, decodeCursor, generateTempPassword, hashPassword, likePattern, SessionsService, TenantEntitlementsService, toIso, toPage,
} from '../identity';
import { TemplateInstaller } from '../forms';
import { ProcurementInstaller } from '../procurement';
import { TemplatesInstaller } from '../templates';
import { toDate, toSubscription, toTenant, TenantDto } from './mappers';

export const TenantListQuery = ListQuery.extend({ status: z.enum(['active', 'suspended', 'archived']).optional() });
export const AuditListQuery = ListQuery.extend({ tenantId: z.string().uuid().optional() });

export interface TenantListRow {
  id: string; code: string; name: string; status: string; planName: string | null; subscriptionStatus: string | null;
  renewalDate: string | null; activeUsers: number; maxUsers: number | null; createdAt: string;
}

type PlatformPrincipal = Extract<Principal, { kind: 'platform' }>;

/** Impersonation sessions are short and cannot be refreshed past this. */
const IMPERSONATION_MINUTES = 60;

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

@Injectable()
export class TenantsService {
  private readonly log = new Logger('Tenants');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly ent: EntitlementsService,
    private readonly tenantEnt: TenantEntitlementsService,
    private readonly sessions: SessionsService,
    private readonly auth: AuthService,
    private readonly redis: RedisService,
    private readonly templates: TemplateInstaller,
    private readonly procurement: ProcurementInstaller,
    private readonly messageTemplates: TemplatesInstaller,
  ) {}

  // ------------------------------------------------------------------ list / get
  async list(q: z.infer<typeof TenantListQuery>) {
    const cur = decodeCursor(q.cursor);
    let qb = this.db.platform.selectFrom('platform.tenant as t')
      .leftJoin('platform.subscription as s', j => j.onRef('s.tenant_id', '=', 't.id').on('s.effective_to', 'is', null))
      .leftJoin('platform.plan as p', 'p.id', 's.plan_id')
      .select(['t.id', 't.code', 't.name', 't.status', 't.created_at', 'p.name as plan_name', 's.status as sub_status', 's.renewal_date'])
      .select(eb => [
        eb.selectFrom('app.tenant_user as u').select(e => e.fn.countAll<string>().as('n'))
          .whereRef('u.tenant_id', '=', 't.id').where('u.is_active', '=', true).where('u.is_deleted', '=', false).as('active_users'),
        sql<string | null>`platform.effective_limit('max_users', t.id)`.as('max_users'),
      ]);
    if (q.status) qb = qb.where('t.status', '=', q.status);
    if (q.q) {
      const pat = likePattern(q.q);
      qb = qb.where(eb => eb.or([eb('t.name', 'ilike', pat), eb(sql`t.code::text`, 'ilike', pat)]));
    }
    if (cur) {
      qb = qb.where(eb => eb.or([
        eb('t.created_at', '<', new Date(cur.t)),
        eb.and([eb('t.created_at', '=', new Date(cur.t)), eb('t.id', '<', cur.id)]),
      ]));
    }
    const rows = await qb.orderBy('t.created_at', 'desc').orderBy('t.id', 'desc').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, r => ({ t: r.created_at, id: r.id }), (r): TenantListRow => ({
      id: r.id, code: r.code, name: r.name, status: r.status, planName: r.plan_name, subscriptionStatus: r.sub_status,
      renewalDate: toDate(r.renewal_date),
      activeUsers: Number(r.active_users ?? 0), maxUsers: r.max_users === null ? null : Number(r.max_users), createdAt: toIso(r.created_at)!,
    }));
  }

  async get(id: string) {
    const tenant = await this.loadTenant(this.db.platform, id);
    const sub = await this.currentSubscription(this.db.platform, id);
    const entitlements = await this.tenantEnt.build(id);
    return { tenant, subscription: sub, entitlements };
  }

  // ------------------------------------------------------------------ create
  async create(input: TenantCreate, actor: PlatformPrincipal): Promise<TenantCreated> {
    const temporaryPassword = generateTempPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const result = await this.db.platformTx(async tx => {
      const plan = await tx.selectFrom('platform.plan').select(['id', 'name', 'is_active', 'trial_days']).where('id', '=', input.planId).executeTakeFirst();
      if (!plan) throw new AppError(400, ErrorCode.VALIDATION, 'The selected plan does not exist.', undefined, [{ path: 'planId', message: 'Unknown plan' }]);
      if (!plan.is_active) throw new AppError(400, ErrorCode.VALIDATION, `The plan "${plan.name}" is not active.`, undefined, [{ path: 'planId', message: 'Plan is inactive' }]);
      const dup = await tx.selectFrom('platform.tenant').select('id').where('code', '=', input.code).executeTakeFirst();
      if (dup) throw AppError.conflict(`The company code "${input.code}" is already taken.`, { field: 'code' });

      const t = await tx.insertInto('platform.tenant').values({
        code: input.code, name: input.name, legal_name: input.legalName ?? null, logo_url: input.logoUrl ?? null,
        tax_ids: JSON.stringify(input.taxIds), address: JSON.stringify(input.address), timezone: input.timezone,
        currency: input.currency, fy_start_month: input.fyStartMonth,
      }).returning('id').executeTakeFirstOrThrow();
      // From here on, app.* inserts default tenant_id from this context.
      await sql`select set_config('app.tenant_id', ${t.id}, true)`.execute(tx);

      const sub = input.subscription;
      await tx.insertInto('platform.subscription').values({
        tenant_id: t.id, plan_id: plan.id, status: sub.status, start_date: sub.startDate, renewal_date: sub.renewalDate ?? null,
        trial_ends_on: sub.status === 'trial' && plan.trial_days > 0 ? addDays(sub.startDate, plan.trial_days) : null,
        effective_from: new Date(), change_reason: 'Tenant created', created_by: actor.userId,
      }).execute();

      const role = await tx.insertInto('app.role').values({
        key: 'tenant_admin', name: 'Company administrator', description: 'Full access to everything in the plan', is_system: true,
      }).returning('id').executeTakeFirstOrThrow();
      const admin = await tx.insertInto('app.tenant_user').values({
        email: input.admin.email, name: input.admin.name, password_hash: passwordHash, is_tenant_admin: true,
        must_change_password: true, created_by: null,
      }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('app.user_role').values({ user_id: admin.id, role_id: role.id }).execute();

      // Global templates (Phase 2): every tenant gets the system forms/masters; a bundle adds roles, samples, settings.
      const installed = await this.templates.apply(tx, input.templateBundle ?? null);
      const templateBundle = input.templateBundle ? { key: input.templateBundle, applied: installed.applied } : undefined;

      const tenant = await this.loadTenant(tx, t.id);
      await this.audit.platform(tx, {
        action: 'create', entity: 'tenant', entityId: t.id, tenantId: t.id,
        after: { tenant, planId: plan.id, subscription: sub, adminEmail: input.admin.email, templateBundle },
      });
      await this.audit.tenant(tx, { action: 'create', entity: 'tenant', entityId: t.id, after: { tenant, adminUserId: admin.id } });
      await this.audit.tenant(tx, { action: 'create', entity: 'user', entityId: admin.id, after: { email: input.admin.email, name: input.admin.name, isTenantAdmin: true } });
      return { tenantId: t.id };
    });
    // Phase 4: procurement system types (indent, vendor selection, PO …) next to the system forms. Runs in a tenant
    // transaction right after commit (the workflow/doc-type services rely on RLS); the boot job heals a failure.
    try {
      await this.db.tenantTx(result.tenantId, tx => this.procurement.ensure(tx, result.tenantId));
      await this.ent.bumpPermissions(result.tenantId);
    } catch (e) {
      this.log.error(`procurement provisioning failed for tenant ${result.tenantId}: ${(e as Error).message}`);
    }
    // Phase 6: starter PDF/email/in-app templates, then steps registered after them (Notify's default rules, order 500).
    // Runs after procurement so doc-type-specific templates find their types; the boot backfill heals a failure.
    try {
      await this.db.tenantTx(result.tenantId, tx => this.messageTemplates.ensure(tx, result.tenantId));
    } catch (e) {
      this.log.error(`template provisioning failed for tenant ${result.tenantId}: ${(e as Error).message}`);
    }
    await this.ent.invalidate(result.tenantId);
    return { tenantId: result.tenantId, adminEmail: input.admin.email, temporaryPassword };
  }

  // ------------------------------------------------------------------ update / status
  async update(id: string, input: z.infer<typeof TenantUpdate>): Promise<TenantDto> {
    const tenant = await this.db.platformTx(async tx => {
      const before = await this.loadTenant(tx, id);
      const set: Record<string, unknown> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.legalName !== undefined) set.legal_name = input.legalName;
      if (input.logoUrl !== undefined) set.logo_url = input.logoUrl;
      if (input.taxIds !== undefined) set.tax_ids = JSON.stringify(input.taxIds);
      if (input.address !== undefined) set.address = JSON.stringify(input.address);
      if (input.timezone !== undefined) set.timezone = input.timezone;
      if (input.currency !== undefined) set.currency = input.currency;
      if (input.fyStartMonth !== undefined) set.fy_start_month = input.fyStartMonth;
      if ((input as any).customDomain !== undefined) set.custom_domain = (input as any).customDomain;
      // Always bump the version, even when nothing else changed.
      set.version = sql`version`;
      const res = await tx.updateTable('platform.tenant').set(set).where('id', '=', id).where('version', '=', input.version).executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw AppError.versionConflict();
      const after = await this.loadTenant(tx, id);
      await this.audit.platform(tx, { action: 'update', entity: 'tenant', entityId: id, tenantId: id, before, after });
      return after;
    });
    await this.ent.invalidate(id);
    return tenant;
  }

  async changeStatus(id: string, to: 'active' | 'suspended' | 'archived', input: z.infer<typeof TenantStatusChange>): Promise<TenantDto> {
    const action = { active: 'reactivate', suspended: 'suspend', archived: 'archive' }[to];
    const tenant = await this.db.platformTx(async tx => {
      const before = await this.loadTenant(tx, id);
      if (before.status === to) return before;
      if (to === 'suspended' && before.status === 'archived') {
        throw AppError.conflict('An archived company cannot be suspended. Reactivate it first.');
      }
      await sql`select set_config('app.tenant_id', ${id}, true)`.execute(tx);
      await tx.updateTable('platform.tenant').set({ status: to, status_reason: input.reason }).where('id', '=', id).execute();
      const after = await this.loadTenant(tx, id);
      const entry = { action, entity: 'tenant', entityId: id, before: { status: before.status }, after: { status: to, reason: input.reason } };
      await this.audit.platform(tx, { ...entry, tenantId: id });
      await this.audit.tenant(tx, entry);
      return after;
    });
    await this.ent.invalidate(id);
    if (to !== 'active') await this.sessions.revokeTenant(id, `tenant_${to}`);
    return tenant;
  }

  // ------------------------------------------------------------------ overrides
  async setOverride(id: string, input: OverrideSet, actor: PlatformPrincipal): Promise<Entitlements> {
    await this.db.platformTx(async tx => {
      await this.loadTenant(tx, id);
      await this.validateOverride(tx, input);
      // QA-BUG-003: serialise writers of one (tenant, kind, key). An advisory lock also covers the case where no
      // override row exists yet (FOR UPDATE cannot lock a missing row). After the lock, `existing` is exactly the
      // value this write replaces, so history old_value → new_value always chains.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`override:${id}:${input.kind}:${input.key}`}, 0))`.execute(tx);
      const existing = await tx.selectFrom('platform.tenant_override').select(['value'])
        .where('tenant_id', '=', id).where('kind', '=', input.kind).where('key', '=', input.key).forUpdate().executeTakeFirst();
      const oldValue = existing ? JSON.stringify(existing.value) : null;
      let newValue: string | null;
      if (input.remove) {
        if (!existing) throw AppError.notFound('Override');
        await tx.deleteFrom('platform.tenant_override').where('tenant_id', '=', id).where('kind', '=', input.kind).where('key', '=', input.key).execute();
        newValue = null;
      } else {
        newValue = JSON.stringify(input.value);
        await tx.insertInto('platform.tenant_override')
          .values({ tenant_id: id, kind: input.kind, key: input.key, value: newValue, reason: input.reason, set_by: actor.userId, set_at: new Date() })
          .onConflict(oc => oc.columns(['tenant_id', 'kind', 'key']).doUpdateSet({ value: newValue!, reason: input.reason, set_by: actor.userId, set_at: new Date() }))
          .execute();
      }
      await tx.insertInto('platform.tenant_override_history').values({
        tenant_id: id, kind: input.kind, key: input.key, old_value: oldValue, new_value: newValue, reason: input.reason, changed_by: actor.userId,
        // Wall-clock time taken after the lock (not now() = transaction start), so history order = write order.
        changed_at: sql<Date>`clock_timestamp()`,
      }).execute();
      await this.audit.platform(tx, {
        action: input.remove ? 'override_removed' : 'override_set', entity: 'override', entityId: `${input.kind}:${input.key}`, tenantId: id,
        before: existing ? { value: existing.value } : null, after: input.remove ? null : { value: input.value, reason: input.reason },
      });
    });
    await this.ent.invalidate(id);
    return (await this.tenantEnt.build(id))!;
  }

  async overrideHistory(id: string) {
    await this.loadTenant(this.db.platform, id);
    const rows = await this.db.platform.selectFrom('platform.tenant_override_history as h')
      .leftJoin('platform.platform_user as u', 'u.id', 'h.changed_by')
      .select(['h.id', 'h.kind', 'h.key', 'h.old_value', 'h.new_value', 'h.reason', 'h.changed_by', 'h.changed_at', 'u.name as changed_by_name'])
      .where('h.tenant_id', '=', id).orderBy('h.changed_at', 'desc').orderBy('h.id', 'desc').execute();
    return rows.map(r => ({
      id: r.id, kind: r.kind, key: r.key, oldValue: r.old_value, newValue: r.new_value, reason: r.reason,
      changedBy: r.changed_by, changedByName: r.changed_by_name, changedAt: toIso(r.changed_at)!,
    }));
  }

  private async validateOverride(tx: Tx, input: OverrideSet) {
    const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
    if (input.kind === 'feature') {
      const f = await tx.selectFrom('platform.feature_catalog').select('key').where('key', '=', input.key).executeTakeFirst();
      if (!f) throw bad('key', `Unknown feature "${input.key}"`);
      if (!input.remove && typeof input.value !== 'boolean') throw bad('value', 'A feature override must be true or false');
    } else {
      const l = await tx.selectFrom('platform.limit_catalog').select('key').where('key', '=', input.key).executeTakeFirst();
      if (!l) throw bad('key', `Unknown limit "${input.key}"`);
      if (!input.remove && !(input.value === null || typeof input.value === 'number')) {
        throw bad('value', 'A limit override must be a whole number, or null for unlimited');
      }
    }
  }

  // ------------------------------------------------------------------ subscriptions
  async changeSubscription(id: string, input: z.infer<typeof SubscriptionChange>, actor: PlatformPrincipal) {
    const sub = await this.db.platformTx(async tx => {
      await this.loadTenant(tx, id);
      const plan = await tx.selectFrom('platform.plan').select(['id', 'name', 'is_active', 'trial_days']).where('id', '=', input.planId).executeTakeFirst();
      if (!plan) throw new AppError(400, ErrorCode.VALIDATION, 'The selected plan does not exist.', undefined, [{ path: 'planId', message: 'Unknown plan' }]);
      if (!plan.is_active) throw new AppError(400, ErrorCode.VALIDATION, `The plan "${plan.name}" is not active.`, undefined, [{ path: 'planId', message: 'Plan is inactive' }]);
      const at = input.effectiveFrom ? new Date(input.effectiveFrom) : new Date();
      // Serialise concurrent changes for this tenant.
      const current = await tx.selectFrom('platform.subscription').selectAll().where('tenant_id', '=', id).where('effective_to', 'is', null).forUpdate().executeTakeFirst();
      if (current) await tx.updateTable('platform.subscription').set({ effective_to: at }).where('id', '=', current.id).execute();
      const startDate = at.toISOString().slice(0, 10);
      const row = await tx.insertInto('platform.subscription').values({
        tenant_id: id, plan_id: plan.id, status: input.status, start_date: startDate, renewal_date: input.renewalDate ?? null,
        trial_ends_on: input.status === 'trial' && plan.trial_days > 0 ? addDays(startDate, plan.trial_days) : null,
        effective_from: at, change_reason: input.reason, created_by: actor.userId,
      }).returningAll().executeTakeFirstOrThrow();
      const after = toSubscription({ ...row, plan_name: plan.name });
      await this.audit.platform(tx, {
        action: 'subscription_change', entity: 'subscription', entityId: row.id, tenantId: id,
        before: current ? { planId: current.plan_id, status: current.status } : null, after,
      });
      return after;
    });
    await this.ent.invalidate(id);
    return sub;
  }

  async subscriptions(id: string) {
    await this.loadTenant(this.db.platform, id);
    const rows = await this.db.platform.selectFrom('platform.subscription as s').innerJoin('platform.plan as p', 'p.id', 's.plan_id')
      .selectAll('s').select('p.name as plan_name').where('s.tenant_id', '=', id)
      .orderBy('s.effective_from', 'desc').orderBy('s.created_at', 'desc').execute();
    return rows.map(toSubscription);
  }


  // ------------------------------------------------------------------ domain + logo
  async setAllowCustomDomain(id: string, allow: boolean): Promise<TenantDto> {
    return this.db.platformTx(async tx => {
      const before = await this.loadTenant(tx, id);
      await tx.updateTable('platform.tenant').set({ allow_custom_domain: allow }).where('id', '=', id).execute();
      const after = await this.loadTenant(tx, id);
      await this.audit.platform(tx, { action: 'update', entity: 'tenant', entityId: id, tenantId: id, before, after });
      return after;
    });
  }

  async setLogoUrl(id: string, logoUrl: string | null): Promise<TenantDto> {
    return this.db.platformTx(async tx => {
      const before = await this.loadTenant(tx, id);
      await tx.updateTable('platform.tenant').set({ logo_url: logoUrl }).where('id', '=', id).execute();
      const after = await this.loadTenant(tx, id);
      await this.audit.platform(tx, { action: 'update', entity: 'tenant', entityId: id, tenantId: id, before, after });
      return after;
    });
  }

  // ------------------------------------------------------------------ admin access
  async resetAdminPassword(id: string): Promise<{ temporaryPassword: string; adminEmail: string }> {
    const temporaryPassword = generateTempPassword();
    const h = await hashPassword(temporaryPassword);
    const admin = await this.db.platformTx(async tx => {
      await this.loadTenant(tx, id);
      const a = await this.primaryAdmin(tx);
      await tx.updateTable('app.tenant_user')
        .set({ password_hash: h, must_change_password: true, failed_logins: 0, locked_until: null }).where('id', '=', a.id).execute();
      await this.audit.platform(tx, { action: 'admin_password_reset', entity: 'user', entityId: a.id, tenantId: id, after: { email: a.email } });
      await this.audit.tenant(tx, { action: 'password_reset', entity: 'user', entityId: a.id, after: { by: 'platform' } });
      return a;
    }, id);
    await this.sessions.revokeSubject('tenant', admin.id, 'password_reset');
    await invalidatePrincipal(this.redis, 'tenant', admin.id);
    return { temporaryPassword, adminEmail: admin.email };
  }

  async impersonate(id: string, reason: string, actor: PlatformPrincipal): Promise<AuthResult> {
    const state = await this.ent.state(id);
    if (!state) throw AppError.notFound('Company');
    if (state.status !== 'active') throw AppError.conflict('You can only sign in as an active company. Reactivate it first.');
    const { admin, session } = await this.db.platformTx(async tx => {
      const a = await this.primaryAdmin(tx);
      const s = await this.sessions.create({
        subjectType: 'tenant', subjectId: a.id, tenantId: id, impersonatedBy: actor.userId,
        expiresAt: new Date(Date.now() + IMPERSONATION_MINUTES * 60_000),
      }, tx);
      const entry = { action: 'impersonate_start', entity: 'user', entityId: a.id, after: { reason, sessionId: s.id, platformUserId: actor.userId } };
      await this.audit.platform(tx, { ...entry, tenantId: id });
      await this.audit.tenant(tx, entry);
      return { admin: a, session: s };
    }, id);
    const principal: Principal = {
      kind: 'tenant', userId: admin.id, tenantId: id, tenantCode: state.code, tenantName: state.name, name: admin.name, email: admin.email,
      isTenantAdmin: true, impersonatedBy: { userId: actor.userId, name: actor.name },
    };
    return this.auth.authResult(principal, session.id, false);
  }

  /** The longest-standing active tenant admin. Tx must carry the tenant context. */
  private async primaryAdmin(tx: Tx) {
    const a = await tx.selectFrom('app.tenant_user').select(['id', 'name', 'email'])
      .where('tenant_id', '=', sql<string>`app.current_tenant_id()`)
      .where('is_tenant_admin', '=', true).where('is_active', '=', true).where('is_deleted', '=', false)
      .orderBy('created_at').orderBy('id').limit(1).executeTakeFirst();
    if (!a) throw AppError.conflict('This company has no active administrator.');
    return a;
  }

  // ------------------------------------------------------------------ usage / audit
  async usage() {
    const tenants = await this.db.platform.selectFrom('platform.tenant').select(['id', 'code', 'name'])
      .where('status', '<>', 'archived').orderBy('created_at', 'desc').execute();
    return Promise.all(tenants.map(async t => {
      const e = await this.tenantEnt.build(t.id);
      return { tenantId: t.id, code: t.code, name: t.name, limits: (e?.limits ?? []).map(l => ({ key: l.key, used: l.used, effective: l.effective })) };
    }));
  }

  async auditList(q: z.infer<typeof AuditListQuery>) {
    const cur = decodeCursor(q.cursor);
    let qb = this.db.platform.selectFrom('platform.audit_log as a')
      .leftJoin('platform.platform_user as u', 'u.id', 'a.actor_id')
      .leftJoin('platform.tenant as t', 't.id', 'a.tenant_id')
      .select(['a.id', 'a.actor_id', 'u.name as actor_name', 'a.action', 'a.entity', 'a.entity_id', 'a.tenant_id', 't.code as tenant_code',
        'a.before', 'a.after', 'a.ip', 'a.user_agent', 'a.at']);
    if (q.tenantId) qb = qb.where('a.tenant_id', '=', q.tenantId);
    if (q.q) {
      const pat = likePattern(q.q);
      qb = qb.where(eb => eb.or([eb('a.action', 'ilike', pat), eb('a.entity', 'ilike', pat), eb('a.entity_id', 'ilike', pat)]));
    }
    if (cur) {
      qb = qb.where(eb => eb.or([
        eb('a.at', '<', new Date(cur.t)),
        eb.and([eb('a.at', '=', new Date(cur.t)), eb('a.id', '<', cur.id)]),
      ]));
    }
    const rows = await qb.orderBy('a.at', 'desc').orderBy('a.id', 'desc').limit(q.limit + 1).execute();
    return toPage(rows, q.limit, r => ({ t: r.at, id: r.id }), r => ({
      id: String(r.id), actorId: r.actor_id, actorName: r.actor_name, action: r.action, entity: r.entity, entityId: r.entity_id,
      tenantId: r.tenant_id, tenantCode: r.tenant_code, before: r.before, after: r.after, ip: r.ip, userAgent: r.user_agent, at: toIso(r.at)!,
    }));
  }

  // ------------------------------------------------------------------ helpers
  private async loadTenant(db: Tx | DbService['platform'], id: string): Promise<TenantDto> {
    const t = await db.selectFrom('platform.tenant').selectAll().where('id', '=', id).executeTakeFirst();
    if (!t) throw AppError.notFound('Company');
    return toTenant(t);
  }

  private async currentSubscription(db: Tx | DbService['platform'], id: string) {
    const s = await db.selectFrom('platform.subscription as s').innerJoin('platform.plan as p', 'p.id', 's.plan_id')
      .selectAll('s').select('p.name as plan_name').where('s.tenant_id', '=', id).where('s.effective_to', 'is', null).executeTakeFirst();
    return s ? toSubscription(s) : null;
  }
}
