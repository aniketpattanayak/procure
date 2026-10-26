import { Injectable } from '@nestjs/common';
import type { RegistryTab } from '@procure/schema';
import { sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import { EntitlementsService } from '../../core/entitlements.service';
import { computeVisibility, RegistryEntry, RegistrySource, Visibility } from './compiler';
import { booleanSettings, loadSettings } from './settings.util';

/** Tabs whose records are filtered by location data scope: locations + every document tab `doc.<key>` (Phase 3). */
export const SCOPED_TABS = new Set<string>(['admin.locations']);
export const isScopedTab = (key: string) => SCOPED_TABS.has(key) || key.startsWith('doc.');

type FormFields = RegistryTab['forms'][number];

interface DefRow {
  key: string; kind: string; tab_key: string; label: string; description: string | null; group_label: string | null;
  requires_feature: string | null; requires_setting: string | null; sort_order: number;
}

/**
 * Permission registry = platform.permission_def (via app.platform_permission_defs()) ∪ app.permission_def,
 * filtered by the tenant's effective plan features and boolean flow settings. Read-only; every method takes a
 * tenant transaction.
 */
@Injectable()
export class PermissionRegistryService {
  constructor(private readonly ent: EntitlementsService) {}

  /** The full merged registry (visible and hidden). */
  async entries(tx: Tx): Promise<RegistryEntry[]> {
    const platform = await sql<DefRow>`select * from app.platform_permission_defs()`.execute(tx);
    const tenant = await tx.selectFrom('app.permission_def')
      .select(['key', 'kind', 'tab_key', 'label', 'description', 'group_label', 'requires_feature', 'requires_setting', 'sort_order', 'source'])
      .execute();
    const map = (r: DefRow, source: RegistrySource): RegistryEntry => ({
      key: r.key, kind: r.kind as RegistryEntry['kind'], tabKey: r.tab_key, label: r.label, description: r.description,
      group: r.group_label, requiresFeature: r.requires_feature, requiresSetting: r.requires_setting, sortOrder: r.sort_order, source,
    });
    const out = new Map<string, RegistryEntry>();
    for (const r of tenant) out.set(r.key, map(r, r.source as RegistrySource));
    for (const r of platform.rows) out.set(r.key, map(r, 'platform')); // shipped keys win over a same-named tenant key
    return [...out.values()];
  }

  /** Registry plus the inputs that decide visibility. */
  async load(tx: Tx, tenantId: string): Promise<{ entries: RegistryEntry[]; features: string[]; settings: Record<string, boolean>; visibility: Visibility }> {
    const [entries, state, s] = await Promise.all([this.entries(tx), this.ent.state(tenantId), loadSettings(tx)]);
    const features = state?.features ?? [];
    const settings = booleanSettings(s.values);
    return { entries, features, settings, visibility: computeVisibility(entries, features, settings) };
  }

  /** Permission-screen tabs (plan- and flow-filtered), with per-tab forms for field access. */
  async tabs(tx: Tx, tenantId: string): Promise<RegistryTab[]> {
    const { visibility } = await this.load(tx, tenantId);
    return this.buildTabs(tx, visibility.visible);
  }

  async buildTabs(tx: Tx, visible: RegistryEntry[]): Promise<RegistryTab[]> {
    const forms = await this.tabForms(tx);
    const tabs = visible.filter(e => e.kind === 'tab');
    const bySort = (a: RegistryEntry, b: RegistryEntry) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);
    return tabs.sort(bySort).map(t => ({
      key: t.key,
      label: t.label,
      group: t.group ?? (t.source === 'master' ? 'Masters' : t.key.startsWith('doc.') ? 'Modules' : 'Other'),
      source: t.source,
      actions: visible.filter(e => e.tabKey === t.key && e.kind === 'action').sort(bySort)
        .map(e => ({ key: e.key, label: e.label, ...(e.description ? { description: e.description } : {}) })),
      views: visible.filter(e => e.tabKey === t.key && e.kind === 'view').sort(bySort).map(e => ({ key: e.key, label: e.label })),
      forms: forms.get(t.key) ?? [],
      scoped: isScopedTab(t.key),
    }));
  }

  /**
   * Forms per tab, read directly (read-only) from the forms module's tables: `master.<key>` → the master's form,
   * `admin.users` → the `user` system form. Fields come from the current published version.
   */
  async tabForms(tx: Tx): Promise<Map<string, FormFields[]>> {
    const rows = await tx.selectFrom('app.form_def as f')
      .leftJoin('app.master_def as m', 'm.form_id', 'f.id')
      .leftJoin('app.form_version as v', 'v.id', 'f.current_version_id')
      .select(['f.key as form_key', 'f.name as form_name', 'f.kind', 'm.key as master_key', 'm.plural_name', 'v.definition'])
      .where(eb => eb.or([eb('m.key', 'is not', null), eb.and([eb('f.key', '=', 'user'), eb('f.kind', '=', 'system')])]))
      .execute();
    const out = new Map<string, FormFields[]>();
    for (const r of rows) {
      const tab = r.master_key ? `master.${r.master_key}` : 'admin.users';
      const entry: FormFields = { formKey: r.form_key, label: r.master_key ? (r.plural_name ?? r.form_name) : r.form_name, fields: fieldsOf(r.definition) };
      out.set(tab, [...(out.get(tab) ?? []), entry]);
    }
    // Document types (Phase 3): header form `<key>_header` + line form `<key>_line` on tab `doc.<key>`.
    const docs = await tx.selectFrom('app.doc_type as d')
      .innerJoin('app.form_def as hf', 'hf.id', 'd.header_form_id')
      .leftJoin('app.form_version as hv', 'hv.id', 'hf.current_version_id')
      .leftJoin('app.form_def as lf', 'lf.id', 'd.line_form_id')
      .leftJoin('app.form_version as lv', 'lv.id', 'lf.current_version_id')
      .select(['d.key', 'd.name', 'hf.key as header_key', 'hv.definition as header_def', 'lf.key as line_key', 'lv.definition as line_def'])
      .orderBy('d.key').execute();
    for (const d of docs) {
      const forms: FormFields[] = [{ formKey: d.header_key, label: `${d.name} header`, fields: fieldsOf(d.header_def) }];
      if (d.line_key) forms.push({ formKey: d.line_key, label: `${d.name} lines`, fields: fieldsOf(d.line_def) });
      out.set(`doc.${d.key}`, forms);
    }
    return out;
  }
}

interface DefField { key?: unknown; type?: unknown; label?: unknown; system?: unknown; removed?: unknown; columns?: unknown }
const LAYOUT = new Set(['tab', 'section', 'divider', 'help']);

/** Data fields of a FormDefinition (grid columns as `<grid>.<column>`), skipping layout items and removed fields. */
export function fieldsOf(definition: unknown): FormFields['fields'] {
  const fields = (definition as { fields?: DefField[] } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  const out: FormFields['fields'] = [];
  for (const f of fields) {
    if (typeof f?.key !== 'string' || LAYOUT.has(String(f.type)) || f.removed === true) continue;
    const label = typeof f.label === 'string' ? f.label : f.key;
    out.push({ key: f.key, label, system: f.system === true });
    if (f.type === 'grid' && Array.isArray(f.columns)) {
      for (const c of f.columns as DefField[]) {
        if (typeof c?.key !== 'string' || c.removed === true) continue;
        out.push({ key: `${f.key}.${c.key}`, label: `${label} › ${typeof c.label === 'string' ? c.label : c.key}`, system: c.system === true });
      }
    }
  }
  return out;
}
