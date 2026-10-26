import type { CatalogueField, MyPermissions } from '@procure/schema';
import type { Expression, RawBuilder, SqlBool } from 'kysely';
import type { Tx } from '../../core/db.service';

export type FieldType = CatalogueField['type'];
export type SourceKind = 'doc' | 'doc_line' | 'master' | 'engine';

/**
 * One allow-listed field of a source (ADR-0015). `expr` is a SQL expression written by the source author over the
 * source's own aliases; user input never becomes SQL — definitions can only pick fields by id.
 */
export interface SourceField {
  id: string;
  label: string;
  type: FieldType;
  /** UI grouping, e.g. ['Item', 'Category']. */
  path: string[];
  expr: RawBuilder<unknown>;
  groupable?: boolean;
  filterable?: boolean;
  aggregatable?: boolean;
  /** Id of the referenced record (lookups): eq / in filters with uuid values compare this. */
  idExpr?: RawBuilder<unknown>;
  /** ltree path of a location field: enables the `within_location` operator. */
  locationPath?: RawBuilder<unknown>;
  /** Field-access coordinates: hidden for the viewer → the field does not exist for them. */
  access?: { formKey: string; fieldKey: string }[];
  /** Display labels for coded values (status keys, select options). */
  labels?: Record<string, string>;
  /** Values the viewer may ask for (status views). A filter on any other value is refused (403). */
  allowedValues?: string[];
  /** Lateral joins the expression needs (added to FROM only when the field is used; Postgres memoizes them). */
  joins?: FieldJoin[];
  /**
   * Ratio measure (e.g. on-time %, rejection %): `expr` is the row's own ratio, and the `avg` aggregate becomes the
   * weighted ratio of sums `sum(num) * scale / sum(den)` instead of an average of per-row ratios. `sum` is refused.
   */
  ratio?: { num: RawBuilder<unknown>; den: RawBuilder<unknown>; scale?: number };
}

export interface FieldJoin { alias: string; sql: RawBuilder<unknown> }

/** Who runs a report. `perms: null` = the engine itself (no permission, scope or field-access limits). */
export interface RunActor {
  tenantId: string;
  userId: string | null;
  perms: MyPermissions | null;
}

export interface SourceContext extends RunActor {
  tx: Tx;
  /** Tenant timezone (IANA); sources compute "today" with it. */
  timezone?: string;
  /** Run parameters (sources that take period parameters read them; validated by the source). */
  params?: Record<string, unknown>;
  /**
   * The run's resolved date range (definition preset, `params.datePreset`, or `params.dateFrom`/`dateTo`).
   * A source that sets `consumesDateRange` uses it inside its FROM (e.g. opening / closing balances for a period).
   */
  range?: { from: string; to: string } | null;
}

/** A source made concrete for one tenant (and viewer). */
export interface ResolvedSource {
  source: { kind: SourceKind; key: string };
  label: string;
  /** Permission key needed to read this source (on top of `reports:action.view`); null = none beyond `where`. */
  viewKey: string | null;
  /** `FROM … JOIN …` over the source's aliases. */
  from: RawBuilder<unknown>;
  /** Base conditions (tenant, not deleted, status views …). */
  where: Expression<SqlBool>[];
  /** Data scope: location path column + the tab whose scope applies. */
  scope?: { tabKey: string; path: RawBuilder<unknown> };
  /** Unique row id (detail rows; keyset tiebreak). */
  rowId: RawBuilder<unknown>;
  fields: SourceField[];
  /** Field the definition's date preset applies to. */
  dateField?: string;
  defaultSort?: { field: string; dir: 'asc' | 'desc' }[];
  /** Drill-down target of a detail row (e.g. '/docs/capex/<id>'). */
  link?: RawBuilder<unknown>;
  /** The source applied the run's date range itself (`SourceContext.range`): the compiler adds no date condition. */
  consumesDateRange?: boolean;
}

/**
 * Engine source registered by a module (`registerSource`): Phase 4 `vendor_quote`, `po_followup`; Phase 5
 * `stock_ledger`, `stock_balance`; this module's `workflow_pending`, `audit`, `documents`, `users`.
 */
export interface EngineSourceDef {
  key: string;
  label: string;
  /** Permission key that grants read access (e.g. 'admin.audit:action.view'); null = rows filtered by `build`. */
  viewKey: string | null;
  /** Plan feature the source needs (hidden otherwise). */
  requiresFeature?: string;
  build(ctx: SourceContext): Promise<Omit<ResolvedSource, 'source' | 'label' | 'viewKey'>>;
}
