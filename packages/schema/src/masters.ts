import { z } from 'zod';
import { FieldKey, FormDefinition } from './forms';
import { Uuid } from './common';

/** MASTERS, RECORDS, FILES (Phase 2, frozen). */

export const MasterSettings = z.object({
  /** Auto code: '{PREFIX}{SEQ:5}' style; null = user types the code. */
  codePattern: z.string().max(40).nullable().default(null),
  codeLabel: z.string().max(40).default('Code'),
  nameLabel: z.string().max(40).default('Name'),
  /** Fields shown as list columns by default (besides code, name, status). */
  listColumns: z.array(FieldKey).max(12).default([]),
  defaultSort: z.enum(['name', 'code', 'created_at']).default('name'),
  /** Show this master in the sidebar under Masters. */
  showInMenu: z.boolean().default(true),
});
export type MasterSettings = z.infer<typeof MasterSettings>;

/** POST /config/masters — creates master + its form (+ first published version) + registry entries. */
export const MasterCreate = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().trim().min(2).max(60),
  pluralName: z.string().trim().min(2).max(60),
  description: z.string().max(500).optional(),
  settings: MasterSettings.default({}),
  /** Initial fields besides code/name (which every master has). Can be edited later in the form builder. */
  definition: FormDefinition.optional(),
});
export const MasterUpdate = MasterCreate.pick({ name: true, pluralName: true, description: true, settings: true }).partial().extend({ version: z.number().int() });

export interface MasterSummary {
  id: string;
  key: string;
  name: string;
  pluralName: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  formKey: string;
  recordCount: number;
  settings: MasterSettings;
  version: number;
}

/** Record payload: code + name + values for the form's data fields (see FieldValue shapes in forms.ts). */
export const RecordWrite = z.object({
  code: z.string().trim().min(1).max(60).optional(), // optional when the master has codePattern
  name: z.string().trim().min(1).max(200),
  data: z.record(z.string(), z.unknown()).default({}),
});
export const RecordUpdate = RecordWrite.extend({ version: z.number().int() });

export interface RecordRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  data: Record<string, unknown>;
  /** Display text for lookup/multilookup values in `data`, so lists don't need N extra calls: fieldKey -> id -> label. */
  refs: Record<string, Record<string, string>>;
  /** Files referenced in `data`: id -> metadata incl. short-lived signed URL. */
  files: Record<string, FileMeta>;
  formVersionId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** GET /masters/:key/records query. `f.<field>=<value>` filters by exact data value (lookups by id). */
export const RecordListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(200).optional(),
  view: z.enum(['active', 'inactive', 'all']).default('active'),
  sort: z.string().regex(/^-?[a-z_][a-z0-9_]*$/).optional(), // 'name' | '-code' | 'created_at' | data key
});

/** GET /masters/:key/options — lightweight dropdown feed with cascading filters. */
export const OptionsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Repeated: filter=<targetField>:<value>  (value '' means "parent not chosen" -> returns no options). */
  filter: z.union([z.string(), z.array(z.string())]).optional(),
  /** Ensure these ids are included even if inactive (current value of an old record). */
  include: z.union([Uuid, z.array(Uuid)]).optional(),
  /** Attributes to return for autofill: 'code' | 'name' | data keys. */
  attrs: z.union([z.string(), z.array(z.string())]).optional(),
});
export interface OptionRow { id: string; code: string; name: string; label: string; isActive: boolean; attrs?: Record<string, unknown> }

export interface RecordDeleteBlocked { code: 'RECORD_IN_USE'; usedBy: { kind: string; label: string; count: number }[] }

export interface ImportReport {
  dryRun: boolean;
  totalRows: number;
  created: number;
  updated: number;
  /** Row numbers are 1-based spreadsheet rows (header = row 1). Any error = nothing is written. */
  errors: { row: number; field: string; message: string }[];
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export interface FileMeta {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  scanStatus: 'pending' | 'clean' | 'infected' | 'error';
  /** Signed, expiring URL (5 minutes). Null until the scan is clean. */
  url: string | null;
  /** Images only: same URL with ?w=240 thumbnail. */
  thumbUrl: string | null;
}
