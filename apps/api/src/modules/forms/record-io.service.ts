import { Injectable } from '@nestjs/common';
import { DataField, ErrorCode, FormDefinition, ImportReport } from '@procure/schema';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { DbService, Tx } from '../../core/db.service';
import { AppError } from '../../core/errors';
import { dataFields, isEmpty, isFileField, isGrid, isLookup, LookupLike, NUMERIC_TYPES } from './definition';
import { Actor, FormsService, tenantToday } from './forms.service';
import { MasterRow, settingsOf } from './masters.service';
import { kindOfSource, RecordEngine, RefKind } from './record-engine';
import { RecordDbRow, RecordsService, SaveCache } from './records.service';

export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Separator for several values in one cell (multiselect, multilookup). */
export const MULTI_SEP = ';';
const IGNORED_COLUMNS = new Set(['id', 'is_active', 'active', 'status']);

type Cell = string | number | boolean | Date | null;
class Rollback extends Error {
  constructor(readonly report: ImportReport) {
    super('rollback');
  }
}

const bad = (message: string) => new AppError(400, ErrorCode.VALIDATION, message, undefined, [{ path: 'file', message }]);

/** Fields that travel through spreadsheets: flat values only (no grids, files or formulas). */
function importable(def: FormDefinition, access: Record<string, string>): DataField[] {
  return dataFields(def).filter(f => !isGrid(f) && !isFileField(f) && f.type !== 'formula' && !access[f.key]);
}

/**
 * Master import/export (ADR-0007: synchronous, ≤ 5,000 rows / 5 MB, all-or-nothing). Imports go through the very
 * same save pipeline as the API, one savepoint per row, inside one transaction that is rolled back on any error or
 * on a dry run.
 */
@Injectable()
export class RecordIoService {
  constructor(
    private readonly db: DbService,
    private readonly forms: FormsService,
    private readonly records: RecordsService,
    private readonly engine: RecordEngine,
  ) {}

  private async currentDef(tx: Tx, tenantId: string, master: MasterRow) {
    const form = await this.forms.loadById(tx, tenantId, master.form_id);
    return { form, current: await this.forms.current(tx, tenantId, form) };
  }

  // ------------------------------------------------------------------ template
  async template(tx: Tx, actor: Actor, master: MasterRow): Promise<Buffer> {
    const { current } = await this.currentDef(tx, actor.tenantId, master);
    const fields = importable(current.definition, actor.perms?.fieldAccess?.[master.key] ?? {});
    const settings = settingsOf(master);
    const masters = await this.masterNames(tx, actor.tenantId);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(master.plural_name.slice(0, 31) || 'Records');
    ws.addRow(['code', 'name', ...fields.map(f => f.key)]);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach(c => { c.width = 18; });
    const help = wb.addWorksheet('Fields');
    help.addRow(['Column', 'Label', 'Type', 'Required', 'How to fill']);
    help.getRow(1).font = { bold: true };
    help.addRow(['code', settings.codeLabel, 'text', settings.codePattern ? 'no (generated)' : 'yes', settings.codePattern ? `Leave empty to generate (${settings.codePattern})` : 'Unique code']);
    help.addRow(['name', settings.nameLabel, 'text', 'yes', '']);
    for (const f of fields) help.addRow([f.key, f.label, f.type, f.required ? 'yes' : 'no', howTo(f, masters)]);
    help.columns.forEach(c => { c.width = 24; });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async masterNames(tx: Tx, tenantId: string) {
    const rows = await tx.selectFrom('app.master_def').select(['key', 'name']).where('tenant_id', '=', tenantId).execute();
    return new Map(rows.map(r => [r.key, r.name]));
  }

  // ------------------------------------------------------------------ import
  async import(actor: Actor, master: MasterRow, file: { buffer: Buffer; originalname: string }, opts: { dryRun: boolean; mode: 'create' | 'upsert' }): Promise<ImportReport> {
    if (!file?.buffer?.length) throw bad('Choose a .csv or .xlsx file to import.');
    if (file.buffer.length > IMPORT_MAX_BYTES) throw bad('Import files can be at most 5 MB. Split the file and import the parts.');
    const table = await readTable(file.buffer, file.originalname);
    const [header, ...body] = table;
    if (!header) throw bad('The file is empty.');
    const dataRows = body.map((cells, i) => ({ rowNo: i + 2, cells })).filter(r => r.cells.some(c => !isEmpty(c)));
    if (dataRows.length > IMPORT_MAX_ROWS) throw bad(`Imports are limited to ${IMPORT_MAX_ROWS} rows; this file has ${dataRows.length}.`);

    try {
      return await this.db.tenantTx(actor.tenantId, async tx => {
        const { form, current } = await this.currentDef(tx, actor.tenantId, master);
        const def = current.definition;
        const errors: ImportReport['errors'] = [];
        const report = (created: number, updated: number): ImportReport => ({ dryRun: opts.dryRun, totalRows: dataRows.length, created, updated, errors });
        const all = new Map(dataFields(def).map(f => [f.key, f]));
        const byLabel = new Map(dataFields(def).map(f => [f.label.trim().toLowerCase(), f]));
        const access = actor.perms?.fieldAccess?.[master.key] ?? {};

        // map header cells -> 'code' | 'name' | field
        const cols: (DataField | 'code' | 'name' | null)[] = header.map((h, i) => {
          const k = String(h ?? '').trim().toLowerCase();
          if (k === 'code' || k === settingsOf(master).codeLabel.toLowerCase()) return 'code';
          if (k === 'name' || k === settingsOf(master).nameLabel.toLowerCase()) return 'name';
          if (!k || IGNORED_COLUMNS.has(k)) return null;
          const f = all.get(k) ?? byLabel.get(k);
          if (!f) {
            errors.push({ row: 1, field: String(h), message: `Unknown column "${String(h)}" (column ${i + 1}).` });
            return null;
          }
          if (f.type === 'formula') return null; // computed by the server
          if (isGrid(f) || isFileField(f)) {
            errors.push({ row: 1, field: f.key, message: `"${f.label}" cannot be imported from a spreadsheet.` });
            return null;
          }
          return f;
        });
        if (!cols.includes('name')) errors.push({ row: 1, field: 'name', message: 'The file needs a "name" column.' });
        if (errors.length) throw new Rollback(report(0, 0));

        const codeIdx = cols.indexOf('code');
        const nameIdx = cols.indexOf('name');
        const lookupCols = cols.map((c, i) => ({ c, i })).filter((x): x is { c: LookupLike; i: number } => !!x.c && typeof x.c !== 'string' && isLookup(x.c));
        const resolver = await this.lookupResolver(tx, actor.tenantId, lookupCols.map(({ c, i }) => ({
          f: c, values: dataRows.flatMap(r => splitMulti(r.cells[i], c.type === 'multilookup')),
        })));

        // existing records by code (upsert / duplicate detection)
        const codes = codeIdx >= 0 ? dataRows.map(r => cellText(r.cells[codeIdx])).filter(Boolean) : [];
        const existing = new Map<string, RecordDbRow>();
        for (let i = 0; i < codes.length; i += 1000) {
          const chunk = codes.slice(i, i + 1000);
          const rows = await tx.selectFrom('app.master_record').select(['id', 'master_id', 'code', 'name', 'is_active', 'data', 'form_version_id', 'created_at', 'updated_at', 'version'])
            .where('tenant_id', '=', actor.tenantId).where('master_id', '=', master.id).where('is_deleted', '=', false)
            .where(sql<boolean>`code = any(${chunk}::citext[])`).execute();
          for (const r of rows) existing.set(r.code.toLowerCase(), r as RecordDbRow);
        }

        const cache: SaveCache = { form, current, today: await tenantToday(tx) };
        const seenCodes = new Set<string>();
        let created = 0;
        let updated = 0;
        for (const { rowNo, cells } of dataRows) {
          const rowErrors: ImportReport['errors'] = [];
          const code = codeIdx >= 0 ? cellText(cells[codeIdx]) : '';
          const name = cellText(cells[nameIdx]);
          if (code) {
            const k = code.toLowerCase();
            if (seenCodes.has(k)) rowErrors.push({ row: rowNo, field: 'code', message: `"${code}" appears more than once in the file.` });
            seenCodes.add(k);
          }
          const data: Record<string, unknown> = {};
          cols.forEach((c, i) => {
            if (!c || c === 'code' || c === 'name') return;
            const r = convertCell(c, cells[i], resolver, access[c.key] !== undefined);
            if (r.error) rowErrors.push({ row: rowNo, field: c.key, message: r.error });
            else if (r.present) data[c.key] = r.value;
          });
          const prior = code ? existing.get(code.toLowerCase()) : undefined;
          // New records: empty cells are simply absent so field defaults apply.
          if (!prior) for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
          if (prior && opts.mode === 'create') rowErrors.push({ row: rowNo, field: 'code', message: `A record with code "${code}" already exists. Use update mode to change it.` });
          if (rowErrors.length) {
            errors.push(...rowErrors);
            continue;
          }
          await sql`savepoint import_row`.execute(tx);
          try {
            if (prior) {
              const fresh = await this.records.loadRow(tx, actor.tenantId, master, prior.id, true);
              await this.records.save(tx, actor, master, { code, name, data, version: fresh.version }, fresh, cache);
              updated++;
            } else {
              await this.records.save(tx, actor, master, { code: code || undefined, name, data }, null, cache);
              created++;
            }
            await sql`release savepoint import_row`.execute(tx);
          } catch (e) {
            await sql`rollback to savepoint import_row`.execute(tx);
            if (!(e instanceof AppError)) throw e;
            if (e.errors?.length) for (const x of e.errors) errors.push({ row: rowNo, field: x.path, message: x.message });
            else errors.push({ row: rowNo, field: String((e.meta as { field?: string } | undefined)?.field ?? ''), message: e.message });
          }
        }
        const out = report(created, updated);
        if (errors.length || opts.dryRun) throw new Rollback(out);
        return out;
      });
    } catch (e) {
      if (e instanceof Rollback) return e.report;
      throw e;
    }
  }

  /** Lookup cells hold the target's code (users: email); resolved in one query per lookup column. */
  private async lookupResolver(tx: Tx, tenantId: string, cols: { f: LookupLike; values: string[] }[]) {
    const maps = new Map<string, Map<string, string>>(); // fieldKey -> lower(code) -> id
    for (const { f, values } of cols) {
      const wanted = [...new Set(values.map(v => v.toLowerCase()))];
      const m = new Map<string, string>();
      maps.set(f.key, m);
      if (!wanted.length) continue;
      const src = f.source;
      let rows: { id: string; k: string }[] = [];
      if (src.kind === 'master') {
        rows = await tx.selectFrom('app.master_record as r').innerJoin('app.master_def as d', 'd.id', 'r.master_id')
          .select(['r.id', sql<string>`lower(r.code::text)`.as('k')])
          .where('r.tenant_id', '=', tenantId).where('d.key', '=', src.masterKey).where('r.is_deleted', '=', false)
          .where(sql<boolean>`lower(r.code::text) = any(${wanted}::text[])`).execute();
      } else if (src.kind === 'user') {
        rows = await tx.selectFrom('app.tenant_user').select(['id', sql<string>`lower(email::text)`.as('k')])
          .where('tenant_id', '=', tenantId).where('is_deleted', '=', false).where(sql<boolean>`lower(email::text) = any(${wanted}::text[])`).execute();
      } else {
        rows = await tx.selectFrom('app.location_node').select(['id', sql<string>`lower(code::text)`.as('k')])
          .where('tenant_id', '=', tenantId).where(sql<boolean>`lower(code::text) = any(${wanted}::text[])`).execute();
      }
      for (const r of rows) m.set(r.k, r.id);
    }
    return (field: string, code: string) => maps.get(field)?.get(code.toLowerCase());
  }

  // ------------------------------------------------------------------ export
  async export(tx: Tx, actor: Actor, master: MasterRow, format: 'csv' | 'xlsx', view: 'active' | 'inactive' | 'all') {
    const { current } = await this.currentDef(tx, actor.tenantId, master);
    const access = actor.perms?.fieldAccess?.[master.key] ?? {};
    const fields = dataFields(current.definition).filter(f => !isGrid(f) && !isFileField(f) && access[f.key] !== 'hidden');
    let q = tx.selectFrom('app.master_record').select(['id', 'code', 'name', 'is_active', 'data'])
      .where('tenant_id', '=', actor.tenantId).where('master_id', '=', master.id).where('is_deleted', '=', false);
    if (view !== 'all') q = q.where('is_active', '=', view === 'active');
    const rows = await q.orderBy('code').execute();
    const lookupFields = fields.filter(isLookup) as LookupLike[];
    const wanted: { id: string; kind: RefKind }[] = [];
    for (const r of rows) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      for (const f of lookupFields) for (const id of ([] as unknown[]).concat(d[f.key] ?? [])) if (typeof id === 'string') wanted.push({ id, kind: kindOfSource(f) });
    }
    const targets = await this.engine.loadTargets(tx, actor.tenantId, wanted);
    const header = ['code', 'name', ...fields.map(f => f.key), 'is_active'];
    const table: Cell[][] = rows.map(r => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return [r.code, r.name, ...fields.map(f => exportCell(f, d[f.key], id => targets.get(id)?.code ?? id)), r.is_active];
    });
    const base = `${master.key}-${new Date().toISOString().slice(0, 10)}`;
    if (format === 'csv') {
      const text = [header, ...table].map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n';
      return { body: Buffer.from(`\uFEFF${text}`, 'utf8'), mime: 'text/csv; charset=utf-8', filename: `${base}.csv` };
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(master.plural_name.slice(0, 31) || 'Records');
    ws.addRow(header);
    ws.getRow(1).font = { bold: true };
    for (const line of table) ws.addRow(line);
    return {
      body: Buffer.from(await wb.xlsx.writeBuffer()),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${base}.xlsx`,
    };
  }
}

// ------------------------------------------------------------------ spreadsheet helpers

async function readTable(buf: Buffer, filename: string): Promise<Cell[][]> {
  const isXlsx = /\.xlsx$/i.test(filename) || buf.subarray(0, 2).toString('latin1') === 'PK';
  if (isXlsx) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch {
      throw bad('The spreadsheet could not be read. Save it as .xlsx or .csv and try again.');
    }
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const out: Cell[][] = [];
    const width = ws.getRow(1).cellCount;
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const cells: Cell[] = [];
      for (let c = 1; c <= Math.max(width, row.cellCount); c++) cells.push(normalizeExcel(row.getCell(c).value));
      out[n - 1] = cells;
    });
    return Array.from(out, r => r ?? []);
  }
  if (!/\.(csv|txt)$/i.test(filename)) throw bad('Upload a .csv or .xlsx file.');
  try {
    return parseCsv(buf, { bom: true, relax_column_count: true, skip_empty_lines: false, trim: false }) as string[][];
  } catch (e) {
    throw bad(`The CSV file could not be read: ${(e as Error).message}`);
  }
}

function normalizeExcel(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  const o = v as unknown as Record<string, unknown>;
  if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map(t => t.text).join('');
  if ('result' in o) return normalizeExcel(o.result as ExcelJS.CellValue);
  if ('text' in o) return String(o.text);
  if ('error' in o) return null;
  return String(v);
}

function cellText(c: Cell | undefined): string {
  if (c === null || c === undefined) return '';
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  const s = String(c).trim();
  return /^'[=+@-]/.test(s) ? s.slice(1) : s;
}

function splitMulti(c: Cell | undefined, multi: boolean): string[] {
  const s = cellText(c);
  if (!s) return [];
  return multi ? s.split(MULTI_SEP).map(x => x.trim()).filter(Boolean) : [s];
}

const TRUE = new Set(['true', 'yes', 'y', '1']);
const FALSE = new Set(['false', 'no', 'n', '0']);

/** Spreadsheet cell -> API value shape. `present: false` = column left empty (stored as empty). */
function convertCell(f: DataField, c: Cell | undefined, resolve: (field: string, code: string) => string | undefined, locked: boolean): { value?: unknown; present: boolean; error?: string } {
  if (c === null || c === undefined || (typeof c === 'string' && c.trim() === '')) return { present: !locked, value: null };
  if (f.type === 'checkbox' || f.type === 'toggle') {
    if (typeof c === 'boolean') return { present: true, value: c };
    const s = cellText(c).toLowerCase();
    if (TRUE.has(s)) return { present: true, value: true };
    if (FALSE.has(s)) return { present: true, value: false };
    return { present: true, error: `${f.label} must be yes or no.` };
  }
  if (NUMERIC_TYPES.has(f.type)) return { present: true, value: typeof c === 'number' ? numText(c) : cellText(c).replace(/,/g, '') };
  if (f.type === 'date') return { present: true, value: c instanceof Date ? c.toISOString().slice(0, 10) : cellText(c) };
  if (f.type === 'datetime') return { present: true, value: c instanceof Date ? c.toISOString() : cellText(c) };
  if (f.type === 'time' && c instanceof Date) return { present: true, value: c.toISOString().slice(11, 16) };
  if (f.type === 'multiselect') return { present: true, value: splitMulti(c, true) };
  if (f.type === 'daterange') {
    const [from, to] = cellText(c).split(/\s*(?:\.\.|\bto\b)\s*/);
    return { present: true, value: { from, to } };
  }
  if (isLookup(f)) {
    const codes = splitMulti(c, f.type === 'multilookup');
    const ids: string[] = [];
    for (const code of codes) {
      const id = resolve(f.key, code);
      if (!id) return { present: true, error: `${f.label}: no record with code "${code}".` };
      ids.push(id);
    }
    return { present: true, value: f.type === 'multilookup' ? ids : ids[0] };
  }
  return { present: true, value: cellText(c) };
}

/** Plain decimal text from an Excel number (no exponent, float noise trimmed to 10 places). */
function numText(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

function exportCell(f: DataField, v: unknown, codeOf: (id: string) => string): Cell {
  if (v === undefined || v === null) return null;
  if (isLookup(f)) return Array.isArray(v) ? (v as string[]).map(codeOf).join(`${MULTI_SEP} `) : codeOf(String(v));
  if (Array.isArray(v)) return v.map(String).join(`${MULTI_SEP} `);
  if (f.type === 'daterange' && typeof v === 'object') return `${(v as { from: string }).from}..${(v as { to: string }).to}`;
  if (typeof v === 'boolean') return v;
  if (NUMERIC_TYPES.has(f.type) || (f.type === 'formula' && f.resultType === 'number')) {
    const n = Number(v);
    return Number.isFinite(n) && String(n) === String(v) ? n : String(v);
  }
  return String(v);
}

function csvCell(c: Cell): string {
  if (c === null || c === undefined) return '';
  let s = c instanceof Date ? c.toISOString() : String(c);
  // Spreadsheet formula injection guard for text cells (numbers such as -5 stay as they are).
  if (/^[=+@-]/.test(s) && typeof c !== 'number' && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function howTo(f: DataField, masters: Map<string, string>): string {
  if (isLookup(f)) {
    const s = f.source;
    const target = s.kind === 'master' ? `${masters.get(s.masterKey) ?? s.masterKey} code` : s.kind === 'user' ? 'user email' : 'location code';
    return f.type === 'multilookup' ? `${target}s separated by ${MULTI_SEP}` : target;
  }
  if (f.type === 'select' || f.type === 'radio') return `One of: ${f.options.filter(o => !o.inactive).map(o => o.value).join(', ')}`;
  if (f.type === 'multiselect') return `Any of: ${f.options.filter(o => !o.inactive).map(o => o.value).join(', ')} (separated by ${MULTI_SEP})`;
  if (f.type === 'checkbox' || f.type === 'toggle') return 'yes / no';
  if (f.type === 'date') return 'YYYY-MM-DD';
  if (f.type === 'datetime') return 'YYYY-MM-DDTHH:mm+05:30';
  if (f.type === 'time') return 'HH:mm';
  if (f.type === 'daterange') return 'YYYY-MM-DD..YYYY-MM-DD';
  if (NUMERIC_TYPES.has(f.type)) return 'Number';
  return '';
}
