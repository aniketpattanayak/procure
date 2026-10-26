import { Body, Controller, Get, Injectable, Put, Query } from '@nestjs/common';
import { ErrorCode, LabelsPatch, SettingKey, SettingRow, SettingsPatch, SettingsRegistry } from '@procure/schema';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import { TenantOnly } from '../../core/auth/decorators';
import { Requires } from '../../core/auth/permissions';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { runSettingGuards } from '../../core/setting-guards';
import { tenantPrincipal } from '../../core/request-context';
import { Zod } from '../../core/zod';
import { PermissionCache } from './cache';
import { loadSettings } from './settings.util';

/** Language tags for label storage keys (`labels.<lang>`); strict so no lang can collide with a registry key. */
const Lang = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, 'Use a language code such as "en" or "hi"');
const LabelsQuery = z.object({ lang: Lang.default('en') });
const LabelsBody = LabelsPatch.extend({ lang: Lang.default('en') });

@Injectable()
export class SettingsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly cache: PermissionCache) {}

  async list(): Promise<SettingRow[]> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.rows(tx));
  }

  async patch(patch: Record<string, unknown>): Promise<SettingRow[]> {
    const p = tenantPrincipal();
    const errors: { path: string; message: string }[] = [];
    const parsed: [SettingKey, unknown][] = [];
    for (const [key, value] of Object.entries(patch)) {
      const def = SettingsRegistry[key as SettingKey];
      if (!def || !Object.prototype.hasOwnProperty.call(SettingsRegistry, key)) { errors.push({ path: key, message: 'Unknown setting' }); continue; }
      if (value === null) { parsed.push([key as SettingKey, null]); continue; } // null = back to default
      const r = def.schema.safeParse(value);
      if (!r.success) errors.push(...r.error.issues.map(i => ({ path: [key, ...i.path].join('.'), message: i.message })));
      else parsed.push([key as SettingKey, r.data]);
    }
    if (errors.length) throw new AppError(400, ErrorCode.VALIDATION, 'Some settings are not valid.', undefined, errors);
    if (!parsed.length) return this.list();

    let flowChanged = false;
    const rows = await this.db.tenantTx(p.tenantId, async tx => {
      const { values: before } = await loadSettings(tx);
      // Phase 5: module vetoes (e.g. stock.valuation is fixed per financial year once stock moved).
      for (const [key, value] of parsed) await runSettingGuards(tx, p.tenantId, key, before[key], value === null ? SettingsRegistry[key].default : value);
      for (const [key, value] of parsed) {
        if (value === null) await tx.deleteFrom('app.tenant_setting').where('key', '=', key).execute();
        else {
          await tx.insertInto('app.tenant_setting').values({ key, value: JSON.stringify(value), updated_by: p.userId })
            .onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(value), updated_by: p.userId, updated_at: new Date() }))
            .execute();
        }
      }
      const { values: after } = await loadSettings(tx);
      const changed = parsed.map(([k]) => k).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changed.length) {
        flowChanged = changed.some(k => k.startsWith('flow.'));
        await this.audit.tenant(tx, {
          action: 'update', entity: 'settings', entityId: null,
          before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, after[k]])),
        });
      }
      return this.rows(tx);
    });
    if (flowChanged) await this.cache.bump(p.tenantId);
    return rows;
  }

  async labels(lang: string): Promise<Record<string, string>> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, tx => this.readLabels(tx, lang));
  }

  async patchLabels(lang: string, patch: Record<string, string | null>): Promise<Record<string, string>> {
    const p = tenantPrincipal();
    return this.db.tenantTx(p.tenantId, async tx => {
      const before = await this.readLabels(tx, lang);
      const after = { ...before };
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v.trim() === '') delete after[k];
        else after[k] = v;
      }
      const key = `labels.${lang}`;
      if (Object.keys(after).length) {
        await tx.insertInto('app.tenant_setting').values({ key, value: JSON.stringify(after), updated_by: p.userId })
          .onConflict(oc => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: JSON.stringify(after), updated_by: p.userId, updated_at: new Date() }))
          .execute();
      } else await tx.deleteFrom('app.tenant_setting').where('key', '=', key).execute();
      const changed = Object.keys({ ...before, ...after }).filter(k => before[k] !== after[k]);
      if (changed.length) {
        await this.audit.tenant(tx, {
          action: 'update', entity: 'labels', entityId: lang,
          before: Object.fromEntries(changed.map(k => [k, before[k] ?? null])), after: Object.fromEntries(changed.map(k => [k, after[k] ?? null])),
        });
      }
      return after;
    });
  }

  private async readLabels(tx: Tx, lang: string): Promise<Record<string, string>> {
    const row = await tx.selectFrom('app.tenant_setting').select('value').where('key', '=', `labels.${lang}`).executeTakeFirst();
    const out: Record<string, string> = {};
    if (row?.value && typeof row.value === 'object' && !Array.isArray(row.value)) {
      for (const [k, v] of Object.entries(row.value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
    }
    return out;
  }

  private async rows(tx: Tx): Promise<SettingRow[]> {
    const { values, stored } = await loadSettings(tx);
    return (Object.keys(SettingsRegistry) as SettingKey[]).map(key => ({
      key, label: SettingsRegistry[key].label, value: values[key], default: SettingsRegistry[key].default, isDefault: !stored.has(key),
    }));
  }
}

@TenantOnly()
@Controller('config')
export class SettingsController {
  constructor(private readonly svc: SettingsService) {}

  @Get('settings')
  @Requires('admin.settings:action.view')
  list() {
    return this.svc.list();
  }

  @Put('settings')
  @Requires('admin.settings:action.edit')
  patch(@Body(new Zod(SettingsPatch)) body: z.infer<typeof SettingsPatch>) {
    return this.svc.patch(body);
  }

  /** Any tenant user (the UI needs wording overrides everywhere). */
  @Get('labels')
  labels(@Query(new Zod(LabelsQuery)) q: z.infer<typeof LabelsQuery>) {
    return this.svc.labels(q.lang);
  }

  @Put('labels')
  @Requires('admin.settings:action.edit')
  patchLabels(@Body(new Zod(LabelsBody)) body: z.infer<typeof LabelsBody>) {
    return this.svc.patchLabels(body.lang, body.labels);
  }
}
