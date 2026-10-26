/**
 * Phase 6 (Notify agent) demo seed — idempotent. Platform `log` providers (email + WhatsApp: nothing real is sent in
 * dev), WhatsApp templates `po_issued` / `approval_pending` allowed for acme, acme limits for demoing quotas, and acme
 * trigger rules: "PO approved → email vendor" (auto for acme), "Stage entered → in-app approval pending" and a manual
 * WhatsApp rule "Send PO to vendor". Starter templates come from the Templates installer when it is available; the
 * few this seed needs are otherwise created minimally (same keys, ON CONFLICT DO NOTHING).
 *
 * Also seeds 4 default in-app notification templates + matching trigger rules so the acme tenant receives in-app
 * alerts for the key procurement lifecycle events: indent submitted, PO created, GRN submitted, vendor selection
 * submitted. Recipients for all four default to the tenant_admin role.
 */
import { NestFactory } from '@nestjs/core';
import { Kysely, Transaction } from 'kysely';
import { AppModule } from '../app.module';
import { DbService } from '../core/db.service';
import type { DB } from '../core/db-types';
import { EntitlementsService } from '../core/entitlements.service';
import { DEFAULT_RULE_NAME, installDefaultRules, STARTER_KEYS } from '../modules/notify';

type Tx = Transaction<DB>;

const WA_TEMPLATES = [
  {
    name: 'po_issued', language: 'en', category: 'utility', header_kind: 'document',
    body: 'Dear {{1}}, please find attached purchase order {{2}} for {{3}}. Kindly confirm receipt.',
    variables: [{ index: 1, label: 'Vendor name' }, { index: 2, label: 'PO number' }, { index: 3, label: 'Amount' }],
  },
  {
    name: 'approval_pending', language: 'en', category: 'utility', header_kind: 'none',
    body: 'A {{1}} ({{2}}) is waiting for your approval.',
    variables: [{ index: 1, label: 'Document type' }, { index: 2, label: 'Number' }],
  },
];

const ACME_OVERRIDES = [
  { kind: 'feature', key: 'email', value: true, reason: 'Phase 6 demo: email' },
  { kind: 'limit', key: 'email_per_month', value: 1000, reason: 'Phase 6 demo: email' },
  { kind: 'limit', key: 'whatsapp_per_month', value: 50, reason: 'Phase 6 demo: WhatsApp limit' },
] as const;

async function platformPart(db: Kysely<DB>, acmeId: string) {
  await db.transaction().execute(async tx => {
    for (const channel of ['email', 'whatsapp'] as const) {
      const has = await tx.selectFrom('platform.provider_credential').select('id').where('tenant_id', 'is', null).where('channel', '=', channel).where('is_active', '=', true).executeTakeFirst();
      if (!has) {
        await tx.insertInto('platform.provider_credential').values({
          tenant_id: null, channel, provider: 'log', config: JSON.stringify(channel === 'email' ? { fromAddress: 'no-reply@procure.local', fromName: 'Procure' } : {}), secret: null,
        }).execute();
      }
    }
    for (const t of WA_TEMPLATES) {
      const row = await tx.insertInto('platform.whatsapp_template').values({ ...t, variables: JSON.stringify(t.variables), meta_status: 'approved', is_active: true })
        .onConflict(oc => oc.columns(['name', 'language']).doUpdateSet({ body: t.body, header_kind: t.header_kind, variables: JSON.stringify(t.variables), meta_status: 'approved', is_active: true }))
        .returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('platform.tenant_whatsapp_template').values({ tenant_id: acmeId, template_id: row.id }).onConflict(oc => oc.doNothing()).execute();
    }
    for (const o of ACME_OVERRIDES) {
      const cur = await tx.selectFrom('platform.tenant_override').select('value').where('tenant_id', '=', acmeId).where('kind', '=', o.kind).where('key', '=', o.key).executeTakeFirst();
      if (cur && JSON.stringify(cur.value) === JSON.stringify(o.value)) continue;
      await tx.insertInto('platform.tenant_override').values({ tenant_id: acmeId, kind: o.kind, key: o.key, value: JSON.stringify(o.value), reason: o.reason })
        .onConflict(oc => oc.columns(['tenant_id', 'kind', 'key']).doUpdateSet({ value: JSON.stringify(o.value), reason: o.reason, set_at: new Date() })).execute();
      await tx.insertInto('platform.tenant_override_history').values({
        tenant_id: acmeId, kind: o.kind, key: o.key, old_value: cur ? JSON.stringify(cur.value) : null, new_value: JSON.stringify(o.value), reason: o.reason,
      }).execute();
    }
  });
}

/** Minimal stand-ins for the starter templates (only when the Templates installer did not create them). */
async function ensureTemplates(tx: Tx, tenantId: string, waTemplateId: string) {
  const ins = (v: { channel: 'pdf' | 'email' | 'whatsapp' | 'inapp'; doc_type_key: string | null; key: string; name: string; subject?: string; body: string; is_default?: boolean; whatsapp_template_id?: string; whatsapp_variables?: unknown[] }) =>
    tx.insertInto('app.message_template').values({
      tenant_id: tenantId, channel: v.channel, doc_type_key: v.doc_type_key, key: v.key, name: v.name, subject: v.subject ?? null, body: v.body,
      whatsapp_template_id: v.whatsapp_template_id ?? null, whatsapp_variables: JSON.stringify(v.whatsapp_variables ?? []), is_default: v.is_default ?? false,
    }).onConflict(oc => oc.columns(['tenant_id', 'channel', 'key']).doNothing()).execute();
  const hasPdf = await tx.selectFrom('app.message_template').select('id').where('channel', '=', 'pdf').where('doc_type_key', '=', 'po').where('is_default', '=', true).executeTakeFirst();
  if (!hasPdf) await ins({ channel: 'pdf', doc_type_key: 'po', key: 'po_standard', name: 'Purchase order', body: '<h1>Purchase order {{document.number}}</h1><p>{{document.party.name}}</p>', is_default: true });
  await ins({
    channel: 'email', doc_type_key: 'po', key: STARTER_KEYS.poEmail, name: 'PO approved → vendor', subject: 'Purchase order {{document.number}}',
    body: '<p>Dear {{document.party.name}},</p><p>Please find attached our purchase order {{document.number}}.</p><p>Regards,<br>{{tenant.name}}</p>',
  });
  await ins({ channel: 'inapp', doc_type_key: null, key: STARTER_KEYS.approvalInapp, name: 'Approval pending', subject: 'Approval pending: {{document.number}}', body: '{{document.number}} is waiting for your approval.' });
  await ins({
    channel: 'whatsapp', doc_type_key: 'po', key: 'po_issued_whatsapp', name: 'PO issued (WhatsApp)', body: 'po_issued', whatsapp_template_id: waTemplateId,
    whatsapp_variables: [{ index: 1, expr: '{{document.party.name}}' }, { index: 2, expr: '{{document.number}}' }, { index: 3, expr: '{{document.totalAmount}}' }],
  });
  // Default in-app notification templates for key procurement lifecycle events.
  await ins({ channel: 'inapp', doc_type_key: 'indent', key: 'indent_submitted_inapp', name: 'Indent submitted', body: 'Indent {{document.number}} has been submitted and is pending approval.' });
  await ins({ channel: 'inapp', doc_type_key: 'po', key: 'po_created_inapp', name: 'PO created', body: 'Purchase Order {{document.number}} has been created from approved indent lines.' });
  await ins({ channel: 'inapp', doc_type_key: 'grn', key: 'grn_submitted_inapp', name: 'GRN submitted', body: 'GRN {{document.number}} has been submitted and is pending approval.' });
  await ins({ channel: 'inapp', doc_type_key: null, key: 'selection_submitted_inapp', name: 'Vendor selection submitted', body: 'Vendor selection {{document.number}} has been submitted for approval.' });
}

export async function seedNotifyDemo(platformDb: Kysely<DB>): Promise<void> {
  const acme = await platformDb.selectFrom('platform.tenant').select('id').where('code', '=', 'acme').executeTakeFirst();
  if (!acme) return;
  await platformPart(platformDb, acme.id);
  const poIssued = await platformDb.selectFrom('platform.whatsapp_template').select('id').where('name', '=', 'po_issued').where('language', '=', 'en').executeTakeFirstOrThrow();

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    // Templates installer (if the Templates module is wired) installs starter templates + our default-rule step.
    let installer: { ensure(tx: Tx, tenantId: string, o?: { features?: string[] }): Promise<void> } | null = null;
    try {
      const mod = await import('../modules/templates');
      installer = app.get(mod.TemplatesInstaller, { strict: false });
    } catch { installer = null; }
    const features = (await app.get(EntitlementsService).state(acme.id))?.features ?? [];
    await db.tenantTx(acme.id, async tx => {
      if (installer) await installer.ensure(tx, acme.id, { features });
      await ensureTemplates(tx, acme.id, poIssued.id);
      await installDefaultRules(tx, acme.id);
      // acme demo: the vendor email goes out automatically.
      await tx.updateTable('app.trigger_rule').set({ mode: 'auto' }).where('name', '=', DEFAULT_RULE_NAME).where('mode', '=', 'manual').execute();
      const t = async (channel: 'inapp' | 'whatsapp', key: string) =>
        (await tx.selectFrom('app.message_template').select('id').where('channel', '=', channel).where('key', '=', key).executeTakeFirstOrThrow()).id;
      const rules = [
        {
          name: 'Stage entered → in-app approval pending', event_type: 'workflow.stage_entered', doc_type_key: null, condition: null, channel: 'inapp' as const,
          template_id: await t('inapp', STARTER_KEYS.approvalInapp), recipients: JSON.stringify([{ type: 'stage_actors', stage: '_current' }]), attach_pdf_template_id: null, mode: 'auto' as const,
        },
        {
          name: 'Send PO to vendor (WhatsApp)', event_type: 'document.status_changed', doc_type_key: 'po', condition: "status_to = 'approved'", channel: 'whatsapp' as const,
          template_id: await t('whatsapp', 'po_issued_whatsapp'), recipients: JSON.stringify([{ type: 'party' }]), attach_pdf_template_id: null, mode: 'manual' as const,
        },
      ];
      for (const r of rules) {
        const exists = await tx.selectFrom('app.trigger_rule').select('id').where('name', '=', r.name).executeTakeFirst();
        if (!exists) await tx.insertInto('app.trigger_rule').values({ ...r, tenant_id: acme.id }).execute();
      }
      // Default in-app rules for key procurement lifecycle events — notify the tenant admin role.
      // The admin role id is resolved at seed time so the recipients column carries a valid role UUID.
      const adminRole = await tx.selectFrom('app.role').select('id').where('key', '=', 'tenant_admin').executeTakeFirstOrThrow();
      const adminRecipients = JSON.stringify([{ type: 'role', roleId: adminRole.id }]);
      const inappRules = [
        { name: 'Indent submitted → in-app', event_type: 'document.submitted', doc_type_key: 'indent' as const, template_id: await t('inapp', 'indent_submitted_inapp') },
        { name: 'PO created → in-app', event_type: 'po.created_from_lines', doc_type_key: null, template_id: await t('inapp', 'po_created_inapp') },
        { name: 'GRN submitted → in-app', event_type: 'document.submitted', doc_type_key: 'grn' as const, template_id: await t('inapp', 'grn_submitted_inapp') },
        { name: 'Vendor selection submitted → in-app', event_type: 'selection.submitted', doc_type_key: null, template_id: await t('inapp', 'selection_submitted_inapp') },
      ];
      for (const r of inappRules) {
        const exists = await tx.selectFrom('app.trigger_rule').select('id').where('name', '=', r.name).executeTakeFirst();
        if (!exists) {
          await tx.insertInto('app.trigger_rule').values({
            tenant_id: acme.id, name: r.name, event_type: r.event_type, doc_type_key: r.doc_type_key, condition: null,
            channel: 'inapp', template_id: r.template_id, recipients: adminRecipients, attach_pdf_template_id: null, mode: 'auto', is_active: true,
          }).execute();
        }
      }
    });
    // Keys send_email / send_whatsapp on existing document types (idempotent label/row upsert by the documents core).
    const { DocTypesService } = await import('../modules/documents');
    const types = app.get(DocTypesService);
    for (const tenant of await platformDb.selectFrom('platform.tenant').select('id').execute()) {
      await db.tenantTx(tenant.id, async tx => {
        const rows = await tx.selectFrom('app.doc_type').select(['id', 'key', 'name', 'plural_name', 'module_key']).execute();
        for (const r of rows) await types.upsertRegistry(tx, tenant.id, r);
      });
      await app.get(EntitlementsService).bumpPermissions(tenant.id);
    }
  } finally {
    await app.close();
  }
}
