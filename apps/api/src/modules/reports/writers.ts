import ExcelJS from 'exceljs';
import { createWriteStream, WriteStream } from 'node:fs';
import { once } from 'node:events';

/**
 * Streaming table writers for background exports. Rows are appended in batches and flushed to a temp file:
 * xlsx through exceljs' WorkbookWriter (rows committed as they are added), csv as UTF-8 with a BOM (Excel-friendly).
 * PDF tables are written by ExportsService's PdfTableWriter (templates module renderer).
 */
export type ExportCell = string | number | boolean | null | Date;

export interface TableWriter {
  header(labels: string[]): Promise<void>;
  rows(rows: ExportCell[][]): Promise<void>;
  close(): Promise<void>;
}

const CSV_INJECTION = /^[=+\-@\t\r]/;

/** CSV cell: quoted when needed; formula-looking text is prefixed with ' (CSV injection guard). */
export function csvCell(v: ExportCell): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (typeof v === 'string' && CSV_INJECTION.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class CsvWriter implements TableWriter {
  private readonly out: WriteStream;
  constructor(path: string) {
    this.out = createWriteStream(path, { encoding: 'utf8' });
    this.out.write('﻿');
  }
  private async write(line: string) {
    if (!this.out.write(line)) await once(this.out, 'drain');
  }
  async header(labels: string[]) { await this.write(`${labels.map(csvCell).join(',')}\r\n`); }
  async rows(rows: ExportCell[][]) {
    if (rows.length) await this.write(rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  }
  async close() {
    this.out.end();
    await once(this.out, 'finish');
  }
}

class XlsxWriter implements TableWriter {
  private readonly wb: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly ws: ExcelJS.Worksheet;
  constructor(path: string, sheet: string) {
    this.wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: true, useSharedStrings: false });
    this.ws = this.wb.addWorksheet(sheet.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  }
  async header(labels: string[]) {
    const row = this.ws.addRow(labels);
    row.font = { bold: true };
    row.commit();
  }
  async rows(rows: ExportCell[][]) {
    for (const r of rows) this.ws.addRow(r).commit();
  }
  async close() {
    this.ws.commit();
    await this.wb.commit();
  }
}

export function openWriter(format: 'xlsx' | 'csv', path: string, sheet: string): TableWriter {
  return format === 'csv' ? new CsvWriter(path) : new XlsxWriter(path, sheet);
}

export const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
} as const;
