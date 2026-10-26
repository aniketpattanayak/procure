#!/usr/bin/env node
// RLS lint (ADR-0002). Fails the build if tenant isolation is not enforced by the database.
//
// Checks, for every table in schema `app` (ordinary + partitioned, including partitions):
//   1. column `tenant_id` of type uuid, NOT NULL
//   2. ROW LEVEL SECURITY enabled AND forced (relrowsecurity + relforcerowsecurity)
//   3. a policy for ALL commands whose USING and WITH CHECK both reference app.current_tenant_id()
//   4. no other PERMISSIVE policy that does not reference app.current_tenant_id() (it would OR-widen access)
// And for role `app_user`:
//   5. exists, is not SUPERUSER, has no BYPASSRLS, and is not a member of a role that has either
//   6. owns no relation in schema `app`
//   7. has no privilege on any relation in schema `platform` (direct, via PUBLIC or via role membership)
//
// Exceptions: db/policies/rls-allowlist.json — a JSON array of "app.table" strings or
// { "table": "app.table", "reason": "..." } objects. Allow-listed tables skip checks 1-4 only.
//
// Usage: node db/policies/rls-lint.mjs      (env DATABASE_MIGRATOR_URL, default postgres://postgres@localhost:5432/procure)
// Exit codes: 0 ok, 1 violations, 2 could not run.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_MIGRATOR_URL ?? 'postgres://postgres@localhost:5432/procure';
const APP_ROLE = process.env.RLS_LINT_APP_ROLE ?? 'app_user';
const TENANT_FN = /\bapp\.current_tenant_id\(\)/;

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(join(here, 'rls-allowlist.json'), 'utf8'));
  if (!Array.isArray(raw)) throw new Error('rls-allowlist.json must be a JSON array');
  return new Set(
    raw.map(e => {
      const t = typeof e === 'string' ? e : e?.table;
      if (typeof t !== 'string' || !/^app\.[a-z_][a-z0-9_]*$/.test(t)) {
        throw new Error(
          `rls-allowlist.json: invalid entry ${JSON.stringify(e)} (expected "app.table" or {"table":"app.table","reason":"..."})`,
        );
      }
      return t;
    }),
  );
}

export async function lint(client, allow = new Set()) {
  const problems = [];
  const add = (subject, msg) => problems.push({ subject, msg });

  // ---- tables in schema app -------------------------------------------------------------
  const { rows: tables } = await client.query(`
    SELECT c.oid, n.nspname || '.' || c.relname AS name, c.relrowsecurity, c.relforcerowsecurity,
           a.attnotnull AS tenant_notnull, format_type(a.atttypid, a.atttypmod) AS tenant_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
    ORDER BY 2`);

  const { rows: policies } = await client.query(`
    SELECT p.polrelid AS oid, p.polname, p.polcmd, p.polpermissive,
           pg_get_expr(p.polqual, p.polrelid) AS using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app'`);
  const byTable = new Map();
  for (const p of policies) {
    if (!byTable.has(p.oid)) byTable.set(p.oid, []);
    byTable.get(p.oid).push(p);
  }

  const usedAllow = new Set();
  for (const t of tables) {
    if (allow.has(t.name)) {
      usedAllow.add(t.name);
      continue;
    }
    if (t.tenant_type == null) add(t.name, 'missing column tenant_id');
    else {
      if (t.tenant_type !== 'uuid') add(t.name, `tenant_id is ${t.tenant_type}, expected uuid`);
      if (!t.tenant_notnull) add(t.name, 'tenant_id is nullable (needs NOT NULL)');
    }
    if (!t.relrowsecurity) add(t.name, 'row level security not ENABLED');
    if (!t.relforcerowsecurity) add(t.name, 'row level security not FORCED');

    const pols = byTable.get(t.oid) ?? [];
    const ok = pols.some(
      p =>
        p.polcmd === '*' && p.polpermissive && TENANT_FN.test(p.using_expr ?? '') && TENANT_FN.test(p.check_expr ?? ''),
    );
    if (!ok) add(t.name, 'no FOR ALL policy whose USING and WITH CHECK reference app.current_tenant_id()');
    for (const p of pols) {
      if (!p.polpermissive) continue;
      const exprs = [p.using_expr, p.check_expr].filter(Boolean);
      if (exprs.some(e => !TENANT_FN.test(e))) {
        add(
          t.name,
          `permissive policy "${p.polname}" has an expression without app.current_tenant_id(): ${exprs.join(' / ')}`,
        );
      }
    }
  }
  for (const a of allow) {
    if (!usedAllow.has(a)) add(a, 'listed in rls-allowlist.json but no such table (remove the stale entry)');
  }

  // ---- role app_user --------------------------------------------------------------------
  const { rows: role } = await client.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [
    APP_ROLE,
  ]);
  if (!role.length) {
    add(`role ${APP_ROLE}`, 'does not exist');
    return problems;
  }
  if (role[0].rolsuper) add(`role ${APP_ROLE}`, 'is SUPERUSER');
  if (role[0].rolbypassrls) add(`role ${APP_ROLE}`, 'has BYPASSRLS');

  const { rows: inherited } = await client.query(
    `SELECT r.rolname, r.rolsuper, r.rolbypassrls FROM pg_roles r
     WHERE r.rolname <> $1 AND pg_has_role($1, r.oid, 'MEMBER') AND (r.rolsuper OR r.rolbypassrls)`,
    [APP_ROLE],
  );
  for (const r of inherited)
    add(`role ${APP_ROLE}`, `is a member of ${r.rolname} which has ${r.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'}`);

  const { rows: owned } = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND pg_has_role($1, c.relowner, 'MEMBER') ORDER BY 1`,
    [APP_ROLE],
  );
  for (const o of owned) add(o.name, `owned by ${APP_ROLE} (or a role it belongs to); table owners can disable RLS`);

  const { rows: platformPrivs } = await client.query(
    `SELECT n.nspname || '.' || c.relname AS name,
            array_remove(ARRAY[
              CASE WHEN has_table_privilege($1, c.oid, 'SELECT') THEN 'SELECT' END,
              CASE WHEN has_table_privilege($1, c.oid, 'INSERT') THEN 'INSERT' END,
              CASE WHEN has_table_privilege($1, c.oid, 'UPDATE') THEN 'UPDATE' END,
              CASE WHEN has_table_privilege($1, c.oid, 'DELETE') THEN 'DELETE' END,
              CASE WHEN has_table_privilege($1, c.oid, 'TRUNCATE') THEN 'TRUNCATE' END,
              CASE WHEN has_table_privilege($1, c.oid, 'REFERENCES') THEN 'REFERENCES' END,
              CASE WHEN has_table_privilege($1, c.oid, 'TRIGGER') THEN 'TRIGGER' END
            ], NULL) AS privs
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'platform' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     ORDER BY 1`,
    [APP_ROLE],
  );
  for (const p of platformPrivs) {
    if (p.privs.length) add(p.name, `${APP_ROLE} has ${p.privs.join(', ')} on a platform relation`);
  }

  return problems;
}

async function main() {
  let allow;
  try {
    allow = loadAllowlist();
  } catch (e) {
    console.error(`rls-lint: ${e.message}`);
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (e) {
    console.error(`rls-lint: cannot connect to ${new URL(url).host}${new URL(url).pathname}: ${e.message}`);
    process.exit(2);
  }
  let problems;
  try {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind IN ('r','p')`,
    );
    problems = await lint(client, allow);
    if (!problems.length) {
      console.log(`rls-lint: OK (${rows[0].n} app tables checked, ${allow.size} allow-listed; role ${APP_ROLE} clean)`);
      return;
    }
  } finally {
    await client.end();
  }
  console.error(`rls-lint: ${problems.length} violation(s)\n`);
  const width = Math.max(...problems.map(p => p.subject.length));
  for (const p of problems) console.error(`  ${p.subject.padEnd(width)}  ${p.msg}`);
  console.error(
    "\nFix: create tenant tables with tenant_id uuid NOT NULL and call SELECT app.enable_tenant_rls('app.<table>');",
  );
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(`rls-lint: ${e.stack ?? e.message}`);
    process.exit(2);
  });
}
