import { Injectable } from '@nestjs/common';
import { ErrorCode, NumberingSeriesInput, NumberingSeriesRow } from '@procure/schema';
import { sql } from 'kysely';
import { z } from 'zod';
import { AuditService } from '../../core/audit.service';
import type { Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { tenantToday } from '../forms';
import { periodOf, renderNumber, ResetPolicy, unknownTokens } from './numbering';
import { TenantCalendar } from './system/tenant-calendar';
import type { DocActor, DocTypeRow } from './types';

interface SeriesRow {
  id: string; doc_type_id: string; name: string; location_node_id: string | null; pattern: string; reset: ResetPolicy; is_active: boolean; version: number;
}
const SERIES_COLS = ['id', 'doc_type_id', 'name', 'location_node_id', 'pattern', 'reset', 'is_active', 'version'] as const;
const bad = (path: string, message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path, message }]);

/**
 * Numbering series (contract "Numbering"): CRUD, preview, resolution by location (nearest ancestor, else the series
 * without a location) and the gap-free counter used inside the submit transaction.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly audit: AuditService, private readonly calendar: TenantCalendar) {}

  private async typeByKey(tx: Tx, tenantId: string, key: string) {
    const t = await tx.selectFrom('app.doc_type').select(['id', 'key']).where('tenant_id', '=', tenantId).where('key', '=', key).executeTakeFirst();
    if (!t) throw bad('docTypeKey', `There is no document type "${key}".`);
    return t;
  }

  private async load(tx: Tx, tenantId: string, id: string, lock = false): Promise<SeriesRow> {
    let q = tx.selectFrom('app.numbering_series').select([...SERIES_COLS]).where('tenant_id', '=', tenantId).where('id', '=', id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw AppError.notFound('Numbering series');
    return r as SeriesRow;
  }

  async list(tx: Tx, tenantId: string, docTypeKey?: string): Promise<NumberingSeriesRow[]> {
    let q = tx.selectFrom('app.numbering_series as s').innerJoin('app.doc_type as t', 't.id', 's.doc_type_id')
      .leftJoin('app.location_node as l', 'l.id', 's.location_node_id')
      .select(SERIES_COLS.map(c => `s.${c}` as const)).select(['t.key as type_key', 'l.name as location_name', 'l.code as location_code'])
      .where('s.tenant_id', '=', tenantId);
    if (docTypeKey) q = q.where('t.key', '=', docTypeKey);
    const rows = await q.orderBy('t.key').orderBy(sql`s.location_node_id is not null`).orderBy('s.name').execute();
    const today = await tenantToday(tx);
    const fy = await this.calendar.fyStartMonth(tenantId);
    const out: NumberingSeriesRow[] = [];
    for (const r of rows) out.push(await this.toRow(tx, tenantId, r as SeriesRow & { type_key: string; location_name: string | null; location_code: string | null }, today, fy));
    return out;
  }

  private async toRow(
    tx: Tx, tenantId: string, r: SeriesRow & { type_key: string; location_name: string | null; location_code: string | null }, today: string, fy: number,
  ): Promise<NumberingSeriesRow> {
    const next = await this.peek(tx, tenantId, r, today, fy);
    return {
      id: r.id, docTypeKey: r.type_key, name: r.name, locationNodeId: r.location_node_id, locationName: r.location_name, pattern: r.pattern,
      reset: r.reset, isActive: r.is_active, version: r.version,
      preview: renderNumber(r.pattern, { prefix: r.type_key, locationCode: r.location_code ?? 'LOC', date: today, fyStartMonth: fy }, next),
    };
  }

  private async rowById(tx: Tx, tenantId: string, id: string): Promise<NumberingSeriesRow> {
    const r = await tx.selectFrom('app.numbering_series as s').innerJoin('app.doc_type as t', 't.id', 's.doc_type_id')
      .leftJoin('app.location_node as l', 'l.id', 's.location_node_id')
      .select(SERIES_COLS.map(c => `s.${c}` as const)).select(['t.key as type_key', 'l.name as location_name', 'l.code as location_code'])
      .where('s.tenant_id', '=', tenantId).where('s.id', '=', id).executeTakeFirst();
    if (!r) throw AppError.notFound('Numbering series');
    return this.toRow(tx, tenantId, r as never, await tenantToday(tx), await this.calendar.fyStartMonth(tenantId));
  }

  /** Next sequence value of a series for a date (not reserved). */
  private async peek(tx: Tx, tenantId: string, s: Pick<SeriesRow, 'id' | 'reset'>, date: string, fy: number): Promise<number> {
    const c = await tx.selectFrom('app.numbering_counter').select('value')
      .where('tenant_id', '=', tenantId).where('series_id', '=', s.id).where('period', '=', periodOf(s.reset, date, fy)).executeTakeFirst();
    return Number(c?.value ?? 0) + 1;
  }

  private validatePattern(pattern: string) {
    const unknown = unknownTokens(pattern);
    if (unknown.length) throw bad('pattern', `Unknown token${unknown.length > 1 ? 's' : ''} ${unknown.map(t => `{${t}}`).join(', ')}. Use {PREFIX} {LOC} {FY} {FYS} {YYYY} {YY} {MM} {SEQ:n}.`);
  }

  private async checkLocation(tx: Tx, tenantId: string, id: string | null) {
    if (!id) return;
    const l = await tx.selectFrom('app.location_node').select('id').where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst();
    if (!l) throw bad('locationNodeId', 'The location does not exist.');
  }

  async create(tx: Tx, actor: DocActor, input: z.infer<typeof NumberingSeriesInput>): Promise<NumberingSeriesRow> {
    const t = await this.typeByKey(tx, actor.tenantId, input.docTypeKey);
    this.validatePattern(input.pattern);
    await this.checkLocation(tx, actor.tenantId, input.locationNodeId);
    if (input.isActive) await this.assertNoActiveClash(tx, actor.tenantId, t.id, input.locationNodeId, null);
    const row = await tx.insertInto('app.numbering_series').values({
      tenant_id: actor.tenantId, doc_type_id: t.id, name: input.name, location_node_id: input.locationNodeId, pattern: input.pattern,
      reset: input.reset, is_active: input.isActive, created_by: actor.userId, updated_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    const out = await this.rowById(tx, actor.tenantId, row.id);
    await this.audit.tenant(tx, { action: 'create', entity: 'numbering_series', entityId: row.id, after: { ...out, preview: undefined }, actorId: actor.userId });
    return out;
  }

  async update(tx: Tx, actor: DocActor, id: string, input: z.infer<typeof NumberingSeriesInput> & { version: number }): Promise<NumberingSeriesRow> {
    const before = await this.load(tx, actor.tenantId, id, true);
    if (before.version !== input.version) throw AppError.versionConflict();
    const t = await this.typeByKey(tx, actor.tenantId, input.docTypeKey);
    if (t.id !== before.doc_type_id) throw bad('docTypeKey', 'A series cannot move to another document type.');
    this.validatePattern(input.pattern);
    await this.checkLocation(tx, actor.tenantId, input.locationNodeId);
    if (input.isActive) await this.assertNoActiveClash(tx, actor.tenantId, t.id, input.locationNodeId, id);
    // Issued numbers are stored on documents; changing the pattern never renumbers them.
    await tx.updateTable('app.numbering_series').set({
      name: input.name, location_node_id: input.locationNodeId, pattern: input.pattern, reset: input.reset, is_active: input.isActive, updated_by: actor.userId,
    }).where('tenant_id', '=', actor.tenantId).where('id', '=', id).execute();
    const out = await this.rowById(tx, actor.tenantId, id);
    await this.audit.tenant(tx, {
      action: 'update', entity: 'numbering_series', entityId: id, actorId: actor.userId,
      before: { name: before.name, pattern: before.pattern, reset: before.reset, locationNodeId: before.location_node_id, isActive: before.is_active },
      after: { name: out.name, pattern: out.pattern, reset: out.reset, locationNodeId: out.locationNodeId, isActive: out.isActive },
    });
    return out;
  }

  private async assertNoActiveClash(tx: Tx, tenantId: string, typeId: string, locationId: string | null, exceptId: string | null) {
    let q = tx.selectFrom('app.numbering_series').select('id').where('tenant_id', '=', tenantId).where('doc_type_id', '=', typeId).where('is_active', '=', true);
    q = locationId ? q.where('location_node_id', '=', locationId) : q.where('location_node_id', 'is', null);
    if (exceptId) q = q.where('id', '<>', exceptId);
    if (await q.executeTakeFirst()) {
      throw new AppError(409, ErrorCode.CONFLICT, 'There is already an active series for this document type and location.', { field: 'locationNodeId' },
        [{ path: 'locationNodeId', message: 'There is already an active series for this document type and location.' }]);
    }
  }

  async preview(tx: Tx, tenantId: string, id: string, q: { locationId?: string; date?: string }): Promise<{ number: string }> {
    const s = await tx.selectFrom('app.numbering_series as s').innerJoin('app.doc_type as t', 't.id', 's.doc_type_id')
      .leftJoin('app.location_node as l', 'l.id', 's.location_node_id')
      .select(['s.id', 's.pattern', 's.reset', 't.key as type_key', 'l.code as location_code'])
      .where('s.tenant_id', '=', tenantId).where('s.id', '=', id).executeTakeFirst();
    if (!s) throw AppError.notFound('Numbering series');
    let code = s.location_code ?? 'LOC';
    if (q.locationId) {
      const l = await tx.selectFrom('app.location_node').select('code').where('tenant_id', '=', tenantId).where('id', '=', q.locationId).executeTakeFirst();
      if (!l) throw bad('locationId', 'The location does not exist.');
      code = l.code;
    }
    const date = q.date ?? await tenantToday(tx);
    const fy = await this.calendar.fyStartMonth(tenantId);
    const next = await this.peek(tx, tenantId, { id: s.id, reset: s.reset as ResetPolicy }, date, fy);
    return { number: renderNumber(s.pattern, { prefix: s.type_key, locationCode: code, date, fyStartMonth: fy }, next) };
  }

  /** Default series created with a document type (no location). */
  async createDefault(tx: Tx, actor: DocActor, type: Pick<DocTypeRow, 'id' | 'name'>, pattern: string) {
    this.validatePattern(pattern);
    const row = await tx.insertInto('app.numbering_series').values({
      tenant_id: actor.tenantId, doc_type_id: type.id, name: `${type.name} (default)`, location_node_id: null, pattern, reset: 'fy',
      created_by: actor.userId, updated_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await this.audit.tenant(tx, { action: 'create', entity: 'numbering_series', entityId: row.id, after: { docTypeId: type.id, pattern, reset: 'fy' }, actorId: actor.userId });
    return row.id;
  }

  /** Most specific active series for a location: the nearest ancestor-or-self with a series, else the one without. */
  async resolve(tx: Tx, tenantId: string, docTypeId: string, locationId: string): Promise<SeriesRow | null> {
    const r = await sql<SeriesRow>`
      select s.id, s.doc_type_id, s.name, s.location_node_id, s.pattern, s.reset, s.is_active, s.version
        from app.numbering_series s
        left join app.location_node sl on sl.id = s.location_node_id and sl.tenant_id = s.tenant_id
       where s.tenant_id = ${tenantId} and s.doc_type_id = ${docTypeId} and s.is_active
         and (s.location_node_id is null
              or (select d.path from app.location_node d where d.tenant_id = ${tenantId} and d.id = ${locationId}) <@ sl.path)
       order by coalesce(nlevel(sl.path), 0) desc
       limit 1`.execute(tx);
    return r.rows[0] ?? null;
  }

  /**
   * Reserves the next number inside the caller's (submit) transaction: insert-on-conflict the counter row, then
   * `UPDATE … RETURNING`. The row lock serialises concurrent submits of one series + period, and a rolled-back submit
   * rolls its increment back too, so numbers are unique and gap-free.
   */
  async next(tx: Tx, tenantId: string, type: Pick<DocTypeRow, 'id' | 'key'>, doc: { locationId: string; date: string }): Promise<{ number: string; seriesId: string }> {
    const s = await this.resolve(tx, tenantId, type.id, doc.locationId);
    if (!s) throw new AppError(409, ErrorCode.CONFLICT, 'No numbering series applies to this location. Ask your administrator to add one.');
    const fy = await this.calendar.fyStartMonth(tenantId);
    const period = periodOf(s.reset, doc.date, fy);
    await tx.insertInto('app.numbering_counter').values({ tenant_id: tenantId, series_id: s.id, period, value: 0 }).onConflict(oc => oc.doNothing()).execute();
    const c = await tx.updateTable('app.numbering_counter').set({ value: sql<string>`value + 1` })
      .where('tenant_id', '=', tenantId).where('series_id', '=', s.id).where('period', '=', period).returning('value').executeTakeFirstOrThrow();
    const loc = await tx.selectFrom('app.location_node').select('code').where('tenant_id', '=', tenantId).where('id', '=', doc.locationId).executeTakeFirstOrThrow();
    return { number: renderNumber(s.pattern, { prefix: type.key, locationCode: loc.code, date: doc.date, fyStartMonth: fy }, BigInt(c.value)), seriesId: s.id };
  }
}
