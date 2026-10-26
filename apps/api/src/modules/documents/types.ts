import { DocTypeSettings, perm } from '@procure/schema';
import type { MyPermissions } from '@procure/schema';
import { AppError } from '../../core/errors';

/** Who is acting. `perms: null` = the engine itself (ports, seed): no permission, scope or field-access limits. */
export interface DocActor {
  tenantId: string;
  userId: string | null;
  perms: MyPermissions | null;
}

export interface DocTypeRow {
  id: string;
  key: string;
  name: string;
  plural_name: string;
  description: string | null;
  kind: 'system' | 'custom';
  module_key: string | null;
  header_form_id: string;
  line_form_id: string | null;
  settings: unknown;
  is_active: boolean;
  version: number;
}
export const DOC_TYPE_COLS = [
  'id', 'key', 'name', 'plural_name', 'description', 'kind', 'module_key', 'header_form_id', 'line_form_id', 'settings', 'is_active', 'version',
] as const;

export const settingsOf = (t: Pick<DocTypeRow, 'settings'>): DocTypeSettings => DocTypeSettings.parse(t.settings ?? {});

export const headerFormKey = (typeKey: string) => `${typeKey}_header`;
export const lineFormKey = (typeKey: string) => `${typeKey}_line`;

// ------------------------------------------------------------------ permission keys (contract "Permission keys")

export const docTab = (typeKey: string) => `doc.${typeKey}`;
export const docAction = (typeKey: string, action: string) => perm.action(docTab(typeKey), action);
export const docView = (typeKey: string, status: string) => perm.view(docTab(typeKey), status);

export const DOC_ACTIONS: { name: string; label: (one: string, many: string) => string }[] = [
  { name: 'view', label: (_o, m) => `View ${m.toLowerCase()}` },
  { name: 'add', label: o => `Create ${o.toLowerCase()}` },
  { name: 'edit', label: o => `Edit ${o.toLowerCase()}` },
  { name: 'delete', label: () => 'Delete drafts' },
  { name: 'submit', label: () => 'Submit' },
  { name: 'cancel', label: () => 'Cancel' },
  { name: 'close', label: () => 'Close' },
  { name: 'copy', label: () => 'Copy' },
  { name: 'comment', label: () => 'Comment' },
  { name: 'attach', label: () => 'Attach files' },
  // ---- Phase 6 (templates agent): print / PDF via POST /docs/:type/:id/print
  { name: 'print', label: () => 'Print / PDF' },
  // ---- Phase 6 (notify agent): manual send from the document (POST /docs/:type/:id/send)
  { name: 'send_email', label: () => 'Send by email' },
  { name: 'send_whatsapp', label: () => 'Send by WhatsApp' },
];
export const DOC_VIEWS: { name: string; label: string }[] = [
  { name: 'draft', label: 'Draft' },
  { name: 'on_hold', label: 'On hold' },
  { name: 'partially_approved', label: 'Partially approved' },
  { name: 'approved', label: 'Approved' },
  { name: 'rejected', label: 'Rejected' },
  { name: 'cancelled', label: 'Cancelled' },
  { name: 'closed', label: 'Closed' },
];

/** Every static registry key of a document type (tab, actions, outcome views). Stage keys come from the workflow. */
export function staticDocKeys(typeKey: string): string[] {
  const tab = docTab(typeKey);
  return [tab, ...DOC_ACTIONS.map(a => perm.action(tab, a.name)), ...DOC_VIEWS.map(v => perm.view(tab, v.name))];
}

export function has(actor: DocActor, key: string): boolean {
  return actor.perms === null || actor.perms.keys.includes(key);
}

export function need(actor: DocActor, key: string) {
  if (!has(actor, key)) throw AppError.forbidden();
}

export const DOCUMENT_ENTITY = 'document';
