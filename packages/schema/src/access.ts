import { z } from 'zod';
import { Uuid } from './common';

/** PERMISSIONS, DATA SCOPE, LOCATIONS, SETTINGS, LABELS (Phase 2, frozen). See ADR-0005. */

export const PermKey = z.string().regex(/^[a-z][a-z0-9_.]*(:(action|view)\.[a-z][a-z0-9_]*)?$/, 'Invalid permission key');

/** Helpers so code never hand-builds key strings. */
export const perm = {
  tab: (tab: string) => tab,
  action: (tab: string, action: string) => `${tab}:action.${action}`,
  view: (tab: string, view: string) => `${tab}:view.${view}`,
  /** Master record tabs are generated per master. */
  masterTab: (masterKey: string) => `master.${masterKey}`,
};

export interface RegistryAction { key: string; label: string; description?: string }
export interface RegistryView { key: string; label: string }
/** One tab on the permission screen, already filtered by plan features and flow settings. */
export interface RegistryTab {
  key: string;
  label: string;
  group: string;               // 'Administration' | 'Configuration' | 'Masters' | ...
  source: 'platform' | 'master' | 'form' | 'workflow' | 'report';
  actions: RegistryAction[];
  views: RegistryView[];
  /** Forms on this tab whose fields can be hidden/read-only per role/user (key + label + fields). */
  forms: { formKey: string; label: string; fields: { key: string; label: string; system: boolean }[] }[];
  /** Whether data scope (locations) applies to records on this tab. */
  scoped: boolean;
}

export const ScopeEntry = z.object({
  allNodes: z.boolean().default(true),  // new tenant roles get all-locations access by default
  nodeId: Uuid.nullable().default(null),
  includeDescendants: z.boolean().default(true),
  /** null = applies to every tab. */
  tabKey: z.string().nullable().default(null),
}).refine(v => v.allNodes === (v.nodeId === null), { message: 'Pick a location or "all locations"', path: ['nodeId'] });
export type ScopeEntry = z.infer<typeof ScopeEntry>;

export const FieldAccessEntry = z.object({
  formKey: z.string(),
  fieldKey: z.string(),
  mode: z.enum(['hidden', 'readonly', 'editable']),
});
export type FieldAccessEntry = z.infer<typeof FieldAccessEntry>;

/** PUT /roles/:id/permissions/tabs/:tabKey — replaces this role's grants on one tab. */
export const RoleTabPermissions = z.object({
  actions: z.array(PermKey).default([]),
  views: z.array(PermKey).default([]),
  fieldAccess: z.array(FieldAccessEntry.refine(f => f.mode !== 'editable', { message: 'Roles can only hide or lock fields' })).default([]),
});
/** PUT /users/:id/permissions/tabs/:tabKey — per-user overrides on top of roles. */
export const UserTabPermissions = z.object({
  allow: z.array(PermKey).default([]),
  deny: z.array(PermKey).default([]),
  fieldAccess: z.array(FieldAccessEntry).default([]),
});
/** PUT /roles/:id/scope and /users/:id/scope — replaces all scope rows. */
export const ScopeReplace = z.object({ entries: z.array(ScopeEntry).max(500) });

export interface PermissionSetView {
  /** Keys granted on the subject itself (role grants, or user allow/deny). */
  grants: { key: string; effect: 'allow' | 'deny' }[];
  scope: (ScopeEntry & { id: string; nodeName?: string; nodePath?: string })[];
  fieldAccess: (FieldAccessEntry & { id: string })[];
}

/** Explains each effective key for one user (the admin's "why can she do this?" view). */
export interface EffectivePermissions {
  userId: string;
  isTenantAdmin: boolean;
  keys: { key: string; granted: boolean; sources: string[] /* 'role:<name>' | 'user:allow' | 'user:deny' | 'tenant_admin' */ }[];
  scope: { allNodes: boolean; nodes: { id: string; name: string; includeDescendants: boolean; tabKey: string | null }[] };
  hiddenByPlan: { key: string; label: string }[]; // tabs not shown because the feature is not in the plan or a flow setting is off
}

/** Compact set sent to the browser in /auth/me. */
export interface MyPermissions {
  keys: string[];                    // effective granted keys
  scope: { allNodes: boolean; nodeIds: string[] }; // nodeIds already expanded to include descendants where requested
  fieldAccess: Record<string, Record<string, 'hidden' | 'readonly'>>; // formKey -> fieldKey -> mode
  version: number;                   // bumps whenever any permission input changes for the tenant
}

// ---------------------------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------------------------

export const LocationCreate = z.object({
  parentId: Uuid.nullable().default(null),
  code: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, . _ - only'),
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().default(0),
  custom: z.record(z.string(), z.unknown()).default({}),
});
export const LocationUpdate = LocationCreate.omit({ parentId: true }).partial().extend({ version: z.number().int() });
export const LocationMove = z.object({ parentId: Uuid.nullable(), version: z.number().int() });

export interface LocationNode {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  depth: number;                 // 1 = top level
  levelLabel: string;            // from setting labels.location_levels (deeper levels reuse the last label)
  isActive: boolean;
  sortOrder: number;
  childCount: number;
  /** Ancestors from root, for breadcrumbs. */
  pathNames: string[];
  version: number;
}

// ---------------------------------------------------------------------------------------------
// Settings & labels
// ---------------------------------------------------------------------------------------------

/** PUT /config/settings — partial update; each key validated against SettingsRegistry. */
export const SettingsPatch = z.record(z.string(), z.unknown());
export interface SettingRow { key: string; label: string; value: unknown; default: unknown; isDefault: boolean }

/** Tenant wording overrides for i18n keys (e.g. 'nav.indents' -> 'Requisitions'), per language. */
export const LabelsPatch = z.object({ lang: z.string().min(2).max(10).default('en'), labels: z.record(z.string().max(120), z.string().max(200).nullable()) });
