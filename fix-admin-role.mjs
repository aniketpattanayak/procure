import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const req  = createRequire(join(here, 'node_modules/pg/package.json'));
const { Client } = req('pg');

const RENDER_DB = 'postgresql://procure_user:FntQhW021yL84oHKfNezUiCH0CWz6CMF@dpg-dbg97ue7bikc73feitvg-a.oregon-postgres.render.com/procure_1db9';
const TENANT_ID = '01a17d6a-ce85-7c29-a7d7-719d8dae970a';

const db = new Client({ connectionString: RENDER_DB, ssl: { rejectUnauthorized: false } });
await db.connect();

await db.query('BEGIN');
await db.query(`SET LOCAL "app.tenant_id" = '${TENANT_ID}'`);

// 1. Find admin user
const { rows: users } = await db.query(
  `SELECT id, email FROM app.tenant_user WHERE tenant_id = $1 ORDER BY created_at`,
  [TENANT_ID]
);
console.log('Users:', users.map(u => `${u.email} (${u.id})`).join('\n'));

// 2. Find Manager role
const { rows: roles } = await db.query(
  `SELECT id, name FROM app.role WHERE tenant_id = $1 AND is_deleted = false`,
  [TENANT_ID]
);
console.log('Roles:', roles.map(r => `${r.name} (${r.id})`).join(', '));

// 3. Check current user_role assignments
const { rows: assignments } = await db.query(
  `SELECT u.email, r.name as role_name
   FROM app.user_role ur
   JOIN app.tenant_user u ON u.id = ur.user_id
   JOIN app.role r ON r.id = ur.role_id
   WHERE ur.tenant_id = $1`,
  [TENANT_ID]
);
console.log('\nCurrent role assignments:', assignments.length ? assignments.map(a => `${a.email} → ${a.role_name}`).join(', ') : 'NONE');

// 4. Assign Manager role to all users that have no role yet
const managerRole = roles.find(r => r.name === 'Manager');
for (const user of users) {
  const hasRole = assignments.some(a => a.email === user.email);
  if (!hasRole) {
    await db.query(
      `INSERT INTO app.user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [TENANT_ID, user.id, managerRole.id]
    );
    console.log(`✓ Assigned Manager to ${user.email}`);
  } else {
    console.log(`  ${user.email} already has a role`);
  }
}

// 5. Also check: does admin user have direct permission grants?
// The sidebar uses grants from the user's roles — check if the problem
// is that admin is a special "platform admin" user not in app.tenant_user
const { rows: directGrants } = await db.query(
  `SELECT COUNT(*) as cnt FROM app.permission_grant WHERE tenant_id = $1 AND user_id IS NOT NULL`,
  [TENANT_ID]
);
console.log('\nDirect user grants:', directGrants[0].cnt);

await db.query('COMMIT');
await db.end();
console.log('\nDone — refresh the browser now.');
