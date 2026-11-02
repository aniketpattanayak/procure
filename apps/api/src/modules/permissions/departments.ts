import type { MyPermissions } from '@procure/schema';
import { Expression, sql, SqlBool } from 'kysely';
import type { Tx } from '../../core/db.service';

/**
 * Department-wise access (per user). Stored as one tenant_setting row (not in the public settings registry):
 *   key 'access.user_departments', value { [userId]: departmentMasterRecordId[] }
 * A user without an entry sees all departments. A limited user sees a document of a department-scoped type only
 * when its header `department` is in their list, or when they created it. Documents without a department are
 * visible only to users with all departments. Location scope still applies on top.
 */
export const USER_DEPARTMENTS_KEY = 'access.user_departments';
/** Document types whose header `department` field limits visibility. */
export const DEPT_SCOPED_TYPES = new Set(['indent']);

export async function readDepartmentMap(tx: Tx): Promise<Record<string, string[]>> {
  const row = await tx.selectFrom('app.tenant_setting').select('value').where('key', '=', USER_DEPARTMENTS_KEY).executeTakeFirst();
  const v = row?.value as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[k] = ids.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

/** The user's allowed departments, or null = all departments. */
export async function userDepartments(tx: Tx, userId: string): Promise<string[] | null> {
  const m = await readDepartmentMap(tx);
  return Object.prototype.hasOwnProperty.call(m, userId) ? m[userId]! : null;
}

/** Departments carried on resolved permissions (null / absent = all). */
export function departmentsOf(perms: MyPermissions | null | undefined): string[] | null {
  const d = (perms as { departments?: string[] | null } | null | undefined)?.departments;
  return Array.isArray(d) ? d : null;
}

/**
 * SQL condition for a document row: `customCol` is the header jsonb (e.g. 'd.custom'), `createdByCol` its creator.
 * Always true for unlimited users or types that are not department-scoped.
 */
export function departmentCondition(
  perms: MyPermissions | null | undefined, docTypeKey: string | null, userId: string | null | undefined,
  customCol = 'd.custom', createdByCol = 'd.created_by',
): Expression<SqlBool> {
  const depts = departmentsOf(perms);
  if (!depts || (docTypeKey !== null && !DEPT_SCOPED_TYPES.has(docTypeKey))) return sql<SqlBool>`true`;
  const inDept = depts.length ? sql<SqlBool>`(${sql.ref(customCol)}->>'department') = ANY(${sql.val(depts)}::text[])` : sql<SqlBool>`false`;
  return userId ? sql<SqlBool>`(${inDept} OR ${sql.ref(createdByCol)} = ${userId}::uuid)` : inDept;
}

/** Same rule for a loaded document (header values / creator). */
export function departmentAllows(
  perms: MyPermissions | null | undefined, docTypeKey: string, department: unknown, createdBy: string | null | undefined, userId: string | null | undefined,
): boolean {
  const depts = departmentsOf(perms);
  if (!depts || !DEPT_SCOPED_TYPES.has(docTypeKey)) return true;
  if (userId && createdBy && createdBy === userId) return true;
  return typeof department === 'string' && depts.includes(department);
}
