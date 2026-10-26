import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppError } from '../../../core/errors';
import { registerSettingGuard } from '../../../core/setting-guards';
import { financialYear, TenantCalendar } from '../../documents';
import { tenantToday } from '../../forms';
import { STOCK_ERRORS } from './types';

/**
 * `stock.valuation` is fixed per financial year (ADR-0016 §4): once the current FY has any stock movement, a change
 * is refused with 409 STOCK_VALUATION_LOCKED. Switching is possible in a new FY before its first movement.
 */
@Injectable()
export class ValuationGuard implements OnModuleInit {
  constructor(private readonly calendar: TenantCalendar) {}

  onModuleInit() {
    registerSettingGuard('stock.valuation', async (tx, c) => {
      const today = await tenantToday(tx);
      const fyStartMonth = await this.calendar.fyStartMonth(c.tenantId);
      const { start, fy } = financialYear(today, fyStartMonth);
      const from = `${start}-${String(Math.min(12, Math.max(1, fyStartMonth))).padStart(2, '0')}-01`;
      const moved = await tx.selectFrom('app.stock_movement').select('id').where('tenant_id', '=', c.tenantId).where('at', '>=', new Date(`${from}T00:00:00Z`)).limit(1).executeTakeFirst();
      if (moved) {
        throw new AppError(409, STOCK_ERRORS.valuationLocked, `The stock valuation method cannot change during financial year ${fy} because stock has already moved. Change it at the start of the next financial year.`, { fy });
      }
    });
  }
}
