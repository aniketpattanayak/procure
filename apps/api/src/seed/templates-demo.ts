/**
 * Demo seed — Templates & PDF (Phase 6). Idempotent; called from demo.ts after the other module seeds.
 *   - every tenant: TemplatesInstaller.ensure (starter templates + Notify's registered steps) and the
 *     `doc.<type>:action.print` backfill for doc types created earlier;
 *   - acme: letterhead data (legal name, GSTIN/PAN, address, logo file) when not set yet;
 *   - every role that can view a doc type also gets `…:action.print` (demo convenience).
 */
import { NestFactory } from '@nestjs/core';
import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AppModule } from '../app.module';
import type { DB } from '../core/db-types';
import { DbService } from '../core/db.service';
import { EntitlementsService } from '../core/entitlements.service';
import { decodeImage, FilesService } from '../modules/files';
import { TemplatesInstaller } from '../modules/templates';

const ACME_PROFILE = {
  legal_name: 'Acme Industries Private Limited',
  tax_ids: { gstin: '27AABCA1234F1Z9', pan: 'AABCA1234F' },
  address: { line1: 'Plot 14, MIDC Industrial Area', line2: 'Bhosari', city: 'Pune', postalCode: '411026', state: 'Maharashtra', stateCode: '27', country: 'IN' },
};

async function acmeLogo(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" viewBox="0 0 360 120">
    <rect x="4" y="14" width="92" height="92" rx="18" fill="#12355b"/>
    <path d="M26 88 L50 32 L74 88 Z" fill="#f2a900"/><rect x="38" y="68" width="24" height="7" fill="#12355b"/>
    <text x="112" y="70" font-family="DejaVu Sans" font-size="46" font-weight="bold" fill="#12355b">ACME</text>
    <text x="114" y="96" font-family="DejaVu Sans" font-size="15" letter-spacing="3" fill="#6b7785">INDUSTRIES</text></svg>`;
  return decodeImage(Buffer.from(svg)).png().toBuffer();
}

export async function seedTemplatesDemo(platformDb: Kysely<DB>, tenantCodes: string[]): Promise<void> {
  const tenants = await platformDb.selectFrom('platform.tenant').select(['id', 'code', 'legal_name', 'logo_url', 'tax_ids']).where('code', 'in', tenantCodes).execute();
  if (!tenants.length) return;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get(DbService);
    const files = app.get(FilesService);
    for (const t of tenants) {
      if (t.code === 'acme') {
        let logoUrl = t.logo_url;
        if (!logoUrl) {
          const png = await acmeLogo();
          const key = `${t.id}/branding/${randomUUID()}.png`;
          await files.storage.put(key, png, 'image/png');
          const meta = await decodeImage(png).metadata();
          const f = await db.tenantTx(t.id, tx => tx.insertInto('app.file_object').values({
            storage_key: key, filename: 'acme-logo.png', mime: 'image/png', size_bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'),
            scan_status: 'clean', width: meta.width ?? null, height: meta.height ?? null,
            attached_to: JSON.stringify({ kind: 'tenant', id: t.id, field: 'logo' }),
          }).returning('id').executeTakeFirstOrThrow());
          logoUrl = `http://localhost/api/v1/files/${f.id}/content`;
        }
        const taxIds = (t.tax_ids ?? {}) as Record<string, string>;
        await platformDb.updateTable('platform.tenant').set({
          legal_name: t.legal_name ?? ACME_PROFILE.legal_name, logo_url: logoUrl,
          ...(taxIds.gstin ? {} : { tax_ids: JSON.stringify(ACME_PROFILE.tax_ids), address: JSON.stringify(ACME_PROFILE.address) }),
        }).where('id', '=', t.id).execute();
      }
      await db.tenantTx(t.id, async tx => {
        await app.get(TemplatesInstaller).ensure(tx, t.id);
        // print for roles that can view a doc type (demo convenience; tenants decide in the role editor)
        await sql`
          insert into app.permission_grant (tenant_id, role_id, perm_key, effect)
          select g.tenant_id, g.role_id, replace(g.perm_key, ':action.view', ':action.print'), 'allow'
          from app.permission_grant g
          where g.tenant_id = ${t.id}::uuid and g.role_id is not null and g.perm_key like 'doc.%:action.view' and g.effect = 'allow'
            and exists (select 1 from app.permission_def d where d.tenant_id = g.tenant_id and d.key = replace(g.perm_key, ':action.view', ':action.print'))
            and not exists (select 1 from app.permission_grant x where x.tenant_id = g.tenant_id and x.role_id = g.role_id
                            and x.perm_key = replace(g.perm_key, ':action.view', ':action.print'))`.execute(tx);
      });
      await app.get(EntitlementsService).bumpPermissions(t.id);
    }
  } finally {
    await app.close();
  }
}
