import type { Tx } from '../../core/db.service';

export const DEFAULT_RULE_NAME = 'PO approved → email vendor';
/** Starter template keys (installed by the Templates module at order 100). */
export const STARTER_KEYS = { poEmail: 'po_approved_vendor', approvalInapp: 'approval_pending' } as const;

/**
 * Per-tenant default rule (Templates installer step, order 500, idempotent): when a PO's status changes to approved,
 * email the vendor the PO PDF — `manual` by default for safety (shows as "Email vendor" on the PO). Skipped when the
 * starter email template is missing; never touches a rule the tenant already has (matched by name).
 */
export async function installDefaultRules(tx: Tx, tenantId: string): Promise<{ created: boolean }> {
  const tpl = await tx.selectFrom('app.message_template').select('id')
    .where('tenant_id', '=', tenantId).where('channel', '=', 'email').where('key', '=', STARTER_KEYS.poEmail).executeTakeFirst();
  if (!tpl) return { created: false };
  const exists = await tx.selectFrom('app.trigger_rule').select('id').where('tenant_id', '=', tenantId).where('name', '=', DEFAULT_RULE_NAME).executeTakeFirst();
  if (exists) return { created: false };
  const pdf = await tx.selectFrom('app.message_template').select('id')
    .where('tenant_id', '=', tenantId).where('channel', '=', 'pdf').where('doc_type_key', '=', 'po').where('is_default', '=', true).where('is_active', '=', true).executeTakeFirst();
  await tx.insertInto('app.trigger_rule').values({
    tenant_id: tenantId, name: DEFAULT_RULE_NAME, event_type: 'document.status_changed', doc_type_key: 'po', condition: "status_to = 'approved'",
    channel: 'email', template_id: tpl.id, recipients: JSON.stringify([{ type: 'party' }]), attach_pdf_template_id: pdf?.id ?? null, mode: 'manual', is_active: true,
  }).execute();
  return { created: true };
}
