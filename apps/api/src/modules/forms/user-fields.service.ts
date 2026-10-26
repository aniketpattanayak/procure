import { Injectable } from '@nestjs/common';
import type { MyPermissions } from '@procure/schema';
import type { Tx } from '../../core/db.service';
import { FilesService } from '../files';
import { FormsService, tenantToday } from './forms.service';
import { RecordEngine } from './record-engine';
import { USER_FORM, USER_SYSTEM_FIELDS } from './templates';

const SYSTEM = new Set<string>(USER_SYSTEM_FIELDS);

export interface UserCustomResult {
  custom: Record<string, unknown>;
  /** Pass to `finish` once the user row exists (reference index + file attachments). */
  pending: { refs: { field: string; kind: 'master_record' | 'tenant_user' | 'location_node'; id: string }[]; files: Map<string, string[]> };
}

/**
 * Custom fields of the `user` system form, stored in `tenant_user.custom` and validated with the same record
 * pipeline as master records (types, lookups, files, formulas, requiredWhen, field access).
 */
@Injectable()
export class UserFieldsService {
  constructor(private readonly forms: FormsService, private readonly engine: RecordEngine, private readonly files: FilesService) {}

  /**
   * Validates `custom` for a user create (`prev` undefined) or update. `system` carries the user's column values
   * (name, email, phone, reporting_manager) so formulas and conditions can use them.
   */
  async validate(
    tx: Tx, tenantId: string, perms: MyPermissions | null, input: {
      custom: Record<string, unknown> | undefined; prev?: Record<string, unknown>; userId?: string; system?: Record<string, unknown>;
    },
  ): Promise<UserCustomResult> {
    const form = await tx.selectFrom('app.form_def').select(['id', 'current_version_id']).where('tenant_id', '=', tenantId).where('key', '=', USER_FORM.key).executeTakeFirst();
    if (!form?.current_version_id) {
      // Tenants provisioned before Phase 2 have no user form yet: keep whatever was stored.
      return { custom: input.prev ?? {}, pending: { refs: [], files: new Map() } };
    }
    const { definition } = await this.forms.version(tx, tenantId, form.current_version_id);
    const prepared = await this.engine.prepare(tx, tenantId, {
      def: definition, formKey: USER_FORM.key, prev: input.prev ?? {}, incoming: input.custom ?? {}, isCreate: input.prev === undefined,
      owner: { kind: 'tenant_user', id: input.userId ?? null }, include: f => !SYSTEM.has(f.key), extraValues: input.system ?? {},
      today: await tenantToday(tx), perms,
    });
    return { custom: prepared.data, pending: { refs: prepared.refs, files: prepared.files } };
  }

  /** Writes record_ref rows (from_kind tenant_user) and attaches files after the user row is saved. */
  async finish(tx: Tx, tenantId: string, userId: string, pending: UserCustomResult['pending']): Promise<void> {
    await this.engine.writeRefs(tx, tenantId, { kind: 'tenant_user', id: userId }, pending.refs);
    await this.files.syncAttachments(tx, tenantId, { kind: 'tenant_user', id: userId }, pending.files);
  }

  /** Hidden custom fields removed for the caller. */
  visibleCustom(perms: MyPermissions | null, custom: Record<string, unknown>): Record<string, unknown> {
    const access = perms?.fieldAccess?.[USER_FORM.key] ?? {};
    return Object.fromEntries(Object.entries(custom ?? {}).filter(([k]) => access[k] !== 'hidden'));
  }
}
