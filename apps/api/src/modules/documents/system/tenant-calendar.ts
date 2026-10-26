import { Injectable } from '@nestjs/common';
import { DbService } from '../../../core/db.service';

/**
 * Tenant fiscal-year start (platform.tenant.fy_start_month), read with the platform role exactly like identity's
 * /auth/me extras: app_user cannot read platform.tenant and app.my_tenant_state() does not expose it. Read-only, one
 * primary-key lookup filtered by the tenant id of the caller's own transaction.
 */
@Injectable()
export class TenantCalendar {
  constructor(private readonly db: DbService) {}

  async fyStartMonth(tenantId: string): Promise<number> {
    const t = await this.db.platform.selectFrom('platform.tenant').select('fy_start_month').where('id', '=', tenantId).executeTakeFirst();
    return t?.fy_start_month ?? 4;
  }

  /** Phase 4 (agent B, additive): company currency + address state code (GST ship-to fallback, PO currency default). */
  async currencyAndState(tenantId: string): Promise<{ currency: string; stateCode: string | null }> {
    const t = await this.db.platform.selectFrom('platform.tenant').select(['currency', 'address']).where('id', '=', tenantId).executeTakeFirst();
    const addr = (t?.address ?? {}) as Record<string, string>;
    return { currency: t?.currency ?? 'INR', stateCode: addr.stateCode ?? addr.state_code ?? null };
  }
}
