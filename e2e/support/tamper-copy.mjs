#!/usr/bin/env node
/**
 * Audit tamper check on a COPY of the E2E database (never the live one):
 *   node e2e/support/tamper-copy.mjs <tenantCode> [auditRowId]
 * 1. pg_dump the dev DB (DATABASE_MIGRATOR_URL, default …/procure) into a fresh database procure_qa_tamper;
 * 2. as the owner role, edit one audit row of the tenant in the copy (`after` gets a forged key) — the given id or the
 *    tenant's 10th-newest row;
 * 3. run the real AuditVerifier (from the API build in E2E_STACK_DIR or this repo) against the copy;
 * prints JSON { tamperedId, before: <verify on the untouched copy>, after: <verify after tampering> }.
 */
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stack = process.env.E2E_STACK_DIR ? resolve(process.env.E2E_STACK_DIR) : root;
const [tenantCode = 'acme', given] = process.argv.slice(2);
const src = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure';
const COPY = 'procure_qa_tamper';
const base = src.replace(/\/[^/]+$/, '');
const sh = cmd => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

sh(`psql "${base}/postgres" -qc "drop database if exists ${COPY}" -c "create database ${COPY}"`);
// full dump (owners + grants): the app roles are cluster-wide, so RLS and privileges are identical in the copy
sh(`pg_dump "${src}" | psql -q "${base}/${COPY}" > /dev/null 2>&1`);
const q = s => sh(`psql "${base}/${COPY}" -Atc "${s.replace(/"/g, '\\"')}"`).trim();
const tenantId = q(`select id from platform.tenant where code = '${tenantCode}'`);

const host = base.replace(/^postgres:\/\/[^@]*@/, '');
process.env.DATABASE_URL = `postgres://app_user:app_pass@${host}/${COPY}`;
process.env.DATABASE_PLATFORM_URL = `postgres://platform_user:platform_pass@${host}/${COPY}`;
process.env.DATABASE_MIGRATOR_URL = `${base}/${COPY}`;
process.env.JWT_SECRET ??= 'tamper-check-only-tamper-check-only!!';
process.env.REDIS_URL = process.env.TAMPER_REDIS_URL ?? 'redis://localhost:6391/9';
const req = createRequire(resolve(stack, 'apps/api/package.json'));
const { NestFactory } = req('@nestjs/core');
const { AppModule } = req(resolve(stack, 'apps/api/dist/app.module.js'));
const { AuditVerifier } = req(resolve(stack, 'apps/api/dist/modules/documents/index.js'));
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const v = app.get(AuditVerifier);
  const before = await v.verifyTenant(tenantId);
  const id = given ?? q(`select id from app.audit_log where tenant_id = '${tenantId}' order by id desc offset 9 limit 1`);
  q(`update app.audit_log set after = coalesce(after, '{}'::jsonb) || '{"forged": true}'::jsonb where id = ${id}`);
  const after = await v.verifyTenant(tenantId);
  console.log(JSON.stringify({ tamperedId: String(id), before, after }));
} finally {
  await app.close();
  sh(`psql "${base}/postgres" -qc "drop database if exists ${COPY} with (force)"`);
}
