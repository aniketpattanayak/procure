import { Injectable } from '@nestjs/common';
import { DbService } from '../../../core/db.service';

export interface TenantProfileRow {
  id: string; code: string; name: string; legalName: string | null; logoUrl: string | null;
  taxIds: Record<string, string>; address: Record<string, string>; timezone: string; currency: string;
}

/**
 * Tenant letterhead data for templates (platform.tenant: name, legal name, GSTIN/PAN, address, logo, currency, time
 * zone). app_user cannot read platform.tenant, so this is a read-only primary-key lookup with the platform role,
 * exactly like documents/system/tenant-calendar.ts. Always filtered by the caller's own tenant id.
 */
@Injectable()
export class TenantProfile {
  constructor(private readonly db: DbService) {}

  async get(tenantId: string): Promise<TenantProfileRow | null> {
    const t = await this.db.platform.selectFrom('platform.tenant')
      .select(['id', 'code', 'name', 'legal_name', 'logo_url', 'tax_ids', 'address', 'timezone', 'currency'])
      .where('id', '=', tenantId).executeTakeFirst();
    if (!t) return null;
    return {
      id: t.id, code: t.code, name: t.name, legalName: t.legal_name, logoUrl: t.logo_url, taxIds: (t.tax_ids ?? {}) as Record<string, string>,
      address: (t.address ?? {}) as Record<string, string>, timezone: t.timezone, currency: t.currency,
    };
  }
}
