import type { LucideIcon } from 'lucide-react';
import {
  Building2, ClipboardList, Database, FileStack, FileText, FormInput, Gauge, Hash, Layers, LayoutDashboard, MapPinned, ScrollText, Settings2, ShieldCheck, Table2, Users, Workflow,
} from 'lucide-react';
import { ListChecks, PackagePlus } from 'lucide-react';
import type { MessageKey } from '@/i18n';

export type NavSection = 'main' | 'modules' | 'procurement' | 'stores' | 'masters' | 'config' | 'admin';

export interface NavItem {
  href: string;
  label: MessageKey;
  /** Literal label (dynamic entries such as masters); wins over `label`. */
  text?: string;
  icon: LucideIcon;
  /** Plan feature key required (from /auth/me features). */
  feature?: string;
  /** Permission key required (usually `<tab>:action.view`). */
  perm?: string;
  section?: NavSection;
  /** Settings key (from /auth/me settings) that must not be `false` (flow switches hide disabled steps). */
  setting?: string | string[];
  /** Sort position inside its section (lower first); unset keeps insertion order after ordered entries. */
  order?: number;
}

export const tenantNav: NavItem[] = [
  { href: '/dashboard', label: 'nav.dashboard', icon: LayoutDashboard, section: 'main' },
  // Modules (Phase 3): the approvals inbox, then one entry per document type from GET /doc-types
  // (`doc.<key>:action.view`, added by the tenant layout). Replaces the Phase 1 plan-feature placeholders.
  { href: '/approvals', label: 'nav.approvals', icon: ClipboardList, perm: 'approvals:action.view', section: 'modules' },
  // Configuration (form builder pages are owned by the forms feature).
  { href: '/config/forms', label: 'nav.forms', icon: FormInput, perm: 'config.forms:action.view', section: 'config' },
  { href: '/config/masters', label: 'nav.masterDesigner', icon: Table2, perm: 'config.masters:action.view', section: 'config' },
  // Phase 3 configuration (features/doc-types, numbering, workflows).
  { href: '/config/doc-types', label: 'nav.docTypes', icon: FileStack, perm: 'config.doc_types:action.view', feature: 'form_builder', section: 'config' },
  { href: '/config/numbering', label: 'nav.numbering', icon: Hash, perm: 'config.numbering:action.view', section: 'config' },
  { href: '/config/workflows', label: 'nav.workflows', icon: Workflow, perm: 'config.workflows:action.view', feature: 'workflow_designer', section: 'config' },
  // Administration
  { href: '/users', label: 'nav.users', icon: Users, perm: 'admin.users:action.view', section: 'admin' },
  { href: '/roles', label: 'nav.roles', icon: ShieldCheck, perm: 'admin.roles:action.view', section: 'admin' },
  { href: '/locations', label: 'nav.locations', icon: MapPinned, perm: 'admin.locations:action.view', section: 'admin' },
  { href: '/settings', label: 'nav.settings', icon: Settings2, perm: 'admin.settings:action.view', section: 'admin' },
  { href: '/usage', label: 'nav.usage', icon: Gauge, perm: 'admin.usage:action.view', section: 'admin' },
  { href: '/audit', label: 'nav.auditLog', icon: ScrollText, perm: 'admin.audit:action.view', section: 'admin' },
];

export const masterIcon = Database;
/** Sidebar icon for document types (Modules group). */
export const docTypeIcon = FileText;

export const platformNav: NavItem[] = [
  { href: '/platform/tenants', label: 'nav.tenants', icon: Building2, section: 'main' },
  { href: '/platform/plans', label: 'nav.plans', icon: Layers, section: 'main' },
  { href: '/platform/usage', label: 'nav.platformUsage', icon: Gauge, section: 'main' },
  { href: '/platform/audit', label: 'nav.audit', icon: ScrollText, section: 'main' },
];

export const sectionOrder: NavSection[] = ['main', 'modules', 'procurement', 'stores', 'masters', 'config', 'admin'];

export const sectionLabel: Record<NavSection, MessageKey | null> = {
  main: null,
  modules: 'nav.section.modules',
  procurement: 'nav.section.procurement',
  stores: 'nav.section.stores',
  masters: 'nav.section.masters',
  config: 'nav.section.config',
  admin: 'nav.section.admin',
};

// Phase 4 procurement: the system document types move from Modules into a Procurement group, followed by the
// two working screens. Entries hide when their flow setting is off (`flow.*` in /auth/me settings).
export const procurementDocTypes: Record<string, { order: number; setting?: string[] }> = {
  indent: { order: 0, setting: ['flow.indent.enabled'] },
  vendor_selection: { order: 1, setting: ['flow.vendor_selection.enabled'] },
  po: { order: 2 },
};
export const procurementNav: NavItem[] = [
  { href: '/procurement/select', label: 'nav.procurement.select', icon: ListChecks, perm: 'doc.vendor_selection:action.add', feature: 'vendor_quotes', setting: ['flow.vendor_selection.enabled', 'flow.indent.enabled'], section: 'procurement', order: 10 },
  { href: '/procurement/order', label: 'nav.procurement.order', icon: PackagePlus, perm: 'doc.po:action.add', feature: 'purchase', section: 'procurement', order: 11 },
];

// Phase 7 reports: Reports and Exports sit in the main group after the dashboard (appended, so other entries keep their order).
import { FileBarChart2, FileDown } from 'lucide-react';
export const reportsNav: NavItem[] = [
  { href: '/reports', label: 'nav.reports', icon: FileBarChart2, perm: 'reports:action.view', feature: 'reports', section: 'main' },
  { href: '/exports', label: 'nav.exports', icon: FileDown, section: 'main' },
];
tenantNav.push(...reportsNav);

// Phase 6 notifications: templates, notification rules and webhooks under Configuration; the message log under
// Administration; providers and the WhatsApp catalogue in the platform console (appended, order kept).
import { BellRing, FileCode2, MessageCircle, MessagesSquare, Plug, Webhook } from 'lucide-react';
export const notifyNav: NavItem[] = [
  { href: '/config/templates', label: 'nav.templates', icon: FileCode2, perm: 'config.templates:action.view', section: 'config' },
  { href: '/config/triggers', label: 'nav.triggers', icon: BellRing, perm: 'config.triggers:action.view', section: 'config' },
  { href: '/config/webhooks', label: 'nav.webhooks', icon: Webhook, perm: 'config.webhooks:action.view', feature: 'api_access', section: 'config' },
  { href: '/messages', label: 'nav.messages', icon: MessagesSquare, perm: 'messages:action.view', section: 'admin' },
];
tenantNav.push(...notifyNav);
platformNav.push(
  { href: '/platform/providers', label: 'nav.providers', icon: Plug, section: 'main' },
  { href: '/platform/whatsapp-templates', label: 'nav.waTemplates', icon: MessageCircle, section: 'main' },
);

// Phase 5 stores: GRN / RTV / issue / return / transfer / adjustment / count document types move into a Stores group
// (by doc type key, so a tenant's own doc types stay under Modules), followed by the stock screens. Hidden by plan
// feature (`grn` / `store`) and permission keys from /auth/me; the issue screen also honours `flow.issue.*`.
import { Boxes, PackageCheck as PackageCheckIcon, PackageMinus, PackagePlus as PackagePlusIcon, Repeat, Undo2 } from 'lucide-react';
export const storeDocTypes: Record<string, { order: number; setting?: string[] }> = {
  grn: { order: 20 },
  rtv: { order: 22 },
  issue_request: { order: 30 },
  store_issue: { order: 32 },
  store_return: { order: 34 },
  stock_transfer: { order: 40 },
  stock_adjustment: { order: 41 },
  stock_count: { order: 42 },
};
export const storesNav: NavItem[] = [
  { href: '/stock', label: 'nav.stock', icon: Boxes, perm: 'stock:action.view', feature: 'store', section: 'stores', order: 0 },
  { href: '/stock/receive', label: 'nav.stock.receive', icon: PackageCheckIcon, perm: 'doc.grn:action.add', feature: 'grn', section: 'stores', order: 21 },
  { href: '/stock/rtv', label: 'nav.stock.rtv', icon: Undo2, perm: 'doc.rtv:action.add', feature: 'grn', section: 'stores', order: 23 },
  { href: '/stock/issue', label: 'nav.stock.issue', icon: PackageMinus, perm: 'doc.store_issue:action.add', feature: 'store', section: 'stores', order: 33 },
  { href: '/stock/return', label: 'nav.stock.return', icon: PackagePlusIcon, perm: 'doc.store_return:action.add', feature: 'store', section: 'stores', order: 35 },
  { href: '/stock/reorder', label: 'nav.stock.reorder', icon: Repeat, perm: 'stock:action.view', feature: 'store', section: 'stores', order: 50 },
];
