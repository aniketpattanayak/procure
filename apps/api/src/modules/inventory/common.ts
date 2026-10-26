import type { MyPermissions } from '@procure/schema';
import Decimal from 'decimal.js';
import { sql } from 'kysely';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { tenantPrincipal } from '../../core/request-context';
import { DocActor, fromUnits, toUnits } from '../documents';

/** Module features (plan feature keys). */
export const GRN_FEATURE = 'grn';
export const STORE_FEATURE = 'store';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const NO_PERMS: MyPermissions = { keys: [], scope: { allNodes: false, nodeIds: [] }, fieldAccess: {}, version: 0 };

/** The calling tenant user as a documents-core actor. */
export function invActor(perms: MyPermissions | undefined): DocActor {
  const p = tenantPrincipal();
  return { tenantId: p.tenantId, userId: p.userId, perms: perms ?? NO_PERMS };
}

export const hasKey = (actor: DocActor, key: string) => actor.perms === null || actor.perms.keys.includes(key);
export function needKey(actor: DocActor, key: string) {
  if (!hasKey(actor, key)) throw AppError.forbidden();
}

/** SQL that merges `patch` into a jsonb column: null values remove the key, others replace it. */
export function jsonPatch(column: 'custom', patch: Record<string, unknown>) {
  const drop = Object.entries(patch).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null && v !== undefined));
  return sql`(${sql.ref(column)} - ${sql.val(drop)}::text[]) || ${JSON.stringify(set)}::jsonb` as never;
}

export const qtyExceeds = (message: string, meta: Record<string, unknown>) => new AppError(409, 'QTY_EXCEEDS_REMAINING', message, meta);

export const units = (v: unknown): bigint => toUnits(v === null || v === undefined ? '0' : String(v));
export const q = (u: bigint): string => fromUnits(u < 0n ? 0n : u);
export const minU = (a: bigint, b: bigint) => (a < b ? a : b);

/** Floor of `pending × (1 + pct / 100)` in ledger units. */
export function withTolerance(pending: bigint, pct: number): bigint {
  if (pending <= 0n) return 0n;
  const v = new Decimal(pending.toString()).mul(new Decimal(100).plus(pct)).div(100).floor();
  return BigInt(v.toFixed(0));
}

/** Locks (creating if missing) line_qty_summary rows in line-id order and returns them by line id. */
export async function lockSummaries(tx: Tx, tenantId: string, lines: { id: string; documentId: string }[]) {
  const uniq = [...new Map(lines.map(l => [l.id, l])).values()];
  if (!uniq.length) return new Map<string, Record<string, unknown>>();
  await tx.insertInto('app.line_qty_summary').values(uniq.map(l => ({ line_id: l.id, tenant_id: tenantId, document_id: l.documentId })))
    .onConflict(oc => oc.column('line_id').doNothing()).execute();
  const rows = await tx.selectFrom('app.line_qty_summary').selectAll().where('tenant_id', '=', tenantId).where('line_id', 'in', uniq.map(l => l.id))
    .orderBy('line_id').forUpdate().execute();
  return new Map(rows.map(r => [r.line_id, r as unknown as Record<string, unknown>]));
}

/** Doc type key of a document. */
export async function docTypeKeyOf(tx: Tx, tenantId: string, documentId: string): Promise<string | null> {
  const r = await tx.selectFrom('app.document as d').innerJoin('app.doc_type as t', 't.id', 'd.doc_type_id').select('t.key')
    .where('d.tenant_id', '=', tenantId).where('d.id', '=', documentId).executeTakeFirst();
  return r?.key ?? null;
}

/** Stage keys in definition order of the workflow version a document's (latest) instance runs on, with the
 *  rank of the first stage that posts stock on approve (onEnter at stage k = posted before k decides → k − 1). */
export async function postingRank(tx: Tx, documentId: string): Promise<{ order: string[]; postRank: number }> {
  const r = await sql<{ definition: unknown }>`
    select v.definition from app.wf_instance i join app.workflow_version v on v.id = i.workflow_version_id
    where i.document_id = ${documentId} order by i.started_at desc, i.id desc limit 1`.execute(tx);
  const def = (r.rows[0]?.definition ?? {}) as { stages?: { key: string; effects?: { onEnter?: { effect: string }[]; onApprove?: { effect: string }[] } }[] };
  const stages = def.stages ?? [];
  let postRank = Number.POSITIVE_INFINITY;
  for (const [i, s] of stages.entries()) {
    if ((s.effects?.onEnter ?? []).some(e => e.effect === 'post_stock')) { postRank = i - 1; break; }
    if ((s.effects?.onApprove ?? []).some(e => e.effect === 'post_stock')) { postRank = i; break; }
  }
  return { order: stages.map(s => s.key), postRank };
}

/** Which decided quantities an effect should use: onReject effects use the rejected qty, onApprove ones the approved. */
export async function effectSide(tx: Tx, documentId: string, stageKey: string | null, effect: string): Promise<'approved' | 'rejected'> {
  if (!stageKey) return 'approved';
  const r = await sql<{ definition: unknown }>`
    select v.definition from app.wf_instance i join app.workflow_version v on v.id = i.workflow_version_id
    where i.document_id = ${documentId} order by i.started_at desc, i.id desc limit 1`.execute(tx);
  const def = (r.rows[0]?.definition ?? {}) as { stages?: { key: string; effects?: { onApprove?: { effect: string }[]; onReject?: { effect: string }[] } }[] };
  const s = (def.stages ?? []).find(x => x.key === stageKey);
  const inReject = (s?.effects?.onReject ?? []).some(e => e.effect === effect);
  const inApprove = (s?.effects?.onApprove ?? []).some(e => e.effect === effect);
  return inReject && !inApprove ? 'rejected' : 'approved';
}
