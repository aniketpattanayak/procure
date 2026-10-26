import { Injectable } from '@nestjs/common';
import { ErrorCode, ProviderCredentialInput } from '@procure/schema';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit.service';
import { DbService } from '../../../core/db.service';
import { AppError } from '../../../core/errors';
import type { ProviderKind, ResolvedProvider } from '../channels/types';
import { decryptSecret, encryptSecret, parseSecret } from '../util/crypto';

type Input = z.infer<typeof ProviderCredentialInput>;

export interface ProviderCredentialRow {
  id: string; tenantId: string | null; channel: 'email' | 'whatsapp'; provider: ProviderKind; config: Record<string, unknown>;
  /** Secrets are write-only: the API only says whether one is stored. */
  hasSecret: boolean; isActive: boolean; createdAt: string; updatedAt: string; version: number;
}

const CHANNEL_PROVIDERS: Record<'email' | 'whatsapp', ProviderKind[]> = { email: ['ses', 'smtp', 'log'], whatsapp: ['meta', 'bsp', 'log'] };
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);
const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Per-provider required settings (non-secret config + secret keys). */
function validate(i: Input) {
  if (!CHANNEL_PROVIDERS[i.channel].includes(i.provider)) throw bad('provider', `"${i.provider}" is not a ${i.channel} provider.`);
  const c = i.config;
  switch (i.provider) {
    case 'smtp': if (!s(c.host)) throw bad('config.host', 'SMTP needs a host.'); break;
    case 'meta': if (!s(c.phoneNumberId)) throw bad('config.phoneNumberId', 'Meta needs the WhatsApp phone number id.'); break;
    case 'bsp': if (!/^https:\/\//.test(s(c.url))) throw bad('config.url', 'The BSP endpoint must be an https URL.'); break;
    default: break;
  }
  if ((i.provider === 'ses' || i.provider === 'smtp') && c.fromAddress !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s(c.fromAddress))) {
    throw bad('config.fromAddress', 'The from address is not a valid email address.');
  }
  const secretShape = JSON.stringify(c).toLowerCase();
  if (/"(password|secret|accesstoken|token|appsecret|secretaccesskey)"\s*:/.test(secretShape)) {
    throw bad('config', 'Put passwords, tokens and keys in "secret" (stored encrypted), not in "config".');
  }
}

/**
 * Provider credentials (platform.provider_credential): Super Admin CRUD and send-time resolution. A tenant row
 * overrides the platform default (tenant_id NULL) for its channel. Platform-role access lives here only.
 */
@Injectable()
export class ProviderStore {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private toRow(r: { id: string; tenant_id: string | null; channel: 'email' | 'whatsapp'; provider: ProviderKind; config: unknown; secret: string | null; is_active: boolean; created_at: Date; updated_at: Date; version: number }): ProviderCredentialRow {
    return {
      id: r.id, tenantId: r.tenant_id, channel: r.channel, provider: r.provider, config: (r.config ?? {}) as Record<string, unknown>,
      hasSecret: !!r.secret, isActive: r.is_active, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(), version: r.version,
    };
  }

  /** The provider used for a tenant's channel right now (tenant override, else platform default), or null. */
  async resolve(tenantId: string, channel: 'email' | 'whatsapp'): Promise<ResolvedProvider | null> {
    const rows = await this.db.platform.selectFrom('platform.provider_credential').selectAll()
      .where('channel', '=', channel).where('is_active', '=', true)
      .where(eb => eb.or([eb('tenant_id', '=', tenantId), eb('tenant_id', 'is', null)])).execute();
    const r = rows.find(x => x.tenant_id === tenantId) ?? rows.find(x => x.tenant_id === null);
    if (!r) return null;
    return {
      id: r.id, tenantId: r.tenant_id, channel: r.channel, provider: r.provider, config: (r.config ?? {}) as Record<string, unknown>,
      secret: r.secret ? parseSecret(decryptSecret(r.secret)) : {},
    };
  }

  /** Every active Meta credential's webhook secrets (signature check accepts any configured app). */
  async metaSecrets(): Promise<{ appSecret: string; verifyToken: string }[]> {
    const rows = await this.db.platform.selectFrom('platform.provider_credential').select(['secret', 'config'])
      .where('provider', '=', 'meta').where('is_active', '=', true).execute();
    return rows.map(r => {
      const sec = r.secret ? parseSecret(decryptSecret(r.secret)) : {};
      return { appSecret: sec.appSecret ?? '', verifyToken: sec.verifyToken ?? s((r.config as Record<string, unknown>)?.verifyToken) };
    });
  }

  /** SES topic ARNs configured on active SES credentials (empty = accept any verified SNS topic). */
  async sesTopics(): Promise<string[]> {
    const rows = await this.db.platform.selectFrom('platform.provider_credential').select('config')
      .where('provider', '=', 'ses').where('is_active', '=', true).execute();
    return rows.map(r => s((r.config as Record<string, unknown>)?.snsTopicArn)).filter(Boolean);
  }

  // ------------------------------------------------------------------ Super Admin
  async list(q: { tenantId?: string; channel?: string } = {}): Promise<ProviderCredentialRow[]> {
    let qb = this.db.platform.selectFrom('platform.provider_credential').selectAll();
    if (q.tenantId) qb = qb.where('tenant_id', '=', q.tenantId);
    if (q.channel === 'email' || q.channel === 'whatsapp') qb = qb.where('channel', '=', q.channel);
    const rows = await qb.orderBy('tenant_id', 'asc').orderBy('channel').orderBy('created_at').execute();
    return rows.map(r => this.toRow(r));
  }

  async get(id: string): Promise<ProviderCredentialRow> {
    const r = await this.db.platform.selectFrom('platform.provider_credential').selectAll().where('id', '=', id).executeTakeFirst();
    if (!r) throw AppError.notFound('Provider');
    return this.toRow(r);
  }

  private async tenantExists(tx: Parameters<Parameters<DbService['platformTx']>[0]>[0], id: string | null) {
    if (!id) return;
    const t = await tx.selectFrom('platform.tenant').select('id').where('id', '=', id).executeTakeFirst();
    if (!t) throw bad('tenantId', 'This company does not exist.');
  }

  async create(i: Input): Promise<ProviderCredentialRow> {
    validate(i);
    return this.db.platformTx(async tx => {
      await this.tenantExists(tx, i.tenantId);
      const r = await tx.insertInto('platform.provider_credential').values({
        tenant_id: i.tenantId, channel: i.channel, provider: i.provider, config: JSON.stringify(i.config),
        secret: i.secret ? encryptSecret(i.secret) : null, is_active: i.isActive,
      }).returningAll().executeTakeFirstOrThrow().catch(e => { throw dup(e); });
      await this.audit.platform(tx, { action: 'create', entity: 'provider_credential', entityId: r.id, tenantId: i.tenantId, after: { channel: i.channel, provider: i.provider, config: i.config, credentialsSet: !!i.secret } });
      return this.toRow(r);
    });
  }

  /** Update; omitting `secret` keeps the stored one, an empty string clears it. */
  async update(id: string, i: Input & { version: number }): Promise<ProviderCredentialRow> {
    validate(i);
    return this.db.platformTx(async tx => {
      const cur = await tx.selectFrom('platform.provider_credential').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw AppError.notFound('Provider');
      if (cur.version !== i.version) throw AppError.versionConflict();
      await this.tenantExists(tx, i.tenantId);
      const secret = i.secret === undefined ? cur.secret : i.secret === '' ? null : encryptSecret(i.secret);
      const r = await tx.updateTable('platform.provider_credential').set({
        tenant_id: i.tenantId, channel: i.channel, provider: i.provider, config: JSON.stringify(i.config), secret, is_active: i.isActive, version: cur.version + 1,
      }).where('id', '=', id).returningAll().executeTakeFirstOrThrow().catch(e => { throw dup(e); });
      await this.audit.platform(tx, {
        action: 'update', entity: 'provider_credential', entityId: id, tenantId: i.tenantId,
        before: { provider: cur.provider, config: cur.config, isActive: cur.is_active }, after: { provider: i.provider, config: i.config, isActive: i.isActive, credentialsChanged: i.secret !== undefined },
      });
      return this.toRow(r);
    });
  }

  /** Deactivates (rows are kept: outbound messages reference the provider by kind, webhooks need history). */
  async remove(id: string): Promise<void> {
    await this.db.platformTx(async tx => {
      const cur = await tx.selectFrom('platform.provider_credential').select(['id', 'tenant_id', 'is_active']).where('id', '=', id).executeTakeFirst();
      if (!cur) throw AppError.notFound('Provider');
      await tx.updateTable('platform.provider_credential').set(eb => ({ is_active: false, version: eb('version', '+', 1) })).where('id', '=', id).execute();
      await this.audit.platform(tx, { action: 'deactivate', entity: 'provider_credential', entityId: id, tenantId: cur.tenant_id, before: { isActive: cur.is_active }, after: { isActive: false } });
    });
  }
}

function dup(e: unknown) {
  if ((e as { code?: string }).code === '23505') return AppError.conflict('An active provider already exists for this company and channel. Deactivate it first.', { field: 'channel' });
  return e;
}
